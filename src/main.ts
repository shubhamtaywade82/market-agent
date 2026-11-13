/**
 * Runner: Binance public data in, sized paper positions out.
 * Each ACTIVE/CANDIDATE harness gets its own executor, journal, risk desk and playbook,
 * so candidates build a forward (out-of-sample) record beside the active one.
 * No exchange credentials, no real orders. With PX_URL set, orders, stops, fills and fees
 * live on a paper_exchange server and survive a restart of this process.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { decide, type Brief, type PositionSummary } from './agent/decide';
import { SETUPS } from './agent/intent';
import { assertNoCredentials, loadConfig } from './config';
import { PaperExecutor, type Executor, type PosState } from './engine/paper';
import { PxClient } from './exchange/px-client';
import { RemoteExecutor } from './exchange/remote-executor';
import { resolvePlan, sizeByRisk } from './engine/resolver';
import { toR } from './engine/trail';
import { buildContext } from './features/context';
import { parseFrame } from './ingest/parsers';
import { fetchDerivs, fetchKlines, fetchSymbolFilters } from './ingest/rest';
import { buildStreamPlan, RoutedStream, streamUrl } from './ingest/ws-client';
import { FileJournal } from './journal/journal';
import { loadHarnesses, saveHarnesses } from './learn/harness';
import { Playbook } from './learn/playbook';
import { runLearnStep } from './learn/step';
import { RiskDesk } from './risk/desk';
import { MarketState } from './state/market-state';
import { jsonLogger as log, TFS, type Harness, type JournalSink, type MarketContext, type Tf } from './types';

interface Run {
  harness: Harness;
  exec: Executor;
  /** Sizing equity: the exchange account's equity when one is attached, else EQUITY_USD. */
  equity: number;
  px: PxClient | null;
  sink: JournalSink;
  desk: RiskDesk;
  playbook: Playbook;
  inflight: Set<string>;
}

function summarize(st: PosState, mark: number): PositionSummary {
  if (st.s !== 'OPEN') return { state: 'FLAT' };
  return { state: 'OPEN', side: st.pos.side, unrealizedR: toR(st.pos, mark), barsHeld: st.bars, trailMode: st.pos.trailMode };
}

async function main(): Promise<void> {
  assertNoCredentials();
  const cfg = loadConfig();
  if (cfg.equityUsd === null || !(cfg.equityUsd > 0)) throw new Error('EQUITY_USD is required (account equity used for position sizing).');
  const equity = cfg.equityUsd;
  const state = new MarketState(cfg.symbols);
  const filters = await fetchSymbolFilters(cfg.restBase, cfg.symbols, fetch, log);
  log('info', 'symbol_filters', filters);
  for (const s of cfg.symbols) {
    if (!Number.isFinite(cfg.cascadeLiqUsd5m[s]!)) log('warn', 'cascade_threshold_unset', { symbol: s, env: `CASCADE_LIQ_USD_5M_${s}` });
  }

  const killFile = join(cfg.dataDir, 'KILL');
  const killed = () => existsSync(killFile);
  const harnessPath = join(cfg.dataDir, 'harnesses.json');
  const runs = new Map<string, Run>();

  const syncRuns = (harnesses: Harness[]) => {
    for (const h of harnesses) {
      const existing = runs.get(h.id);
      if (existing) {
        existing.harness.status = h.status; // promotion / retirement
        continue;
      }
      if (h.status === 'RETIRED') continue;
      const file = new FileJournal(join(cfg.dataDir, `journal-${h.id}.jsonl`));
      const playbook = new Playbook();
      const past = file.read();
      for (const rec of past.records) playbook.add(rec);
      const desk = new RiskDesk(cfg.desk, { statePath: join(cfg.dataDir, `desk-${h.id}.json`), killed });
      const sink: JournalSink = {
        append(rec) {
          file.append(rec);
          playbook.add(rec);
          desk.onRecord(rec);
          if (rec.kind === 'TRADE') log('info', 'trade_closed', { harness: h.id, symbol: rec.symbol, r: rec.r, pnlUsd: rec.pnlUsd, exit: rec.exitReason, desk: desk.mode(rec.ts) });
        },
      };
      const px = cfg.px ? new PxClient({ url: cfg.px.url, apiKey: cfg.px.apiKey, accountId: `${cfg.px.accountPrefix}-${h.id}` }) : null;
      const exec: Executor = px
        ? new RemoteExecutor(h, px, sink, log, { leverage: cfg.leverage, statePath: join(cfg.dataDir, `exec-${h.id}.json`), pinExitPrice: cfg.px!.feed === 'push', breakevenBufferPct: (cfg.fees.makerBps + cfg.fees.takerBps) / 1e4, maxUnprotectedMs: 10_000 })
        : new PaperExecutor(h, sink, { ...cfg.fees, slippageBps: cfg.slippageBps });
      runs.set(h.id, { harness: h, sink, desk, playbook, inflight: new Set(), exec, equity, px });
      log('info', 'harness_loaded', { id: h.id, status: h.status, journalRecords: past.records.length, corruptLines: past.corrupt });
    }
  };
  const initial = loadHarnesses(harnessPath, Date.now());
  saveHarnesses(harnessPath, initial);
  syncRuns(initial);

  const ctxOf = (symbol: string) =>
    buildContext(state.get(symbol), Date.now(), { staleMarkMs: cfg.stale.markMs, staleBookMs: cfg.stale.bookMs, cascadeLiqUsd5m: cfg.cascadeLiqUsd5m[symbol]! });

  const backfill = async (symbol: string, tf: Tf) => {
    try {
      state.get(symbol).seed(tf, await fetchKlines(cfg.restBase, symbol, tf, 300, Date.now(), fetch, log));
    } catch (err) {
      log('error', 'backfill_failed', { symbol, tf, error: String(err) });
    }
  };
  const backfillAll = async () => {
    for (const s of cfg.symbols) for (const tf of TFS) await backfill(s, tf);
    log('info', 'backfill_done');
  };

  const briefFor = (run: Run, ctx: MarketContext): Brief => {
    const setupTiers: Record<string, string> = {};
    for (const s of SETUPS) if (s !== 'NONE') setupTiers[s] = run.playbook.tier(`${ctx.regime}|${s}`, ctx.ts);
    return { deskMode: run.desk.mode(ctx.ts), setupTiers, similarPast: { long: run.playbook.recall(ctx, 'LONG'), short: run.playbook.recall(ctx, 'SHORT') } };
  };

  const decideFor = async (run: Run, symbol: string): Promise<void> => {
    const st0 = run.exec.state(symbol);
    if (run.inflight.has(symbol) || st0.s === 'ENTRY_PENDING') return;
    if (st0.s === 'IDLE') {
      // Do not spend a model call when the desk would refuse any entry anyway.
      if (run.harness.status === 'RETIRED') return;
      const mode = run.desk.mode(Date.now());
      if (mode === 'HALTED' || mode === 'DAY_STOPPED' || mode === 'COOLDOWN') return;
    }
    run.inflight.add(symbol);
    try {
      const before = ctxOf(symbol);
      const { intent, meta } = await decide(before, summarize(st0, before.mark), cfg.ollama, Date.now, briefFor(run, before));
      // Re-read everything after the model call: prices, position and desk may have moved.
      const ctx = ctxOf(symbol);
      const st = run.exec.state(symbol);
      const intentId = `${run.harness.id}:${symbol}:${ctx.ts}`;
      let accepted = false;
      let rejectReason: string | null = meta.error;

      if (st.s === 'IDLE' && (intent.action === 'ENTER_LONG' || intent.action === 'ENTER_SHORT')) {
        const f = filters[symbol]!;
        const res = resolvePlan(intent, ctx, run.harness, { tickSize: f.tickSize, leverage: cfg.leverage, liqBufferFrac: cfg.liqBufferFrac });
        if (!res.ok) rejectReason = res.reason;
        else {
          const ap = run.desk.approve({ tier: run.playbook.tier(`${ctx.regime}|${intent.setup}`, ctx.ts), exposure: run.exec.exposure(), now: ctx.ts });
          if (!ap.ok) rejectReason = ap.reason;
          else {
            const qty = sizeByRisk({ equity: run.equity, riskPct: cfg.riskPct * ap.riskFrac, entry: res.plan.entry, stop: res.plan.stop, stepSize: f.stepSize, minQty: f.minQty, leverage: cfg.leverage });
            if (qty <= 0) rejectReason = 'SIZE_BELOW_MIN_QTY';
            else {
              const plan = { ...res.plan, riskFrac: ap.riskFrac, qty, intentId };
              // The INTENT record must precede the fill so the playbook can link the outcome to this context.
              run.sink.append({ kind: 'INTENT', ts: ctx.ts, symbol, harnessId: run.harness.id, regime: ctx.regime, setup: intent.setup, action: intent.action, accepted: true, rejectReason: null, llm: meta, ctx, intentId });
              accepted = run.exec.submit(plan, ctx.regime, intent.setup);
              log('info', 'entry_submitted', { harness: run.harness.id, symbol, side: plan.side, entry: plan.entry, stop: plan.stop, qty, riskFrac: ap.riskFrac, setup: intent.setup, regime: ctx.regime, desk: ap.mode });
              return;
            }
          }
        }
      } else if (st.s === 'OPEN' && meta.ok) {
        if (intent.action === 'EXIT') accepted = run.exec.requestExit(symbol, st.pos.side === 'LONG' ? ctx.bid : ctx.ask, ctx.ts);
        else run.exec.setTrailMode(symbol, intent.trail_mode);
      }
      run.sink.append({ kind: 'INTENT', ts: ctx.ts, symbol, harnessId: run.harness.id, regime: ctx.regime, setup: intent.setup, action: intent.action, accepted, rejectReason, llm: meta, ctx, intentId });
      log('info', 'decision', { harness: run.harness.id, symbol, regime: ctx.regime, action: intent.action, setup: intent.setup, accepted, rejectReason, latencyMs: meta.latencyMs });
    } catch (err) {
      log('error', 'decision_failed', { harness: run.harness.id, symbol, error: String(err) });
    } finally {
      run.inflight.delete(symbol);
    }
  };

  const lastRegime = new Map<string, string>();
  let parseFailures = 0;
  const onMessage = (raw: string) => {
    const res = parseFrame(raw);
    if (!res.ok) {
      if (!res.ignored && ++parseFailures % 100 === 1) log('warn', 'parse_failure', { reason: res.reason, total: parseFailures });
      return;
    }
    const ev = res.event;
    if (!state.apply(ev)) return;
    if (ev.type === 'aggTrade') {
      for (const run of runs.values()) run.exec.onTrade(ev.symbol, ev.price, ev.ts);
      return;
    }
    if (ev.type !== 'kline' || !ev.candle.x) return;
    if (ev.tf === '15m') {
      const ctx = ctxOf(ev.symbol);
      for (const run of runs.values()) {
        run.exec.onBarClose(ev.symbol, ctx);
        void decideFor(run, ev.symbol);
      }
      lastRegime.set(ev.symbol, ctx.regime);
    } else if (ev.tf === '1m') {
      // A regime change (a cascade above all) triggers a decision without waiting for the 15m close.
      const regime = ctxOf(ev.symbol).regime;
      const prev = lastRegime.get(ev.symbol);
      lastRegime.set(ev.symbol, regime);
      if (prev !== undefined && prev !== regime) for (const run of runs.values()) void decideFor(run, ev.symbol);
    }
  };

  // Exchange-backed runs: create or read the account, then resume orders and positions from it.
  const syncAccounts = async (first: boolean) => {
    for (const run of runs.values()) {
      if (!run.px) continue;
      try {
        run.equity = await run.px.ensureAccount(equity); // also creates the account of a newly added candidate
        if (first) log('info', 'px_account', { harness: run.harness.id, account: run.px.accountId, equity: run.equity });
      } catch (err) {
        if (first) throw err; // do not trade against an exchange we cannot read
        log('warn', 'px_equity_refresh_failed', { harness: run.harness.id, error: String(err instanceof Error ? err.message : err) });
      }
    }
  };
  await syncAccounts(true);
  for (const run of runs.values()) await run.exec.reconcile?.(Date.now());

  await backfillAll();
  const plan = buildStreamPlan(cfg.symbols);
  const streams = (['market', 'public'] as const).map(
    (route) =>
      new RoutedStream({
        name: route,
        url: streamUrl(cfg.wsBase, route, plan[route]),
        onMessage,
        onOpen: (reconnect) => {
          if (reconnect) void backfillAll(); // repair candles missed while disconnected
        },
        log,
      }),
  );
  for (const s of streams) s.start();

  const pollDerivs = async () => {
    for (const s of cfg.symbols) state.apply(await fetchDerivs(cfg.restBase, s, Date.now(), fetch, log));
  };
  void pollDerivs();

  /** Kill switch: `touch <DATA_DIR>/KILL` cancels resting entries and flattens every position. */
  let killLogged = false;
  const enforceKill = () => {
    if (!killed()) {
      killLogged = false;
      return;
    }
    if (!killLogged) log('error', 'kill_switch_active', { file: killFile });
    killLogged = true;
    const now = Date.now();
    for (const run of runs.values()) {
      for (const symbol of cfg.symbols) {
        run.exec.cancelPending(symbol, now);
        const st = run.exec.state(symbol);
        const s = state.get(symbol);
        if (st.s === 'OPEN') run.exec.requestExit(symbol, st.pos.side === 'LONG' ? s.bid : s.ask, now, 'KILL');
      }
    }
  };

  let learning = false;
  const learn = async () => {
    if (learning) return;
    learning = true;
    try {
      syncRuns(await runLearnStep(cfg, log));
    } catch (err) {
      log('error', 'learn_failed', { error: String(err) });
    } finally {
      learning = false;
    }
  };

  const pushFeed = async () => {
    const px = [...runs.values()].find((r) => r.px)?.px;
    if (!px) return;
    const now = Date.now();
    const quotes = cfg.symbols
      .map((sym) => ({ sym, s: state.get(sym) }))
      .filter(({ s }) => s.bid > 0 && s.ask > 0 && s.mark > 0 && now - s.lastBookTs < cfg.stale.bookMs && now - s.lastMarkTs < cfg.stale.markMs)
      .map(({ sym, s }) => ({ symbol: sym, bid: s.bid, ask: s.ask, mark: s.mark, ts: s.lastBookTs }));
    try {
      await px.pushQuotes(quotes); // stale symbols are withheld: the exchange must not match on old prices
    } catch (err) {
      log('warn', 'px_feed_push_failed', { error: String(err instanceof Error ? err.message : err) });
    }
  };

  const timers = [
    setInterval(() => void pollDerivs(), 60_000),
    setInterval(() => {
      for (const run of runs.values()) void run.exec.reconcile?.(Date.now());
    }, 1_000),
    setInterval(() => void syncAccounts(false), 30_000),
    setInterval(enforceKill, 2_000),
    setInterval(() => {
      for (const g of state.gaps()) void backfill(g.symbol, g.tf);
    }, 15_000),
    setInterval(() => {
      const now = Date.now();
      for (const s of cfg.symbols) {
        const ctx = ctxOf(s);
        log('info', 'heartbeat', { symbol: s, regime: ctx.regime, mark: ctx.mark, stale: ctx.quality.reasons, dropped: state.get(s).dropped });
      }
      for (const run of runs.values()) log('info', 'desk', { harness: run.harness.id, status: run.harness.status, mode: run.desk.mode(now), ...run.desk.state, exposure: run.exec.exposure() });
    }, 60_000),
  ];
  if (cfg.px?.feed === 'push') timers.push(setInterval(() => void pushFeed(), 1_000));
  if (cfg.learnIntervalH > 0) timers.push(setInterval(() => void learn(), cfg.learnIntervalH * 3_600_000));

  const shutdown = () => {
    log('info', 'shutdown');
    for (const t of timers) clearInterval(t);
    for (const s of streams) s.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log('error', 'fatal', { error: String(err) });
  process.exit(1);
});

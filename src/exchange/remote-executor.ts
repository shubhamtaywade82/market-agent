import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Executor, Exposure, PosState } from '../engine/paper';
import { dirOf, nextStop, rDist, toR, type Position } from '../engine/trail';
import type { Harness, JournalSink, Logger, MarketContext, OrderPlan, TrailMode } from '../types';
import { PxError, type PxClient, type PxOrder } from './px-client';

type CloseReason = 'LLM_EXIT' | 'KILL';
interface Slot {
  phase: 'SUBMITTING' | 'WORKING' | 'OPEN' | 'CLOSING';
  plan: OrderPlan;
  regime: string;
  setup: string;
  submittedTs: number;
  barsWaited: number;
  bars: number;
  orderId: number | null;
  positionId: number | null;
  protectionId: number | null;
  pos: Position | null;
  cancel: 'TTL' | 'CANCELLED' | null;
  closeReason: CloseReason | null;
  exitPrice: number | null;
  unprotectedSince: number | null;
  closeLookups: number;
}

export interface RemoteOpts {
  leverage: number;
  statePath: string;
  /** push feed: market exits carry execution_price, as the exchange has no book of its own. */
  pinExitPrice: boolean;
  breakevenBufferPct: number;
  /** Flatten a filled position that could not be given a stop within this long. */
  maxUnprotectedMs: number;
}

const clientId = (prefix: string, intentId: string) => `${prefix}-${intentId}`.replace(/[^A-Za-z0-9._-]/g, '_');

/**
 * Executor backed by a paper_exchange server. The exchange is the source of truth for
 * orders, positions, fills and fees; this class holds only what the exchange does not
 * know (the plan, regime, trail state) and persists it, so a restart resumes where it
 * left off. The stop lives on the exchange as a stop_loss protection and keeps working
 * while this process is down.
 *
 * Every remote action for a symbol runs on one serial queue, and every step is safe to
 * repeat: orders are idempotent by client id, and reconcile() re-derives the next step
 * from exchange state.
 */
export class RemoteExecutor implements Executor {
  private slots = new Map<string, Slot>();
  private readonly queues = new Map<string, Promise<void>>();
  readonly orphans = new Set<string>();

  constructor(
    private readonly harness: Harness,
    private readonly client: PxClient,
    private readonly journal: JournalSink,
    private readonly log: Logger,
    private readonly opts: RemoteOpts,
  ) {
    if (existsSync(opts.statePath)) {
      this.slots = new Map(Object.entries(JSON.parse(readFileSync(opts.statePath, 'utf8')) as Record<string, Slot>));
      if (this.slots.size > 0) log('info', 'executor_state_restored', { harness: harness.id, symbols: [...this.slots.keys()] });
    }
  }

  private save(): void {
    mkdirSync(dirname(this.opts.statePath), { recursive: true });
    const tmp = `${this.opts.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.slots)));
    renameSync(tmp, this.opts.statePath);
  }

  private run(symbol: string, fn: () => Promise<void>): Promise<void> {
    const next = (this.queues.get(symbol) ?? Promise.resolve()).then(fn).catch((err) => {
      this.log(err instanceof PxError && err.status === 0 ? 'warn' : 'error', 'executor_step_failed', { harness: this.harness.id, symbol, error: String(err instanceof Error ? err.message : err) });
    });
    this.queues.set(symbol, next);
    return next;
  }

  /** Resolves when every queued remote step has settled. */
  async idle(): Promise<void> {
    await Promise.all([...this.queues.values()]);
  }

  state(symbol: string): PosState {
    const s = this.slots.get(symbol);
    if (!s) return { s: 'IDLE' };
    if (s.pos && (s.phase === 'OPEN' || s.phase === 'CLOSING')) return { s: 'OPEN', plan: s.plan, regime: s.regime, setup: s.setup, pos: s.pos, bars: s.bars };
    return { s: 'ENTRY_PENDING', plan: s.plan, regime: s.regime, setup: s.setup, barsWaited: s.barsWaited };
  }

  exposure(): Exposure {
    let positions = this.orphans.size;
    let riskUnits = this.orphans.size; // an unknown position is assumed to carry full risk
    for (const s of this.slots.values()) {
      positions += 1;
      if (!s.pos || dirOf(s.pos.side) * (s.pos.stop - s.pos.entry) < 0) riskUnits += s.plan.riskFrac;
    }
    return { positions, riskUnits };
  }

  submit(plan: OrderPlan, regime: string, setup: string): boolean {
    if (this.slots.has(plan.symbol) || this.orphans.has(plan.symbol) || !(plan.qty > 0)) return false;
    const slot: Slot = { phase: 'SUBMITTING', plan, regime, setup, submittedTs: Date.now(), barsWaited: 0, bars: 0, orderId: null, positionId: null, protectionId: null, pos: null, cancel: null, closeReason: null, exitPrice: null, unprotectedSince: null, closeLookups: 0 };
    this.slots.set(plan.symbol, slot);
    this.save();
    void this.run(plan.symbol, () => this.step(plan.symbol, Date.now()));
    return true;
  }

  onTrade(symbol: string, price: number): void {
    const p = this.slots.get(symbol)?.pos;
    if (!p) return;
    const dir = dirOf(p.side);
    if (dir * (price - p.best) > 0) p.best = price;
    if (dir * (price - p.worst) < 0) p.worst = price;
  }

  onBarClose(symbol: string, ctx: MarketContext): void {
    const s = this.slots.get(symbol);
    if (!s) return;
    if (!s.pos) {
      s.barsWaited += 1;
      if (s.barsWaited >= s.plan.ttlBars && !s.cancel) s.cancel = 'TTL';
      this.save();
      return;
    }
    s.bars += 1;
    const v15 = ctx.tf['15m'];
    if (v15 && s.phase === 'OPEN') {
      const target = nextStop(s.pos, { atr15: v15.atr, swingLow15: v15.swingLow, swingHigh15: v15.swingHigh, breakevenBufferPct: this.opts.breakevenBufferPct }, this.harness.params);
      if (target !== s.pos.stop) void this.run(symbol, () => this.moveStop(symbol, target));
    }
    this.save();
  }

  requestExit(symbol: string, price: number, _ts: number, reason: CloseReason = 'LLM_EXIT'): boolean {
    const s = this.slots.get(symbol);
    if (!s || !s.pos || s.phase !== 'OPEN' || !(price > 0)) return false;
    s.phase = 'CLOSING';
    s.closeReason = reason;
    s.exitPrice = price;
    this.save();
    void this.run(symbol, () => this.step(symbol, Date.now()));
    return true;
  }

  setTrailMode(symbol: string, mode: TrailMode): void {
    const p = this.slots.get(symbol)?.pos;
    if (p && p.trailMode !== mode) {
      p.trailMode = mode;
      this.save();
    }
  }

  cancelPending(symbol: string): boolean {
    const s = this.slots.get(symbol);
    if (!s || s.pos || s.cancel === 'CANCELLED') return false;
    s.cancel = 'CANCELLED';
    this.save();
    void this.run(symbol, () => this.step(symbol, Date.now()));
    return true;
  }

  /** Pull exchange state and advance every slot one step. Call on a short timer and at startup. */
  async reconcile(now: number): Promise<void> {
    await Promise.all([...this.slots.keys()].map((sym) => this.run(sym, () => this.step(sym, now))));
    try {
      const held = new Set((await this.client.positions()).map((p) => p.symbol));
      for (const sym of held) {
        if (!this.slots.has(sym) && !this.orphans.has(sym)) {
          this.orphans.add(sym);
          this.log('error', 'orphan_position', { harness: this.harness.id, account: this.client.accountId, symbol: sym, action: 'entries blocked for this symbol until it is closed on the exchange' });
        }
      }
      for (const sym of [...this.orphans]) if (!held.has(sym)) this.orphans.delete(sym);
    } catch (err) {
      this.log('warn', 'orphan_scan_failed', { error: String(err instanceof Error ? err.message : err) });
    }
  }

  private drop(symbol: string): void {
    this.slots.delete(symbol);
    this.save();
  }

  private async step(symbol: string, now: number): Promise<void> {
    const s = this.slots.get(symbol);
    if (!s) return;
    if (s.phase === 'SUBMITTING') return this.place(symbol, s, now);
    if (s.phase === 'WORKING') return this.working(symbol, s, now);
    return this.holding(symbol, s, now);
  }

  private async place(symbol: string, s: Slot, now: number): Promise<void> {
    try {
      const order = await this.client.createOrder({ symbol, side: s.plan.side === 'LONG' ? 'buy' : 'sell', quantity: s.plan.qty, orderType: 'bounded', price: s.plan.entry, leverage: this.opts.leverage, clientOrderId: clientId('entry', s.plan.intentId) });
      s.orderId = order.id;
      s.phase = 'WORKING';
      this.save();
      await this.onOrder(symbol, s, order, now);
    } catch (err) {
      if (!(err instanceof PxError) || !err.refused) throw err; // unreachable: reconcile repeats the idempotent create
      this.log('warn', 'entry_refused', { harness: this.harness.id, symbol, error: err.message });
      this.journal.append({ kind: 'UNFILLED', ts: now, symbol, harnessId: this.harness.id, regime: s.regime, setup: s.setup, reason: 'REJECTED', intentId: s.plan.intentId });
      this.drop(symbol);
    }
  }

  private async working(symbol: string, s: Slot, now: number): Promise<void> {
    let order = await this.client.getOrder(s.orderId!);
    if (s.cancel && (order.status === 'open' || order.status === 'pending')) {
      try {
        order = await this.client.cancelOrder(order.id);
      } catch (err) {
        if (!(err instanceof PxError) || err.status !== 409) throw err;
        order = await this.client.getOrder(order.id); // lost the race to a fill or an expiry
      }
    }
    await this.onOrder(symbol, s, order, now);
  }

  private async onOrder(symbol: string, s: Slot, order: PxOrder, now: number): Promise<void> {
    if (order.status === 'partially_filled') {
      // Keep what filled, drop the rest: one position, one stop, one size.
      try {
        order = await this.client.cancelOrder(order.id);
      } catch (err) {
        if (!(err instanceof PxError) || err.status !== 409) throw err;
      }
    }
    if (order.filledQuantity > 0) return this.onFill(symbol, s, now);
    if (order.status === 'cancelled' || order.status === 'expired' || order.status === 'rejected') {
      this.journal.append({ kind: 'UNFILLED', ts: now, symbol, harnessId: this.harness.id, regime: s.regime, setup: s.setup, reason: order.status === 'rejected' ? 'REJECTED' : s.cancel ?? 'TTL', intentId: s.plan.intentId });
      this.drop(symbol);
    }
  }

  private async onFill(symbol: string, s: Slot, now: number): Promise<void> {
    const want = s.plan.side === 'LONG' ? 'long' : 'short';
    const p = (await this.client.positions()).find((x) => x.symbol === symbol && x.side === want);
    if (!p) return; // position not visible yet; the next reconcile retries
    s.positionId = p.id;
    s.plan = { ...s.plan, qty: p.quantity };
    s.pos = { side: s.plan.side, entry: p.averagePrice, initialStop: s.plan.stop, stop: s.plan.stop, best: p.averagePrice, worst: p.averagePrice, trailMode: s.plan.trailMode, band: s.plan.band };
    s.phase = 'OPEN';
    s.unprotectedSince = now;
    this.save();
    this.log('info', 'entry_filled', { harness: this.harness.id, symbol, entry: p.averagePrice, qty: p.quantity });
    await this.protect(symbol, s, now);
  }

  /** Makes sure exactly one active stop exists at pos.stop. Flattens if that stays impossible. */
  private async protect(symbol: string, s: Slot, now: number): Promise<void> {
    if (!s.pos || s.positionId === null) return;
    try {
      const active = await this.client.activeProtections(s.positionId);
      const ours = active.find((a) => a.id === s.protectionId) ?? active.find((a) => a.triggerPrice === s.pos!.stop);
      if (ours) {
        s.protectionId = ours.id;
      } else {
        s.protectionId = (await this.client.createStop(s.positionId, s.pos.stop, s.plan.qty)).id;
        this.log('info', 'stop_placed', { harness: this.harness.id, symbol, stop: s.pos.stop });
      }
      s.unprotectedSince = null;
      this.save();
    } catch (err) {
      s.unprotectedSince ??= now;
      this.save();
      if (now - s.unprotectedSince >= this.opts.maxUnprotectedMs && s.phase === 'OPEN') {
        this.log('error', 'unprotected_position_flatten', { harness: this.harness.id, symbol, unprotectedMs: now - s.unprotectedSince });
        s.phase = 'CLOSING';
        s.closeReason = 'KILL';
        this.save();
      }
      throw err;
    }
  }

  /** New stop first, old stop cancelled second: the position is never without one. */
  private async moveStop(symbol: string, target: number): Promise<void> {
    const s = this.slots.get(symbol);
    if (!s || !s.pos || s.positionId === null || s.phase !== 'OPEN') return;
    if (dirOf(s.pos.side) * (target - s.pos.stop) <= 0) return; // ratchet only
    const old = s.protectionId;
    const created = await this.client.createStop(s.positionId, target, s.plan.qty);
    s.protectionId = created.id;
    s.pos.stop = target;
    this.save();
    this.log('info', 'stop_moved', { harness: this.harness.id, symbol, stop: target });
    if (old !== null) await this.client.cancelProtection(s.positionId, old).catch((err) => this.log('warn', 'old_stop_cancel_failed', { symbol, error: String(err instanceof Error ? err.message : err) }));
  }

  private async holding(symbol: string, s: Slot, now: number): Promise<void> {
    const p = (await this.client.positions()).find((x) => x.id === s.positionId);
    if (!p) return this.finalize(symbol, s, now);
    if (s.phase === 'CLOSING') {
      const mark = s.exitPrice ?? s.pos!.stop;
      const exit = await this.client.createOrder({ symbol, side: s.pos!.side === 'LONG' ? 'sell' : 'buy', quantity: p.quantity, orderType: 'market', leverage: this.opts.leverage, clientOrderId: clientId('exit', s.plan.intentId), reduceOnly: true, executionPrice: this.opts.pinExitPrice ? mark : undefined });
      if (exit.status === 'rejected' || exit.status === 'cancelled' || exit.status === 'expired') {
        // The stop is still on the exchange, but the requested exit will not happen by itself.
        this.log('error', 'exit_order_dead', { harness: this.harness.id, symbol, orderId: exit.id, status: exit.status, action: 'close the position on the exchange by hand' });
      }
      return;
    }
    await this.protect(symbol, s, now);
  }

  /** The position is gone from the exchange: read its real fills and fees from the ledger and journal the trade. */
  private async finalize(symbol: string, s: Slot, now: number): Promise<void> {
    const pos = s.pos!;
    const fills = (await this.client.fillsSince(s.submittedTs - 1_000)).filter((f) => f.positionId === s.positionId);
    const exits = fills.filter((f) => f.orderId !== s.orderId);
    const exitQty = exits.reduce((a, f) => a + f.quantity, 0);
    s.closeLookups += 1;
    if (exitQty <= 0 && s.closeLookups < 5) return; // ledger row not visible yet
    const exit = exitQty > 0 ? exits.reduce((a, f) => a + f.price * f.quantity, 0) / exitQty : pos.stop;
    if (exitQty <= 0) this.log('error', 'exit_fill_not_found', { harness: this.harness.id, symbol, positionId: s.positionId, assumedExit: exit });
    const charges = fills.reduce((a, f) => a + f.charges, 0);
    const qty = s.plan.qty;
    const pnlUsd = dirOf(pos.side) * (exit - pos.entry) * qty - charges;
    const exitReason = s.closeReason ?? (dirOf(pos.side) * (pos.stop - pos.initialStop) > 0 ? 'TRAIL' : 'STOP');
    if (s.closeReason && s.protectionId !== null) await this.client.cancelProtection(s.positionId!, s.protectionId).catch(() => undefined);
    this.slots.delete(symbol);
    this.save();
    this.journal.append({
      kind: 'TRADE', ts: now, symbol, harnessId: this.harness.id, regime: s.regime, setup: s.setup, side: pos.side, entry: pos.entry, exit, initialStop: pos.initialStop,
      r: pnlUsd / (rDist(pos) * qty), mfeR: toR(pos, pos.best), maeR: -toR(pos, pos.worst), bars: s.bars, exitReason, intentId: s.plan.intentId, riskFrac: s.plan.riskFrac, qty, pnlUsd,
    });
  }
}

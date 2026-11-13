import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { renderUserPrompt } from '../src/agent/decide';
import { PaperExecutor } from '../src/engine/paper';
import { buildContext } from '../src/features/context';
import { fetchSymbolFilters } from '../src/ingest/rest';
import { MemoryJournal } from '../src/journal/journal';
import { featureVec, Playbook } from '../src/learn/playbook';
import { RiskDesk } from '../src/risk/desk';
import type { JournalRecord, MarketContext, OrderPlan } from '../src/types';
import { CTX_OPTS, harness, NOW, seededState } from './helpers';

const LIMITS = loadConfig({}).desk; // 3R day, 5R throttle, 10R halt, 3 losses -> 4h cooldown, 2 positions, 2 risk units
const FLAT = { positions: 0, riskUnits: 0 };
const DAY = 86_400_000;
const KEY = 'TREND_UP_NORMAL|TREND_PULLBACK';
const trade = (r: number, ts: number, over: Partial<Extract<JournalRecord, { kind: 'TRADE' }>> = {}): JournalRecord => ({
  kind: 'TRADE', ts, symbol: 'SOLUSDT', harnessId: 'h0', regime: 'TREND_UP_NORMAL', setup: 'TREND_PULLBACK', side: 'LONG',
  entry: 100, exit: 100 + r, initialStop: 99, r, mfeR: Math.max(r, 0), maeR: Math.max(-r, 0), bars: 5, exitReason: r > 0 ? 'TRAIL' : 'STOP', intentId: `t${ts}`, ...over,
});
const ctx = (): MarketContext => buildContext(seededState(0.05).s, NOW, CTX_OPTS);

describe('risk desk', () => {
  it('sizes by tier and refuses benched buckets', () => {
    const d = new RiskDesk(LIMITS);
    expect(d.approve({ tier: 'PROVEN', exposure: FLAT, now: NOW })).toEqual({ ok: true, riskFrac: 1, mode: 'NORMAL' });
    expect(d.approve({ tier: 'PROBATION', exposure: FLAT, now: NOW })).toMatchObject({ ok: true, riskFrac: 0.5 });
    expect(d.approve({ tier: 'BENCHED', exposure: FLAT, now: NOW })).toMatchObject({ ok: false, reason: 'BUCKET_BENCHED' });
  });
  it('caps concurrent positions and total open risk', () => {
    const d = new RiskDesk(LIMITS);
    expect(d.approve({ tier: 'PROVEN', exposure: { positions: 2, riskUnits: 0 }, now: NOW })).toMatchObject({ ok: false, reason: 'MAX_POSITIONS' });
    expect(d.approve({ tier: 'PROVEN', exposure: { positions: 1, riskUnits: 1.5 }, now: NOW })).toMatchObject({ ok: false, reason: 'OPEN_RISK_CAP' });
    expect(d.approve({ tier: 'PROBATION', exposure: { positions: 1, riskUnits: 1.5 }, now: NOW })).toMatchObject({ ok: true });
  });
  it('cools down after consecutive losses, and a win resets the count', () => {
    const d = new RiskDesk(LIMITS);
    d.onRecord(trade(-0.5, NOW));
    d.onRecord(trade(-0.5, NOW + 1));
    d.onRecord(trade(1, NOW + 2));
    d.onRecord(trade(-0.5, NOW + 3));
    d.onRecord(trade(-0.5, NOW + 4));
    expect(d.mode(NOW + 5)).toBe('NORMAL');
    d.onRecord(trade(-0.5, NOW + 5));
    expect(d.approve({ tier: 'PROVEN', exposure: FLAT, now: NOW + 6 })).toMatchObject({ ok: false, reason: 'DESK_COOLDOWN' });
    expect(d.mode(NOW + 5 + LIMITS.cooldownMs)).toBe('NORMAL');
  });
  it('stops for the UTC day at the daily loss limit and reopens next day', () => {
    const d = new RiskDesk({ ...LIMITS, maxConsecLosses: 99 });
    for (let i = 0; i < 3; i++) d.onRecord(trade(-1, NOW + i));
    expect(d.mode(NOW + 10)).toBe('DAY_STOPPED');
    expect(d.mode(NOW + DAY)).toBe('NORMAL');
  });
  it('accounts in risk units, so half-size losses count half', () => {
    const d = new RiskDesk({ ...LIMITS, maxConsecLosses: 99 });
    for (let i = 0; i < 3; i++) d.onRecord(trade(-1, NOW + i, { riskFrac: 0.5 }));
    expect(d.state.dayR).toBeCloseTo(-1.5, 9);
    expect(d.mode(NOW + 10)).toBe('NORMAL');
  });
  it('halves risk in drawdown, then halts and stays halted across restarts until reset', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'desk-')), 'desk.json');
    const d = new RiskDesk({ ...LIMITS, maxConsecLosses: 99, dailyLossLimitR: 99 }, { statePath: path });
    d.onRecord(trade(4, NOW));
    for (let i = 1; i <= 5; i++) d.onRecord(trade(-1, NOW + i * DAY));
    expect(d.approve({ tier: 'PROVEN', exposure: FLAT, now: NOW + 6 * DAY })).toEqual({ ok: true, riskFrac: 0.5, mode: 'REDUCED' });
    for (let i = 6; i <= 10; i++) d.onRecord(trade(-1, NOW + i * DAY));
    expect(d.mode(NOW + 11 * DAY)).toBe('HALTED');

    const restarted = new RiskDesk({ ...LIMITS, maxConsecLosses: 99, dailyLossLimitR: 99 }, { statePath: path });
    expect(restarted.state.cumR).toBeCloseTo(-6, 9);
    expect(restarted.approve({ tier: 'PROVEN', exposure: FLAT, now: NOW + 30 * DAY })).toMatchObject({ ok: false, reason: 'DESK_HALTED' });
    restarted.resetHalt();
    expect(restarted.mode(NOW + 30 * DAY)).toBe('NORMAL');
  });
  it('honours the kill switch and rejects a corrupt state file', () => {
    let kill = false;
    const d = new RiskDesk(LIMITS, { killed: () => kill });
    expect(d.mode(NOW)).toBe('NORMAL');
    kill = true;
    expect(d.approve({ tier: 'PROVEN', exposure: FLAT, now: NOW })).toMatchObject({ ok: false, reason: 'DESK_HALTED' });
    const path = join(mkdtempSync(join(tmpdir(), 'desk-')), 'desk.json');
    writeFileSync(path, JSON.stringify({ dayKey: 'x', dayR: 'oops' }));
    expect(() => new RiskDesk(LIMITS, { statePath: path })).toThrow(/bad or missing field/);
  });
});

describe('playbook', () => {
  it('starts on probation, proves with evidence, benches on negative edge', () => {
    const p = new Playbook();
    expect(p.tier(KEY, NOW)).toBe('PROBATION');
    for (let i = 0; i < 29; i++) p.add(trade(1, NOW + i));
    expect(p.tier(KEY, NOW + 100)).toBe('PROBATION'); // below minSample
    p.add(trade(1, NOW + 29));
    expect(p.tier(KEY, NOW + 100)).toBe('PROVEN');
    const q = new Playbook();
    for (let i = 0; i < 30; i++) q.add(trade(-1, NOW + i));
    expect(q.tier(KEY, NOW + 100)).toBe('BENCHED');
  });
  it('benches early on a losing streak, long before the sample is significant', () => {
    const p = new Playbook();
    for (let i = 0; i < 7; i++) p.add(trade(-1, NOW + i));
    expect(p.tier(KEY, NOW + 10)).toBe('PROBATION');
    p.add(trade(-1, NOW + 7));
    expect(p.tier(KEY, NOW + 10)).toBe('BENCHED');
  });
  it('paroles a benched bucket for one probe, then benches again if it still loses', () => {
    const p = new Playbook();
    for (let i = 0; i < 8; i++) p.add(trade(-1, NOW + i));
    const later = NOW + 15 * DAY;
    expect(p.tier(KEY, later)).toBe('PROBATION');
    p.add(trade(-1, later));
    expect(p.tier(KEY, later + 1)).toBe('BENCHED');
  });
  it('forgets a decayed edge through the rolling window', () => {
    const p = new Playbook();
    for (let i = 0; i < 60; i++) p.add(trade(1, NOW + i));
    expect(p.tier(KEY, NOW + 100)).toBe('PROVEN');
    for (let i = 0; i < 60; i++) p.add(trade(i % 2 ? 0.9 : -1, NOW + 100 + i));
    expect(p.tier(KEY, NOW + 300)).toBe('PROBATION');
  });
  it('recalls how similar past entries ended, per side', () => {
    const p = new Playbook();
    const c = ctx();
    expect(featureVec(c)).toHaveLength(8);
    expect(p.recall(c, 'LONG')).toBe('NO_HISTORY');
    const enter = (id: string, action: string, r: number) => {
      p.add({ kind: 'INTENT', ts: NOW, symbol: 'SOLUSDT', harnessId: 'h0', regime: c.regime, setup: 'TREND_PULLBACK', action, accepted: true, rejectReason: null, llm: { ok: true, latencyMs: 1, error: null }, ctx: c, intentId: id });
      p.add(trade(r, NOW, { intentId: id }));
    };
    for (let i = 0; i < 3; i++) enter(`L${i}`, 'ENTER_LONG', 2);
    for (let i = 0; i < 3; i++) enter(`S${i}`, 'ENTER_SHORT', -1);
    expect(p.recall(c, 'LONG')).toBe('SIMILAR_MOSTLY_WON');
    expect(p.recall(c, 'SHORT')).toBe('SIMILAR_MOSTLY_LOST');
    const far = { ...c, trendScore: -3, tf: { ...c.tf, '15m': { ...c.tf['15m']!, rangePos: 0, atrPctile: 1 } } };
    expect(p.recall(far, 'LONG')).toBe('NO_HISTORY');
  });
  it('ignores rejected intents and unfilled orders', () => {
    const p = new Playbook();
    const c = ctx();
    p.add({ kind: 'INTENT', ts: NOW, symbol: 'SOLUSDT', harnessId: 'h0', regime: c.regime, setup: 'NONE', action: 'NO_TRADE', accepted: false, rejectReason: null, llm: { ok: true, latencyMs: 1, error: null }, ctx: c, intentId: 'x' });
    p.add({ kind: 'UNFILLED', ts: NOW, symbol: 'SOLUSDT', harnessId: 'h0', regime: c.regime, setup: 'TREND_PULLBACK', reason: 'TTL', intentId: 'x' });
    expect(p.recall(c, 'LONG')).toBe('NO_HISTORY');
  });
});

describe('sized paper positions', () => {
  const plan: OrderPlan = { symbol: 'SOLUSDT', side: 'LONG', entry: 100, stop: 99, stopPct: 0.01, trailMode: 'BREAKEVEN_THEN_ATR', band: 'P3_6', ttlBars: 2, riskFrac: 0.5, qty: 10, intentId: 'i1' };
  const mk = () => {
    const journal = new MemoryJournal();
    return { journal, exec: new PaperExecutor(harness(), journal, { makerBps: 0, takerBps: 0, slippageBps: 0 }) };
  };
  it('reports exposure, and a stop at breakeven frees the risk', () => {
    const { exec } = mk();
    exec.submit(plan, 'R', 'S');
    exec.submit({ ...plan, symbol: 'ETHUSDT', riskFrac: 1 }, 'R', 'S');
    expect(exec.exposure()).toEqual({ positions: 2, riskUnits: 1.5 });
    exec.onTrade('SOLUSDT', 99.9, NOW);
    exec.onTrade('SOLUSDT', 104, NOW);
    exec.onBarClose('SOLUSDT', ctx());
    expect(exec.exposure()).toEqual({ positions: 2, riskUnits: 1 });
  });
  it('carries qty, riskFrac, intentId and USD PnL into the trade record', () => {
    const { exec, journal } = mk();
    exec.submit(plan, 'R', 'S');
    exec.onTrade('SOLUSDT', 99.9, NOW);
    exec.onTrade('SOLUSDT', 99, NOW);
    expect(journal.records[0]).toMatchObject({ kind: 'TRADE', r: -1, riskFrac: 0.5, qty: 10, pnlUsd: -10, intentId: 'i1' });
  });
  it('kill path: cancels resting entries and flattens open positions', () => {
    const { exec, journal } = mk();
    exec.submit(plan, 'R', 'S');
    expect(exec.cancelPending('SOLUSDT', NOW)).toBe(true);
    expect(exec.cancelPending('SOLUSDT', NOW)).toBe(false);
    exec.submit(plan, 'R', 'S');
    exec.onTrade('SOLUSDT', 99.9, NOW);
    expect(exec.requestExit('SOLUSDT', 99.5, NOW, 'KILL')).toBe(true);
    expect(journal.records).toMatchObject([{ kind: 'UNFILLED', reason: 'CANCELLED', intentId: 'i1' }, { kind: 'TRADE', exitReason: 'KILL', r: -0.5 }]);
    expect(exec.exposure()).toEqual({ positions: 0, riskUnits: 0 });
  });
  it('the desk sees post-close exposure when a trade record arrives', () => {
    let seen = -1;
    const exec: PaperExecutor = new PaperExecutor(harness(), { append: () => (seen = exec.exposure().positions) }, { makerBps: 0, takerBps: 0, slippageBps: 0 });
    exec.submit(plan, 'R', 'S');
    exec.onTrade('SOLUSDT', 99.9, NOW);
    exec.onTrade('SOLUSDT', 99, NOW);
    expect(seen).toBe(0);
  });
});

describe('wiring', () => {
  it('reads tick, step and minimum quantity from exchangeInfo and fails loudly when missing', async () => {
    const info = { symbols: [{ symbol: 'SOLUSDT', filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.0100' }, { filterType: 'LOT_SIZE', stepSize: '0.01', minQty: '0.01' }] }, { symbol: 'XRPUSDT', filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.0001' }] }] };
    const fetchFn = (async () => new Response(JSON.stringify(info), { status: 200 })) as typeof fetch;
    expect(await fetchSymbolFilters('http://x', ['SOLUSDT'], fetchFn)).toEqual({ SOLUSDT: { tickSize: 0.01, stepSize: 0.01, minQty: 0.01 } });
    await expect(fetchSymbolFilters('http://x', ['XRPUSDT'], fetchFn)).rejects.toThrow(/missing PRICE_FILTER\/LOT_SIZE/);
  });
  it('puts the brief in the prompt and has no equity default', () => {
    const prompt = JSON.parse(renderUserPrompt(ctx(), { state: 'FLAT' }, { deskMode: 'REDUCED', setupTiers: { TREND_PULLBACK: 'BENCHED' }, similarPast: { long: 'SIMILAR_MOSTLY_LOST', short: 'NO_HISTORY' } }));
    expect(prompt.brief).toEqual({ desk_mode: 'REDUCED', setup_tiers: { TREND_PULLBACK: 'BENCHED' }, similar_past: { long: 'SIMILAR_MOSTLY_LOST', short: 'NO_HISTORY' } });
    expect(loadConfig({}).equityUsd).toBeNull();
    expect(loadConfig({ EQUITY_USD: '2500' }).equityUsd).toBe(2500);
  });
});

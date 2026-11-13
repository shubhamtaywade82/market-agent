import { describe, expect, it } from 'vitest';
import { decide } from '../src/agent/decide';
import { failClosedIntent, INTENT_JSON_SCHEMA, IntentSchema, type Intent } from '../src/agent/intent';
import { PaperExecutor } from '../src/engine/paper';
import { resolvePlan, roundTick, sizeByRisk } from '../src/engine/resolver';
import { nextStop, type Position } from '../src/engine/trail';
import { buildContext } from '../src/features/context';
import { MemoryJournal } from '../src/journal/journal';
import { DEFAULT_PARAMS } from '../src/config';
import type { MarketContext, OrderPlan } from '../src/types';
import { CTX_OPTS, harness, NOW, seededState } from './helpers';

const OPTS = { tickSize: 0.01, leverage: 5, liqBufferFrac: 0.5 };
const intent = (over: Partial<Intent> = {}): Intent => ({
  action: 'ENTER_LONG',
  setup: 'TREND_PULLBACK',
  entry_ref: 'BEST_BID_ASK',
  entry_offset_atr: 0,
  invalidation_ref: 'ATR_15M',
  invalidation_atr_mult: 1,
  trail_mode: 'BREAKEVEN_THEN_ATR',
  target_band: 'P1_3',
  confidence: 'MEDIUM',
  reason_codes: ['HTF_TREND_ALIGNED'],
  ...over,
});
const upCtx = (): MarketContext => buildContext(seededState(0.05).s, NOW, CTX_OPTS);
const ollama = (fetchFn: typeof fetch) => ({ host: 'http://o', model: 'm', think: undefined, temperature: 0, timeoutMs: 50, fetchFn });
const reply = (content: unknown) => (async () => new Response(JSON.stringify({ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }), { status: 200 })) as typeof fetch;

describe('intent schema', () => {
  it('JSON schema and zod schema agree on keys and enums', () => {
    expect(Object.keys(INTENT_JSON_SCHEMA.properties).sort()).toEqual(Object.keys(IntentSchema.shape).sort());
    expect([...INTENT_JSON_SCHEMA.required].sort()).toEqual(Object.keys(IntentSchema.shape).sort());
    expect(IntentSchema.safeParse(intent()).success).toBe(true);
    expect(IntentSchema.safeParse({ ...intent(), price: 123 }).success).toBe(false); // prices are not expressible
    expect(IntentSchema.safeParse(failClosedIntent(false)).success).toBe(true);
  });
});

describe('decide (fail-closed)', () => {
  it('returns the model intent when valid and legal', async () => {
    const r = await decide(upCtx(), { state: 'FLAT' }, ollama(reply(intent())));
    expect(r.meta.ok).toBe(true);
    expect(r.intent.action).toBe('ENTER_LONG');
  });
  it('does not call the model on stale context', async () => {
    let called = false;
    const ctx = { ...upCtx(), quality: { stale: true, reasons: ['MARK_STALE'] } };
    const r = await decide(ctx, { state: 'FLAT' }, ollama((async () => ((called = true), new Response('{}'))) as typeof fetch));
    expect(called).toBe(false);
    expect(r.intent.action).toBe('NO_TRADE');
    expect(r.meta.error).toBe('STALE_CONTEXT:MARK_STALE');
  });
  it.each([
    ['non-JSON output', reply('I think we should buy'), 'BAD_JSON'],
    ['schema violation', reply({ ...intent(), action: 'BUY_EVERYTHING' }), 'SCHEMA'],
    ['HTTP error', (async () => new Response('boom', { status: 500 })) as typeof fetch, 'HTTP'],
    ['network error', (async () => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch, 'NETWORK'],
    ['action illegal while flat', reply(intent({ action: 'EXIT' })), 'ILLEGAL_ACTION'],
  ])('falls back to NO_TRADE on %s', async (_name, fetchFn, code) => {
    const r = await decide(upCtx(), { state: 'FLAT' }, ollama(fetchFn));
    expect(r.intent.action).toBe('NO_TRADE');
    expect(r.meta.ok).toBe(false);
    expect(r.meta.error).toContain(code);
  });
  it('times out to HOLD while in a position, keeping the trail mode', async () => {
    const hang = ((_u: unknown, init?: RequestInit) => new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as typeof fetch;
    const r = await decide(upCtx(), { state: 'OPEN', side: 'LONG', unrealizedR: 1, barsHeld: 2, trailMode: 'STRUCTURE' }, ollama(hang));
    expect(r.intent.action).toBe('HOLD');
    expect(r.intent.trail_mode).toBe('STRUCTURE');
    expect(r.meta.error).toContain('TIMEOUT');
  });
  it('rejects an entry while a position is open', async () => {
    const r = await decide(upCtx(), { state: 'OPEN', side: 'LONG', unrealizedR: 0, barsHeld: 0, trailMode: 'STRUCTURE' }, ollama(reply(intent())));
    expect(r.intent.action).toBe('HOLD');
  });
});

describe('resolver', () => {
  it('builds a passive, tick-aligned long with a stop below entry', () => {
    const ctx = upCtx();
    const res = resolvePlan(intent({ invalidation_atr_mult: 2 }), ctx, harness(), OPTS);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.entry).toBeLessThanOrEqual(ctx.bid + 1e-9);
    expect(res.plan.stop).toBeLessThan(res.plan.entry);
    expect(Math.round(res.plan.entry * 100)).toBeCloseTo(res.plan.entry * 100, 6);
    expect(res.plan.stopPct).toBeCloseTo((res.plan.entry - res.plan.stop) / res.plan.entry, 10);
  });
  it('mirrors for a short and never crosses the spread', () => {
    const ctx = upCtx();
    const res = resolvePlan(intent({ action: 'ENTER_SHORT', entry_ref: 'EMA20_15M', invalidation_atr_mult: 2 }), ctx, harness(), OPTS);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.plan.entry).toBeGreaterThanOrEqual(ctx.ask); // EMA20 is below price in an uptrend: clamped to the ask
      expect(res.plan.stop).toBeGreaterThan(res.plan.entry);
    }
  });
  it.each([
    ['stale context', {}, (c: MarketContext) => ({ ...c, quality: { stale: true, reasons: ['BOOK_STALE'] } }), {}, 'STALE:BOOK_STALE'],
    ['no setup', { setup: 'NONE' as const }, (c: MarketContext) => c, {}, 'NO_SETUP'],
    ['cascade fade outside a cascade', { setup: 'CASCADE_FADE' as const }, (c: MarketContext) => c, {}, 'CASCADE_FADE_OUTSIDE_CASCADE'],
    ['stop too wide', { invalidation_atr_mult: 4 }, (c: MarketContext) => c, { maxStopPct: 0.005 }, 'STOP_TOO_WIDE'],
    ['stop too tight', { invalidation_atr_mult: 0.5 }, (c: MarketContext) => c, { minStopPct: 0.01 }, 'STOP_TOO_TIGHT'],
    ['reward to risk too low', { invalidation_atr_mult: 4 }, (c: MarketContext) => c, { minRR: 5 }, 'RR_BELOW_MIN'],
  ])('rejects: %s', (_n, over, mut, params, reason) => {
    const res = resolvePlan(intent(over), mut(upCtx()), harness({ params: { ...DEFAULT_PARAMS, ...params } }), OPTS);
    expect(res).toEqual({ ok: false, reason });
  });
  it('rejects a stop that would sit inside the liquidation buffer', () => {
    const res = resolvePlan(intent({ invalidation_atr_mult: 4 }), upCtx(), harness({ params: { ...DEFAULT_PARAMS, maxStopPct: 0.05, minRR: 1 } }), { ...OPTS, leverage: 10, liqBufferFrac: 0.05 });
    expect(res).toEqual({ ok: false, reason: 'STOP_INSIDE_LIQUIDATION_BUFFER' });
  });
  it('rejects a disabled bucket and a missing swing', () => {
    const ctx = upCtx();
    expect(resolvePlan(intent(), ctx, harness({ disabled: [`${ctx.regime}|TREND_PULLBACK`] }), OPTS)).toEqual({ ok: false, reason: 'BUCKET_DISABLED' });
    const noSwing = { ...ctx, tf: { ...ctx.tf, '15m': { ...ctx.tf['15m']!, swingLow: null } } };
    expect(resolvePlan(intent({ invalidation_ref: 'SWING_15M' }), noSwing, harness(), OPTS)).toEqual({ ok: false, reason: 'NO_SWING_FOR_STOP' });
  });
  it('rounds to tick and sizes by risk within the leverage cap', () => {
    expect(roundTick(100.019, 0.01, 'down')).toBe(100.01);
    expect(roundTick(100.011, 0.01, 'up')).toBe(100.02);
    expect(roundTick(0.30000000000000004, 0.1, 'down')).toBe(0.3);
    expect(sizeByRisk({ equity: 1000, riskPct: 0.01, entry: 100, stop: 99, stepSize: 0.1, minQty: 0.1, leverage: 5 })).toBe(10);
    expect(sizeByRisk({ equity: 1000, riskPct: 0.01, entry: 100, stop: 99.9, stepSize: 0.1, minQty: 0.1, leverage: 5 })).toBe(50); // margin-capped
    expect(sizeByRisk({ equity: 10, riskPct: 0.001, entry: 100, stop: 99, stepSize: 0.1, minQty: 0.1, leverage: 5 })).toBe(0);
  });
});

describe('trail', () => {
  const pos = (over: Partial<Position> = {}): Position => ({ side: 'LONG', entry: 100, initialStop: 99, stop: 99, best: 100, worst: 100, trailMode: 'BREAKEVEN_THEN_ATR', band: 'P3_6', ...over });
  const inp = { atr15: 0.5, swingLow15: 100.8, swingHigh15: 99.2, breakevenBufferPct: 0.0007 };

  it('holds the initial stop until 1R, then moves to breakeven plus fees', () => {
    expect(nextStop(pos({ best: 100.9 }), inp, DEFAULT_PARAMS)).toBe(99);
    expect(nextStop(pos({ best: 101 }), inp, DEFAULT_PARAMS)).toBeCloseTo(100.07, 6);
  });
  it('trails by ATR after trailStartR and halves the multiple past the band top', () => {
    expect(nextStop(pos({ best: 103 }), inp, DEFAULT_PARAMS)).toBeCloseTo(103 - 3 * 0.5, 6);
    expect(nextStop(pos({ best: 106 }), inp, DEFAULT_PARAMS)).toBeCloseTo(106 - 1.5 * 0.5, 6);
  });
  it('never loosens, for any mode or input', () => {
    const tight = pos({ best: 103, stop: 102.9 });
    expect(nextStop(tight, { ...inp, atr15: 5 }, DEFAULT_PARAMS)).toBe(102.9);
    expect(nextStop({ ...tight, trailMode: 'STRUCTURE' }, { ...inp, swingLow15: 90 }, DEFAULT_PARAMS)).toBe(102.9);
    expect(nextStop(tight, { ...inp, atr15: Number.NaN }, DEFAULT_PARAMS)).toBe(102.9);
  });
  it('ratchets downward for a short', () => {
    const short = pos({ side: 'SHORT', initialStop: 101, stop: 101, best: 97, worst: 100 });
    expect(nextStop(short, inp, DEFAULT_PARAMS)).toBeCloseTo(97 + 3 * 0.5, 6);
    expect(nextStop({ ...short, trailMode: 'STRUCTURE' }, inp, DEFAULT_PARAMS)).toBeCloseTo(99.2 + 0.25 * 0.5, 6);
  });
});

describe('paper executor', () => {
  const plan: OrderPlan = { symbol: 'SOLUSDT', side: 'LONG', entry: 100, stop: 99, stopPct: 0.01, trailMode: 'BREAKEVEN_THEN_ATR', band: 'P3_6', ttlBars: 2, riskFrac: 0.5, qty: 10, intentId: 'i1' };
  const mk = () => {
    const journal = new MemoryJournal();
    return { journal, exec: new PaperExecutor(harness(), journal, { makerBps: 2, takerBps: 5, slippageBps: 0 }) };
  };
  const ctx = upCtx();

  it('needs a trade through the limit, not a touch', () => {
    const { exec } = mk();
    expect(exec.submit(plan, 'R', 'S')).toBe(true);
    expect(exec.submit(plan, 'R', 'S')).toBe(false);
    exec.onTrade('SOLUSDT', 100, NOW);
    expect(exec.state('SOLUSDT').s).toBe('ENTRY_PENDING');
    exec.onTrade('SOLUSDT', 99.99, NOW);
    expect(exec.state('SOLUSDT').s).toBe('OPEN');
  });
  it('records an unfilled intent after the TTL', () => {
    const { exec, journal } = mk();
    exec.submit(plan, 'R', 'S');
    exec.onBarClose('SOLUSDT', ctx);
    exec.onBarClose('SOLUSDT', ctx);
    expect(exec.state('SOLUSDT').s).toBe('IDLE');
    expect(journal.records).toMatchObject([{ kind: 'UNFILLED', regime: 'R', setup: 'S', reason: 'TTL' }]);
  });
  it('stops out at -1R less fees and tracks MFE/MAE', () => {
    const { exec, journal } = mk();
    exec.submit(plan, 'R', 'S');
    exec.onTrade('SOLUSDT', 99.9, NOW);
    exec.onTrade('SOLUSDT', 100.5, NOW);
    exec.onTrade('SOLUSDT', 99, NOW + 1);
    const t = journal.records[0]!;
    expect(t).toMatchObject({ kind: 'TRADE', exitReason: 'STOP', exit: 99, bars: 0 });
    if (t.kind === 'TRADE') {
      expect(t.r).toBeCloseTo(-1 - (2 * 100 + 5 * 99) / 1e4, 6);
      expect(t.mfeR).toBeCloseTo(0.5, 6);
      expect(t.maeR).toBeCloseTo(1, 6);
    }
    expect(exec.state('SOLUSDT').s).toBe('IDLE');
  });
  it('treats a gap through entry and stop as a loss at the print', () => {
    const { exec, journal } = mk();
    exec.submit(plan, 'R', 'S');
    exec.onTrade('SOLUSDT', 98.5, NOW);
    expect(journal.records[0]).toMatchObject({ kind: 'TRADE', exit: 98.5, exitReason: 'STOP' });
  });
  it('labels an exit above the initial stop as TRAIL and supports a model exit', () => {
    const a = mk();
    a.exec.submit(plan, 'R', 'S');
    a.exec.onTrade('SOLUSDT', 99.9, NOW);
    a.exec.onTrade('SOLUSDT', 104, NOW);
    a.exec.onBarClose('SOLUSDT', ctx);
    const st = a.exec.state('SOLUSDT');
    expect(st.s === 'OPEN' && st.pos.stop).toBeGreaterThan(100);
    a.exec.onTrade('SOLUSDT', 100.01, NOW);
    expect(a.journal.records[0]).toMatchObject({ kind: 'TRADE', exitReason: 'TRAIL', bars: 1 });

    const b = mk();
    expect(b.exec.requestExit('SOLUSDT', 101, NOW)).toBe(false);
    b.exec.submit(plan, 'R', 'S');
    b.exec.onTrade('SOLUSDT', 99.9, NOW);
    expect(b.exec.requestExit('SOLUSDT', 101, NOW)).toBe(true);
    expect(b.journal.records[0]).toMatchObject({ kind: 'TRADE', exitReason: 'LLM_EXIT', exit: 101 });
  });
});

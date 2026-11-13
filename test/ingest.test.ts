import { describe, expect, it } from 'vitest';
import { assertNoCredentials } from '../src/config';
import { buildContext } from '../src/features/context';
import { parseFrame } from '../src/ingest/parsers';
import { fetchKlines } from '../src/ingest/rest';
import { buildStreamPlan, streamUrl } from '../src/ingest/ws-client';
import { MarketState } from '../src/state/market-state';
import { CTX_OPTS, NOW, seededState } from './helpers';

const wrap = (data: unknown) => JSON.stringify({ stream: 'x', data });

describe('parsers', () => {
  it('parses aggTrade from a combined-stream frame', () => {
    const r = parseFrame(wrap({ e: 'aggTrade', E: 1, s: 'SOLUSDT', a: 7, p: '150.25', q: '2', f: 1, l: 2, T: 99, m: true }));
    expect(r).toEqual({ ok: true, event: { type: 'aggTrade', symbol: 'SOLUSDT', id: 7, price: 150.25, qty: 2, ts: 99, buyerIsMaker: true } });
  });
  it('parses kline and ignores timeframes we do not track', () => {
    const k = { t: 60000, T: 119999, s: 'SOLUSDT', i: '1m', o: '1', c: '2', h: '3', l: '0.5', v: '10', n: 5, x: true, q: '15', V: '4', Q: '6', B: '0' };
    const r = parseFrame(wrap({ e: 'kline', E: 120000, s: 'SOLUSDT', k }));
    expect(r.ok && r.event.type === 'kline' && r.event.candle).toEqual({ t: 60000, o: 1, h: 3, l: 0.5, c: 2, v: 10, q: 15, tbq: 6, x: true });
    expect(parseFrame(wrap({ e: 'kline', E: 1, s: 'SOLUSDT', k: { ...k, i: '3m' } }))).toEqual({ ok: false, ignored: true });
  });
  it('uses average price and filled quantity for liquidations', () => {
    const r = parseFrame(wrap({ e: 'forceOrder', E: 1, o: { s: 'SOLUSDT', S: 'SELL', o: 'LIMIT', f: 'IOC', q: '10', p: '149', ap: '150', X: 'FILLED', l: '4', z: '8', T: 5 } }));
    expect(r).toEqual({ ok: true, event: { type: 'liquidation', symbol: 'SOLUSDT', side: 'SELL', price: 150, qty: 8, ts: 5 } });
  });
  it('rejects malformed, crossed and non-positive data without throwing', () => {
    expect(parseFrame('{nope')).toMatchObject({ ok: false, ignored: false, reason: 'invalid_json' });
    expect(parseFrame(wrap({ e: 'aggTrade', s: 'SOLUSDT', a: 1, p: '0', q: '1', T: 1, m: false }))).toMatchObject({ ok: false, ignored: false });
    expect(parseFrame(wrap({ e: 'aggTrade', s: 'SOLUSDT', a: 1, p: 'abc', q: '1', T: 1, m: false }))).toMatchObject({ ok: false, ignored: false });
    expect(parseFrame(wrap({ e: 'bookTicker', E: 1, s: 'SOLUSDT', b: '10', B: '1', a: '9', A: '1' }))).toMatchObject({ reason: 'crossed_book' });
    expect(parseFrame(JSON.stringify({ result: null, id: 1 }))).toEqual({ ok: false, ignored: true });
  });
});

describe('stream plan', () => {
  it('routes trade, mark, kline and liquidation streams to /market and book to /public', () => {
    const plan = buildStreamPlan(['SOLUSDT']);
    expect(plan.market).toContain('solusdt@aggTrade');
    expect(plan.market).toContain('solusdt@forceOrder');
    expect(plan.market).toContain('solusdt@kline_15m');
    expect(plan.public).toEqual(['solusdt@bookTicker']);
    expect(streamUrl('wss://fstream.binance.com/', 'market', ['a@aggTrade', 'a@markPrice@1s'])).toBe('wss://fstream.binance.com/market/stream?streams=a@aggTrade/a@markPrice@1s');
  });
});

describe('market state', () => {
  const trade = (id: number, ts: number, buyerIsMaker: boolean, qty = 1) => ({ type: 'aggTrade' as const, symbol: 'SOLUSDT', id, price: 100, qty, ts, buyerIsMaker });

  it('drops duplicate and out-of-order trades', () => {
    const st = new MarketState(['SOLUSDT']);
    expect(st.apply(trade(5, NOW, false))).toBe(true);
    expect(st.apply(trade(5, NOW, false))).toBe(false);
    expect(st.apply(trade(4, NOW, false))).toBe(false);
    expect(st.get('SOLUSDT').dropped.dupTrade).toBe(2);
    expect(st.apply({ ...trade(6, NOW, false), symbol: 'BTCUSDT' })).toBe(false);
  });
  it('signs CVD by aggressor and withholds windows that are not fully covered', () => {
    const st = new MarketState(['SOLUSDT']);
    const s = st.get('SOLUSDT');
    st.apply(trade(1, NOW - 120_000, false, 3)); // taker buy 300
    st.apply(trade(2, NOW - 30_000, true, 1)); // taker sell 100
    expect(s.cvd(60_000, NOW)).toBe(-100);
    expect(s.cvd(300_000, NOW)).toBeNull(); // only 2 minutes of history
    st.apply(trade(9, NOW - 10_000, false, 1)); // id gap 3..8
    expect(s.cvd(60_000, NOW)).toBeNull();
  });
  it('acts on a bar close once and flags missed closes', () => {
    const st = new MarketState(['SOLUSDT']);
    const s = st.get('SOLUSDT');
    const c = (t: number, x: boolean) => ({ type: 'kline' as const, symbol: 'SOLUSDT', tf: '1m' as const, ts: t, candle: { t, o: 1, h: 2, l: 1, c: 2, v: 1, q: 1, tbq: 1, x } });
    expect(st.apply(c(60_000, false))).toBe(true);
    expect(st.apply(c(60_000, true))).toBe(true);
    expect(st.apply(c(60_000, true))).toBe(false); // replayed close
    expect(st.apply(c(60_000, false))).toBe(false); // cannot reopen
    expect(st.apply(c(120_000, false))).toBe(true);
    expect(s.candleGap['1m']).toBe(false);
    expect(st.apply(c(300_000, false))).toBe(true); // 120000 never closed and bars skipped
    expect(s.candleGap['1m']).toBe(true);
    expect(st.gaps()).toEqual([{ symbol: 'SOLUSDT', tf: '1m' }]);
  });
  it('dedupes liquidations and splits them by side', () => {
    const st = new MarketState(['SOLUSDT']);
    const liq = { type: 'liquidation' as const, symbol: 'SOLUSDT', side: 'SELL' as const, price: 100, qty: 50, ts: NOW - 1000 };
    st.apply(liq);
    st.apply(liq);
    st.apply({ ...liq, side: 'BUY', qty: 10 });
    expect(st.get('SOLUSDT').liqNotional(300_000, NOW)).toEqual({ long: 5000, short: 1000 });
  });
});

describe('context', () => {
  it('labels an aligned uptrend and is fresh', () => {
    const { s } = seededState(0.05);
    const ctx = buildContext(s, NOW, CTX_OPTS);
    expect(ctx.quality).toEqual({ stale: false, reasons: [] });
    expect(ctx.trendScore).toBe(3);
    expect(ctx.regime.startsWith('TREND_UP_')).toBe(true);
    expect(ctx.tf['15m']!.swingLow).not.toBeNull();
  });
  it('labels a downtrend, and a cascade overrides trend', () => {
    const { state, s } = seededState(-0.05);
    expect(buildContext(s, NOW, CTX_OPTS).regime.startsWith('TREND_DOWN_')).toBe(true);
    state.apply({ type: 'liquidation', symbol: 'SOLUSDT', side: 'SELL', price: 100, qty: 20_000, ts: NOW - 5000 });
    expect(buildContext(s, NOW, CTX_OPTS).regime).toBe('CASCADE_LONG_FLUSH');
  });
  it('goes stale on old mark data, a candle gap, or missing history', () => {
    const { s } = seededState(0.05);
    expect(buildContext(s, NOW + 6000, CTX_OPTS).quality.reasons).toContain('MARK_STALE');
    s.candleGap['1h'] = true;
    expect(buildContext(s, NOW, CTX_OPTS).quality.reasons).toContain('CANDLE_GAP_1h');
    const empty = new MarketState(['SOLUSDT']).get('SOLUSDT');
    expect(buildContext(empty, NOW, CTX_OPTS).quality.reasons).toEqual(expect.arrayContaining(['MARK_STALE', 'BOOK_STALE', 'NO_VIEW_15m']));
  });
});

describe('rest + guards', () => {
  it('marks the forming kline as open and retries a 5xx', async () => {
    let calls = 0;
    const row = (t: number, close: number) => [t, '1', '2', '0.5', '1.5', '10', close, '15', 3, '4', '6', '0'];
    const fetchFn = (async () => {
      calls += 1;
      if (calls === 1) return new Response('busy', { status: 503 });
      return new Response(JSON.stringify([row(0, 59_999), row(60_000, 119_999)]), { status: 200 });
    }) as typeof fetch;
    const out = await fetchKlines('http://x', 'SOLUSDT', '1m', 2, 90_000, fetchFn);
    expect(calls).toBe(2);
    expect(out.map((c) => c.x)).toEqual([true, false]);
    expect(out[0]).toMatchObject({ t: 0, o: 1, h: 2, l: 0.5, c: 1.5, q: 15, tbq: 6 });
  });
  it('does not retry a 4xx', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return new Response('teapot', { status: 418 });
    }) as typeof fetch;
    await expect(fetchKlines('http://x', 'SOLUSDT', '1m', 2, 0, fetchFn)).rejects.toThrow('HTTP 418');
    expect(calls).toBe(1);
  });
  it('refuses to start with exchange credentials in the environment', () => {
    expect(() => assertNoCredentials({ BINANCE_API_KEY: 'x' })).toThrow(/data-only/);
    expect(() => assertNoCredentials({ OLLAMA_HOST: 'x', PATH: '/bin' })).not.toThrow();
  });
});

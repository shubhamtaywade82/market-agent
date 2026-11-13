import { DEFAULT_PARAMS } from '../src/config';
import { MarketState } from '../src/state/market-state';
import { TF_MS, TFS, type Candle, type Harness, type Tf } from '../src/types';

export const NOW = 1_800_000_000_000;

/** n closed candles ending just before `now`, drifting by `drift` per bar with a zig-zag for swings. */
export function candles(tf: Tf, n: number, start: number, drift: number, now = NOW): Candle[] {
  const ms = TF_MS[tf];
  const firstT = Math.floor(now / ms) * ms - n * ms;
  const out: Candle[] = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    const o = price;
    const wiggle = (i % 6 < 3 ? 1 : -1) * Math.abs(start) * 0.001;
    const c = o + drift + wiggle;
    out.push({ t: firstT + i * ms, o, h: Math.max(o, c) + start * 0.0005, l: Math.min(o, c) - start * 0.0005, c, v: 100, q: 100 * c, tbq: 50 * c, x: true });
    price = c;
  }
  return out;
}

export function seededState(drift: number, symbol = 'SOLUSDT') {
  const state = new MarketState([symbol]);
  const s = state.get(symbol);
  for (const tf of TFS) s.seed(tf, candles(tf, 200, 100, drift));
  const last = s.closed('15m').at(-1)!.c;
  state.apply({ type: 'markPrice', symbol, mark: last, index: last, funding: 0.0001, nextFundingTs: NOW + 1000, ts: NOW });
  state.apply({ type: 'bookTicker', symbol, bid: last - 0.01, bidQty: 10, ask: last + 0.01, askQty: 10, ts: NOW });
  return { state, s, last };
}

export const CTX_OPTS = { staleMarkMs: 5000, staleBookMs: 15000, cascadeLiqUsd5m: 1_000_000 };

export function harness(over: Partial<Harness> = {}): Harness {
  return { id: 'h0', parentId: null, depth: 0, status: 'ACTIVE', createdTs: NOW, params: { ...DEFAULT_PARAMS }, disabled: [], ...over };
}

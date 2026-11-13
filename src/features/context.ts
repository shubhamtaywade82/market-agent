import type { SymbolState } from '../state/market-state';
import { TFS, type Candle, type MarketContext, type Tf, type TfView, type Trend } from '../types';
import { atrSeries, emaSeries, lastSwings, pctRank } from './indicators';

const MIN_BARS = 60;

export interface ContextOpts {
  staleMarkMs: number;
  staleBookMs: number;
  cascadeLiqUsd5m: number;
}

/** Built from closed candles only, so a view never repaints. */
export function buildTfView(closed: Candle[]): TfView | null {
  if (closed.length < MIN_BARS) return null;
  const closes = closed.map((c) => c.c);
  const close = closes[closes.length - 1]!;
  const ema20 = emaSeries(closes, 20).at(-1)!;
  const ema50 = emaSeries(closes, 50).at(-1)!;
  const atrs = atrSeries(closed, 14);
  const atr = atrs.at(-1)!;
  const atrPctSeries = atrs.slice(-100).map((a, i, arr) => a / closed[closed.length - arr.length + i]!.c);
  const atrPct = atr / close;
  const window = closed.slice(-50);
  const hi = Math.max(...window.map((c) => c.h));
  const lo = Math.min(...window.map((c) => c.l));
  const trend: Trend = ema20 > ema50 && close > ema20 ? 'UP' : ema20 < ema50 && close < ema20 ? 'DOWN' : 'FLAT';
  const sw = lastSwings(closed, 2);
  return {
    trend,
    close,
    ema20,
    ema50,
    atr,
    atrPct,
    atrPctile: pctRank(atrPctSeries, atrPct),
    rangePos: hi > lo ? (close - lo) / (hi - lo) : 0.5,
    swingLow: sw.low,
    swingHigh: sw.high,
  };
}

const sign = (t: Trend) => (t === 'UP' ? 1 : t === 'DOWN' ? -1 : 0);

/**
 * Deterministic regime label. Precedence: liquidation cascade, then trend alignment
 * across 15m/1h/4h combined with the 15m volatility state.
 */
export function classifyRegime(tf: Record<Tf, TfView | null>, liq: { longLiqUsd5m: number; shortLiqUsd5m: number }, cascadeUsd: number): { regime: string; trendScore: number } {
  const trendScore = sign(tf['15m']?.trend ?? 'FLAT') + sign(tf['1h']?.trend ?? 'FLAT') + sign(tf['4h']?.trend ?? 'FLAT');
  if (liq.longLiqUsd5m >= cascadeUsd && liq.longLiqUsd5m >= liq.shortLiqUsd5m) return { regime: 'CASCADE_LONG_FLUSH', trendScore };
  if (liq.shortLiqUsd5m >= cascadeUsd) return { regime: 'CASCADE_SHORT_SQUEEZE', trendScore };
  const pctile = tf['15m']?.atrPctile ?? 0.5;
  const vol = pctile >= 0.8 ? 'EXPANSION' : pctile <= 0.2 ? 'COMPRESSION' : 'NORMAL';
  const dir = trendScore >= 2 ? 'TREND_UP' : trendScore <= -2 ? 'TREND_DOWN' : 'RANGE';
  return { regime: `${dir}_${vol}`, trendScore };
}

export function buildContext(s: SymbolState, now: number, opts: ContextOpts): MarketContext {
  const tf = {} as Record<Tf, TfView | null>;
  for (const t of TFS) tf[t] = buildTfView(s.closed(t));

  const liq5 = s.liqNotional(5 * 60_000, now);
  const liq = { longLiqUsd5m: liq5.long, shortLiqUsd5m: liq5.short };
  const { regime, trendScore } = classifyRegime(tf, liq, opts.cascadeLiqUsd5m);

  const mid = (s.bid + s.ask) / 2;
  const depth = s.bidQty + s.askQty;
  const reasons: string[] = [];
  if (s.mark <= 0 || now - s.lastMarkTs > opts.staleMarkMs) reasons.push('MARK_STALE');
  if (s.bid <= 0 || s.ask <= 0 || now - s.lastBookTs > opts.staleBookMs) reasons.push('BOOK_STALE');
  for (const t of ['15m', '1h', '4h'] as const) {
    if (tf[t] === null) reasons.push(`NO_VIEW_${t}`);
    if (s.candleGap[t]) reasons.push(`CANDLE_GAP_${t}`);
  }

  return {
    symbol: s.symbol,
    ts: now,
    mark: s.mark,
    bid: s.bid,
    ask: s.ask,
    tf,
    flow: { cvd1m: s.cvd(60_000, now), cvd5m: s.cvd(300_000, now), cvd15m: s.cvd(900_000, now) },
    liq,
    derivs: {
      fundingRate: s.funding,
      premiumBps: s.index > 0 ? ((s.mark - s.index) / s.index) * 1e4 : 0,
      oiChange1hPct: s.oiChange1hPct,
      longShortRatio: s.longShortRatio,
    },
    book: { spreadBps: mid > 0 ? ((s.ask - s.bid) / mid) * 1e4 : 0, imbalance: depth > 0 ? (s.bidQty - s.askQty) / depth : 0 },
    trendScore,
    regime,
    quality: { stale: reasons.length > 0, reasons },
  };
}

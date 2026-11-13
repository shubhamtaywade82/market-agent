import type { Intent } from '../agent/intent';
import { BAND, type Harness, type MarketContext, type OrderPlan, type Side } from '../types';

export interface ResolveOpts {
  tickSize: number;
  leverage: number;
  liqBufferFrac: number;
}

export type ResolveResult = { ok: true; plan: OrderPlan } | { ok: false; reason: string };

export function roundTick(x: number, tick: number, mode: 'down' | 'up'): number {
  const steps = mode === 'down' ? Math.floor(x / tick + 1e-9) : Math.ceil(x / tick - 1e-9);
  const decimals = Math.max(0, Math.ceil(-Math.log10(tick) - 1e-9));
  return Number((steps * tick).toFixed(decimals));
}

/**
 * Turns an intent into a concrete passive limit order with a mandatory stop.
 * Every price comes from live state. A plan without a valid stop is never produced.
 */
export function resolvePlan(intent: Intent, ctx: MarketContext, harness: Harness, opts: ResolveOpts): ResolveResult {
  if (intent.action !== 'ENTER_LONG' && intent.action !== 'ENTER_SHORT') return { ok: false, reason: 'NOT_AN_ENTRY' };
  if (ctx.quality.stale) return { ok: false, reason: `STALE:${ctx.quality.reasons.join(',')}` };
  if (intent.setup === 'NONE') return { ok: false, reason: 'NO_SETUP' };
  if (intent.setup === 'CASCADE_FADE' && !ctx.regime.startsWith('CASCADE_')) return { ok: false, reason: 'CASCADE_FADE_OUTSIDE_CASCADE' };
  if (harness.disabled.includes(`${ctx.regime}|${intent.setup}`)) return { ok: false, reason: 'BUCKET_DISABLED' };

  const v15 = ctx.tf['15m'];
  const v1h = ctx.tf['1h'];
  if (!v15 || !v1h) return { ok: false, reason: 'NO_VIEW' };
  const side: Side = intent.action === 'ENTER_LONG' ? 'LONG' : 'SHORT';
  const dir = side === 'LONG' ? 1 : -1;
  const atr = v15.atr;
  const p = harness.params;

  // Entry: always passive. LONG rests at or below the bid, SHORT at or above the ask.
  let rawEntry: number;
  switch (intent.entry_ref) {
    case 'BEST_BID_ASK':
      rawEntry = (side === 'LONG' ? ctx.bid : ctx.ask) - dir * intent.entry_offset_atr * atr;
      break;
    case 'EMA20_15M':
      rawEntry = v15.ema20 - dir * intent.entry_offset_atr * atr;
      break;
    case 'SWING_15M': {
      const lvl = side === 'LONG' ? v15.swingLow : v15.swingHigh;
      if (lvl === null) return { ok: false, reason: 'NO_SWING_FOR_ENTRY' };
      rawEntry = lvl + dir * intent.entry_offset_atr * atr;
      break;
    }
  }
  const passive = side === 'LONG' ? Math.min(rawEntry, ctx.bid) : Math.max(rawEntry, ctx.ask);
  const entry = roundTick(passive, opts.tickSize, side === 'LONG' ? 'down' : 'up');

  // Stop: the level that invalidates the idea, plus an ATR buffer for swing references.
  let rawStop: number;
  switch (intent.invalidation_ref) {
    case 'ATR_15M':
      rawStop = entry - dir * intent.invalidation_atr_mult * atr;
      break;
    case 'SWING_15M':
    case 'SWING_1H': {
      const view = intent.invalidation_ref === 'SWING_15M' ? v15 : v1h;
      const lvl = side === 'LONG' ? view.swingLow : view.swingHigh;
      if (lvl === null) return { ok: false, reason: 'NO_SWING_FOR_STOP' };
      rawStop = lvl - dir * p.stopBufferAtr * atr;
      break;
    }
  }
  const stop = roundTick(rawStop, opts.tickSize, side === 'LONG' ? 'down' : 'up');
  if (!(entry > 0) || !(stop > 0)) return { ok: false, reason: 'NON_POSITIVE_PRICE' };
  if (dir * (entry - stop) <= 0) return { ok: false, reason: 'STOP_ON_WRONG_SIDE' };

  const stopPct = Math.abs(entry - stop) / entry;
  if (stopPct < p.minStopPct) return { ok: false, reason: 'STOP_TOO_TIGHT' };
  if (stopPct > p.maxStopPct) return { ok: false, reason: 'STOP_TOO_WIDE' };
  if (stopPct > opts.liqBufferFrac / opts.leverage) return { ok: false, reason: 'STOP_INSIDE_LIQUIDATION_BUFFER' };
  if (BAND[intent.target_band].min / stopPct < p.minRR) return { ok: false, reason: 'RR_BELOW_MIN' };

  return { ok: true, plan: { symbol: ctx.symbol, side, entry, stop, stopPct, trailMode: intent.trail_mode, band: intent.target_band, ttlBars: Math.round(p.entryTtlBars), riskFrac: 1, qty: 0, intentId: '' } };
}

/** Fixed-fractional sizing. Returns 0 when the order cannot be sized within the constraints. */
export function sizeByRisk(a: { equity: number; riskPct: number; entry: number; stop: number; stepSize: number; minQty: number; leverage: number }): number {
  const perUnit = Math.abs(a.entry - a.stop);
  if (!(perUnit > 0) || !(a.equity > 0) || !(a.riskPct > 0)) return 0;
  const byRisk = (a.equity * a.riskPct) / perUnit;
  const byMargin = (a.equity * a.leverage) / a.entry;
  const qty = roundTick(Math.min(byRisk, byMargin), a.stepSize, 'down');
  return qty >= a.minQty ? qty : 0;
}

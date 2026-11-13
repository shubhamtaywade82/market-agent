import { BAND, type HarnessParams, type Side, type TargetBand, type TrailMode } from '../types';

export interface Position {
  side: Side;
  entry: number;
  initialStop: number;
  stop: number;
  /** Best and worst prices seen since entry. */
  best: number;
  worst: number;
  trailMode: TrailMode;
  band: TargetBand;
}

export interface TrailInputs {
  atr15: number;
  swingLow15: number | null;
  swingHigh15: number | null;
  breakevenBufferPct: number;
}

export const dirOf = (side: Side) => (side === 'LONG' ? 1 : -1);
export const rDist = (p: Position) => Math.abs(p.entry - p.initialStop);
export const toR = (p: Position, price: number) => (dirOf(p.side) * (price - p.entry)) / rDist(p);

/**
 * Returns the new stop. It is a ratchet: the result is never looser than the current
 * stop, whatever the mode or inputs. There is no take-profit; once the move reaches
 * the top of the target band the ATR multiple halves so the trail closes in.
 */
export function nextStop(p: Position, inp: TrailInputs, params: HarnessParams): number {
  const dir = dirOf(p.side);
  const peakR = toR(p, p.best);
  const movePct = (dir * (p.best - p.entry)) / p.entry;
  const k = params.atrTrailMult * (movePct >= BAND[p.band].max ? 0.5 : 1);
  const candidates: number[] = [];

  const chandelier = p.best - dir * k * inp.atr15;
  const breakeven = p.entry * (1 + dir * inp.breakevenBufferPct);

  if (p.trailMode === 'BREAKEVEN_THEN_ATR' && peakR >= params.breakevenAtR) candidates.push(breakeven);
  if ((p.trailMode === 'BREAKEVEN_THEN_ATR' || p.trailMode === 'ATR_CHANDELIER') && peakR >= params.trailStartR) candidates.push(chandelier);
  if (p.trailMode === 'STRUCTURE') {
    const lvl = p.side === 'LONG' ? inp.swingLow15 : inp.swingHigh15;
    if (lvl !== null && peakR >= params.breakevenAtR) candidates.push(lvl - dir * params.stopBufferAtr * inp.atr15);
    if (movePct >= BAND[p.band].max) candidates.push(chandelier);
  }

  let stop = p.stop;
  for (const c of candidates) {
    if (!Number.isFinite(c)) continue;
    stop = p.side === 'LONG' ? Math.max(stop, c) : Math.min(stop, c);
  }
  return stop;
}

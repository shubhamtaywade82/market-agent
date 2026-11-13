import type { Candle } from '../types';

export function emaSeries(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out = [values[0]!];
  for (let i = 1; i < values.length; i++) out.push(values[i]! * k + out[i - 1]! * (1 - k));
  return out;
}

/** Wilder ATR. Entries before `period` are simple averages of the true range so far. */
export function atrSeries(c: Candle[], period = 14): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < c.length; i++) {
    const cur = c[i]!;
    const prevClose = i === 0 ? cur.c : c[i - 1]!.c;
    const tr = i === 0 ? cur.h - cur.l : Math.max(cur.h - cur.l, Math.abs(cur.h - prevClose), Math.abs(cur.l - prevClose));
    if (i < period) {
      sum += tr;
      out.push(sum / (i + 1));
    } else {
      out.push((out[i - 1]! * (period - 1) + tr) / period);
    }
  }
  return out;
}

/** Fraction of series values <= value. */
export function pctRank(series: number[], value: number): number {
  if (series.length === 0) return 0.5;
  let n = 0;
  for (const v of series) if (v <= value) n += 1;
  return n / series.length;
}

/**
 * Most recent confirmed pivot low/high. A pivot needs k bars on each side, so it is
 * only known k closed bars later; this never looks ahead.
 */
export function lastSwings(c: Candle[], k = 2): { low: number | null; high: number | null } {
  let low: number | null = null;
  let high: number | null = null;
  for (let i = c.length - 1 - k; i >= k && (low === null || high === null); i--) {
    const cur = c[i]!;
    let isLow = low === null;
    let isHigh = high === null;
    for (let j = 1; j <= k && (isLow || isHigh); j++) {
      const a = c[i - j]!;
      const b = c[i + j]!;
      if (!(cur.l < a.l && cur.l <= b.l)) isLow = false;
      if (!(cur.h > a.h && cur.h >= b.h)) isHigh = false;
    }
    if (isLow) low = cur.l;
    if (isHigh) high = cur.h;
  }
  return { low, high };
}

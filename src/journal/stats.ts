import type { JournalRecord } from '../types';

export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile bootstrap CI of the mean. Seeded, so the same journal always gives the same gate result. */
export function bootstrapMeanCI(xs: number[], alpha = 0.05, minIters = 2000, seed = 42): [number, number] {
  if (xs.length === 0) return [0, 0];
  // A deflated alpha needs enough resamples to resolve its tail quantile.
  const iters = Math.min(200_000, Math.max(minIters, Math.ceil(20 / alpha)));
  const rnd = mulberry32(seed);
  const means: number[] = [];
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < xs.length; j++) s += xs[Math.floor(rnd() * xs.length)]!;
    means.push(s / xs.length);
  }
  means.sort((a, b) => a - b);
  const at = (q: number) => means[Math.min(iters - 1, Math.max(0, Math.floor(q * iters)))]!;
  return [at(alpha / 2), at(1 - alpha / 2)];
}

export interface BucketStats {
  key: string;
  trades: number;
  unfilled: number;
  fillRate: number;
  expectancyR: number;
  ciLo: number;
  ciHi: number;
  /** Mean of (MFE - realised R): how much open profit the exit rules gave back. */
  givebackR: number;
  /** Share of trades closed at the initial stop within one bar. */
  fastStopShare: number;
}

const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/** Stats per `${regime}|${setup}` bucket plus an 'ALL' row. alpha is the CI level (deflate it for multiple trials). */
export function bucketStats(records: JournalRecord[], alpha = 0.05): Map<string, BucketStats> {
  const groups = new Map<string, { rs: number[]; give: number[]; fast: number; unfilled: number }>();
  const slot = (key: string) => {
    let g = groups.get(key);
    if (!g) {
      g = { rs: [], give: [], fast: 0, unfilled: 0 };
      groups.set(key, g);
    }
    return g;
  };
  for (const rec of records) {
    if (rec.kind === 'INTENT') continue;
    for (const key of [`${rec.regime}|${rec.setup}`, 'ALL']) {
      const g = slot(key);
      if (rec.kind === 'UNFILLED') g.unfilled += 1;
      else {
        g.rs.push(rec.r);
        g.give.push(rec.mfeR - rec.r);
        if (rec.exitReason === 'STOP' && rec.bars <= 1) g.fast += 1;
      }
    }
  }
  const out = new Map<string, BucketStats>();
  for (const [key, g] of groups) {
    const n = g.rs.length;
    const [ciLo, ciHi] = bootstrapMeanCI(g.rs, alpha);
    out.set(key, {
      key,
      trades: n,
      unfilled: g.unfilled,
      fillRate: n + g.unfilled === 0 ? 0 : n / (n + g.unfilled),
      expectancyR: mean(g.rs),
      ciLo,
      ciHi,
      givebackR: mean(g.give),
      fastStopShare: n === 0 ? 0 : g.fast / n,
    });
  }
  return out;
}

export const REASON_CODES = ['LOW_SAMPLE', 'EDGE_POSITIVE', 'EDGE_NEGATIVE', 'EDGE_UNPROVEN', 'LOW_FILL_RATE', 'HIGH_GIVEBACK', 'FAST_STOPOUTS'] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/**
 * Qualitative codes only. This is all the proposer model ever sees about performance:
 * no expectancy, no counts, no confidence intervals.
 */
export function reasonCodes(b: BucketStats, minSample = 30): ReasonCode[] {
  const codes: ReasonCode[] = [];
  if (b.trades < minSample) codes.push('LOW_SAMPLE');
  else if (b.ciLo > 0) codes.push('EDGE_POSITIVE');
  else if (b.ciHi < 0) codes.push('EDGE_NEGATIVE');
  else codes.push('EDGE_UNPROVEN');
  if (b.trades + b.unfilled >= 10 && b.fillRate < 0.3) codes.push('LOW_FILL_RATE');
  if (b.trades >= 10 && b.givebackR > 1) codes.push('HIGH_GIVEBACK');
  if (b.trades >= 10 && b.fastStopShare > 0.4) codes.push('FAST_STOPOUTS');
  return codes;
}

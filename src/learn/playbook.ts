import { bucketStats, reasonCodes } from '../journal/stats';
import type { Tier } from '../risk/desk';
import type { JournalRecord, MarketContext, Side } from '../types';

export type Recall = 'NO_HISTORY' | 'SIMILAR_MOSTLY_WON' | 'SIMILAR_MIXED' | 'SIMILAR_MOSTLY_LOST';
type Trade = Extract<JournalRecord, { kind: 'TRADE' }>;

export interface PlaybookOpts {
  /** Rolling window of trades per bucket, so a decayed edge stops counting as proven. */
  window: number;
  minSample: number;
  /** A benched bucket gets one half-size probe after this long without a trade. */
  paroleMs: number;
  /** Early bench: the last streakN trades summing to streakR or worse. */
  streakN: number;
  streakR: number;
  k: number;
  minNeighbors: number;
  maxDist: number;
}

export const DEFAULT_PLAYBOOK: PlaybookOpts = { window: 60, minSample: 30, paroleMs: 14 * 86_400_000, streakN: 8, streakR: -5, k: 7, minNeighbors: 3, maxDist: 0.75 };

const clamp = (x: number) => Math.max(-1, Math.min(1, x));

/** Scale-free description of a market state, so situations compare across symbols and price levels. */
export function featureVec(ctx: MarketContext): number[] | null {
  const a = ctx.tf['15m'];
  const b = ctx.tf['1h'];
  if (!a || !b) return null;
  return [
    ctx.trendScore / 3,
    a.atrPctile,
    a.rangePos,
    b.rangePos,
    clamp(ctx.derivs.premiumBps / 10),
    clamp(ctx.derivs.fundingRate / 0.0005),
    clamp(ctx.book.imbalance),
    clamp((ctx.derivs.oiChange1hPct ?? 0) / 0.05),
  ];
}

/**
 * Live memory of what has worked. Built from the journal and updated on every record.
 *  - tier(): per regime|setup bucket. Demotion is immediate (it only removes risk);
 *    promotion to PROVEN needs a positive bootstrap interval over the rolling window.
 *  - recall(): outcome of the nearest past entries to the current market state.
 */
export class Playbook {
  private readonly trades = new Map<string, Trade[]>();
  private readonly pending = new Map<string, { vec: number[]; side: Side }>();
  private readonly episodes: Array<{ vec: number[]; side: Side; r: number }> = [];
  private readonly tierCache = new Map<string, 'PROVEN' | 'PROBATION' | 'NEGATIVE'>();

  constructor(private readonly opts: PlaybookOpts = DEFAULT_PLAYBOOK) {}

  add(rec: JournalRecord): void {
    if (rec.kind === 'INTENT') {
      if (!rec.accepted || !rec.intentId) return;
      const side: Side | null = rec.action === 'ENTER_LONG' ? 'LONG' : rec.action === 'ENTER_SHORT' ? 'SHORT' : null;
      const vec = featureVec(rec.ctx);
      if (side && vec) this.pending.set(rec.intentId, { vec, side });
      return;
    }
    if (rec.intentId === undefined) return;
    const entry = this.pending.get(rec.intentId);
    this.pending.delete(rec.intentId);
    if (rec.kind !== 'TRADE') return;
    const key = `${rec.regime}|${rec.setup}`;
    const list = this.trades.get(key) ?? [];
    list.push(rec);
    if (list.length > this.opts.window) list.shift();
    this.trades.set(key, list);
    this.tierCache.delete(key);
    if (entry) {
      this.episodes.push({ ...entry, r: rec.r });
      if (this.episodes.length > 5000) this.episodes.shift();
    }
  }

  tier(bucket: string, now: number): Tier {
    const list = this.trades.get(bucket);
    if (!list || list.length === 0) return 'PROBATION';
    let verdict = this.tierCache.get(bucket);
    if (!verdict) {
      const codes = reasonCodes(bucketStats(list).get(bucket)!, this.opts.minSample);
      const streak = list.slice(-this.opts.streakN);
      const badStreak = streak.length >= this.opts.streakN && streak.reduce((s, t) => s + t.r, 0) <= this.opts.streakR;
      verdict = codes.includes('EDGE_NEGATIVE') || badStreak ? 'NEGATIVE' : codes.includes('EDGE_POSITIVE') ? 'PROVEN' : 'PROBATION';
      this.tierCache.set(bucket, verdict);
    }
    if (verdict !== 'NEGATIVE') return verdict;
    return now - list[list.length - 1]!.ts > this.opts.paroleMs ? 'PROBATION' : 'BENCHED';
  }

  recall(ctx: MarketContext, side: Side): Recall {
    const vec = featureVec(ctx);
    if (!vec) return 'NO_HISTORY';
    const near = this.episodes
      .filter((e) => e.side === side)
      .map((e) => ({ r: e.r, d: Math.sqrt(e.vec.reduce((s, v, i) => s + (v - vec[i]!) ** 2, 0)) }))
      .filter((e) => e.d <= this.opts.maxDist)
      .sort((x, y) => x.d - y.d)
      .slice(0, this.opts.k);
    if (near.length < this.opts.minNeighbors) return 'NO_HISTORY';
    const meanR = near.reduce((s, e) => s + e.r, 0) / near.length;
    return meanR > 0.3 ? 'SIMILAR_MOSTLY_WON' : meanR < -0.3 ? 'SIMILAR_MOSTLY_LOST' : 'SIMILAR_MIXED';
  }
}

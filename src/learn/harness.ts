import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { DEFAULT_PARAMS, PARAM_BOUNDS } from '../config';
import { bucketStats } from '../journal/stats';
import type { Harness, HarnessParams, JournalRecord } from '../types';

export const MAX_LINEAGE_DEPTH = 3;
export const MIN_OOS_TRADES = 80;
const NUDGE_STEP = 0.1;

const PARAM_KEYS = Object.keys(PARAM_BOUNDS) as [keyof HarnessParams, ...(keyof HarnessParams)[]];

export const MutationSchema = z
  .object({
    op: z.enum(['NUDGE', 'DISABLE', 'ENABLE', 'NONE']),
    param: z.enum(PARAM_KEYS).nullable(),
    direction: z.enum(['UP', 'DOWN']).nullable(),
    bucket: z.string().nullable(),
  })
  .strict();
export type Mutation = z.infer<typeof MutationSchema>;

export const MUTATION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['op', 'param', 'direction', 'bucket'],
  properties: {
    op: { type: 'string', enum: ['NUDGE', 'DISABLE', 'ENABLE', 'NONE'] },
    param: { type: ['string', 'null'], enum: [...PARAM_KEYS, null] },
    direction: { type: ['string', 'null'], enum: ['UP', 'DOWN', null] },
    bucket: { type: ['string', 'null'] },
  },
} as const;

export function rootHarness(now: number): Harness {
  return { id: 'h0', parentId: null, depth: 0, status: 'ACTIVE', createdTs: now, params: { ...DEFAULT_PARAMS }, disabled: [] };
}

export type MutationResult = { ok: true; harness: Harness } | { ok: false; reason: string };

/**
 * Applies one bounded change to a parent harness and returns a CANDIDATE child.
 * The model chooses the direction; the size of the step, the bounds, and the evidence
 * needed to disable a bucket are fixed here.
 */
export function applyMutation(parent: Harness, m: Mutation, bucketCodes: Record<string, string[]>, existingIds: string[], now: number): MutationResult {
  if (m.op === 'NONE') return { ok: false, reason: 'NO_CHANGE_PROPOSED' };
  if (parent.depth + 1 > MAX_LINEAGE_DEPTH) return { ok: false, reason: 'LINEAGE_DEPTH_EXCEEDED' };

  const params = { ...parent.params };
  let disabled = [...parent.disabled];

  if (m.op === 'NUDGE') {
    if (!m.param || !m.direction) return { ok: false, reason: 'NUDGE_NEEDS_PARAM_AND_DIRECTION' };
    const [lo, hi] = PARAM_BOUNDS[m.param];
    const cur = params[m.param];
    const sign = m.direction === 'UP' ? 1 : -1;
    const next = m.param === 'entryTtlBars' ? cur + sign : cur * (1 + sign * NUDGE_STEP);
    const clamped = Math.min(hi, Math.max(lo, next));
    if (clamped === cur) return { ok: false, reason: 'PARAM_AT_BOUND' };
    params[m.param] = clamped;
    if (params.minStopPct >= params.maxStopPct) return { ok: false, reason: 'STOP_BOUNDS_CROSSED' };
    if (params.breakevenAtR > params.trailStartR) return { ok: false, reason: 'BREAKEVEN_AFTER_TRAIL_START' };
  } else {
    if (!m.bucket) return { ok: false, reason: 'BUCKET_REQUIRED' };
    if (m.op === 'DISABLE') {
      if (!(bucketCodes[m.bucket] ?? []).includes('EDGE_NEGATIVE')) return { ok: false, reason: 'DISABLE_WITHOUT_NEGATIVE_EDGE' };
      if (disabled.includes(m.bucket)) return { ok: false, reason: 'ALREADY_DISABLED' };
      disabled.push(m.bucket);
    } else {
      if (!disabled.includes(m.bucket)) return { ok: false, reason: 'NOT_DISABLED' };
      disabled = disabled.filter((b) => b !== m.bucket);
    }
  }

  let n = existingIds.length;
  while (existingIds.includes(`h${n}`)) n += 1;
  return { ok: true, harness: { id: `h${n}`, parentId: parent.id, depth: parent.depth + 1, status: 'CANDIDATE', createdTs: now, params, disabled } };
}

/**
 * Promotion gate on the candidate's own forward journal (all of it is out-of-sample,
 * since the candidate did not exist when earlier data was observed). The CI level is
 * Bonferroni-deflated by the number of candidates ever tried.
 */
export function promotionGate(candidateRecords: JournalRecord[], trials: number): { pass: boolean; reason: string } {
  const all = bucketStats(candidateRecords, 0.05 / Math.max(1, trials)).get('ALL');
  if (!all || all.trades < MIN_OOS_TRADES) return { pass: false, reason: 'INSUFFICIENT_OOS_TRADES' };
  if (all.ciLo <= 0) return { pass: false, reason: 'EXPECTANCY_CI_INCLUDES_ZERO' };
  return { pass: true, reason: 'PASS' };
}

export function loadHarnesses(path: string, now: number): Harness[] {
  if (!existsSync(path)) return [rootHarness(now)];
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Harness[];
  if (!Array.isArray(parsed) || parsed.filter((h) => h.status === 'ACTIVE').length !== 1) {
    throw new Error(`${path}: expected exactly one ACTIVE harness`);
  }
  return parsed;
}

export function saveHarnesses(path: string, harnesses: Harness[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(harnesses, null, 2));
  renameSync(tmp, path);
}

import { mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PARAM_BOUNDS } from '../src/config';
import { FileJournal } from '../src/journal/journal';
import { bootstrapMeanCI, bucketStats, reasonCodes } from '../src/journal/stats';
import { applyMutation, loadHarnesses, MUTATION_JSON_SCHEMA, MutationSchema, promotionGate, saveHarnesses } from '../src/learn/harness';
import type { JournalRecord } from '../src/types';
import { harness, NOW } from './helpers';

const trade = (r: number, over: Partial<Extract<JournalRecord, { kind: 'TRADE' }>> = {}): JournalRecord => ({
  kind: 'TRADE', ts: NOW, symbol: 'SOLUSDT', harnessId: 'h0', regime: 'TREND_UP_NORMAL', setup: 'TREND_PULLBACK', side: 'LONG',
  entry: 100, exit: 100 + r, initialStop: 99, r, mfeR: Math.max(r, 0), maeR: Math.max(-r, 0), bars: 5, exitReason: r > 0 ? 'TRAIL' : 'STOP', ...over,
});
const unfilled: JournalRecord = { kind: 'UNFILLED', ts: NOW, symbol: 'SOLUSDT', harnessId: 'h0', regime: 'TREND_UP_NORMAL', setup: 'TREND_PULLBACK', reason: 'TTL' };
const KEY = 'TREND_UP_NORMAL|TREND_PULLBACK';
const many = (n: number, f: (i: number) => JournalRecord) => Array.from({ length: n }, (_, i) => f(i));

describe('stats', () => {
  it('bootstrap is deterministic and brackets the mean', () => {
    const xs = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? 3 : -1));
    const a = bootstrapMeanCI(xs);
    expect(bootstrapMeanCI(xs)).toEqual(a);
    expect(a[0]).toBeLessThan(1 / 3);
    expect(a[1]).toBeGreaterThan(1 / 3);
    expect(bootstrapMeanCI(xs, 0.001)[0]).toBeLessThan(a[0]); // deflated alpha widens the interval
  });
  it('computes fill rate, expectancy and giveback per bucket and overall', () => {
    const recs = [trade(2, { mfeR: 4 }), trade(-1), unfilled, unfilled];
    const s = bucketStats(recs).get(KEY)!;
    expect(s).toMatchObject({ trades: 2, unfilled: 2, fillRate: 0.5, expectancyR: 0.5 });
    expect(s.givebackR).toBeCloseTo((2 + 1) / 2, 6);
    expect(bucketStats(recs).get('ALL')!.trades).toBe(2);
  });
  it('maps stats to qualitative reason codes', () => {
    const code = (recs: JournalRecord[]) => reasonCodes(bucketStats(recs).get(KEY)!);
    expect(code([trade(1)])).toEqual(['LOW_SAMPLE']);
    expect(code(many(40, () => trade(1)))).toEqual(['EDGE_POSITIVE']);
    expect(code(many(40, () => trade(-1, { bars: 1 })))).toEqual(['EDGE_NEGATIVE', 'FAST_STOPOUTS']);
    expect(code(many(40, (i) => trade(i % 2 ? 1 : -1)))).toEqual(['EDGE_UNPROVEN']);
    expect(code([...many(40, () => trade(1, { mfeR: 3 })), ...many(200, () => unfilled)])).toEqual(['EDGE_POSITIVE', 'LOW_FILL_RATE', 'HIGH_GIVEBACK']);
  });
});

describe('harness mutation', () => {
  const codes = { [KEY]: ['EDGE_NEGATIVE'], OTHER: ['EDGE_UNPROVEN'] };
  const mut = (m: Partial<ReturnType<typeof MutationSchema.parse>>) => MutationSchema.parse({ op: 'NONE', param: null, direction: null, bucket: null, ...m });

  it('schema and JSON schema agree, and reject free-form numbers', () => {
    expect(Object.keys(MUTATION_JSON_SCHEMA.properties).sort()).toEqual(Object.keys(MutationSchema.shape).sort());
    expect(MutationSchema.safeParse({ op: 'NUDGE', param: 'atrTrailMult', direction: 'UP', bucket: null, value: 99 }).success).toBe(false);
  });
  it('nudges one bounded step and creates a CANDIDATE child', () => {
    const res = applyMutation(harness(), mut({ op: 'NUDGE', param: 'atrTrailMult', direction: 'DOWN' }), codes, ['h0'], NOW);
    expect(res).toMatchObject({ ok: true, harness: { id: 'h1', parentId: 'h0', depth: 1, status: 'CANDIDATE' } });
    if (res.ok) expect(res.harness.params.atrTrailMult).toBeCloseTo(2.7, 6);
    const ttl = applyMutation(harness(), mut({ op: 'NUDGE', param: 'entryTtlBars', direction: 'UP' }), codes, ['h0'], NOW);
    if (ttl.ok) expect(ttl.harness.params.entryTtlBars).toBe(4);
  });
  it('clamps at bounds and keeps parameters coherent', () => {
    const atMax = harness({ params: { ...harness().params, atrTrailMult: PARAM_BOUNDS.atrTrailMult[1] } });
    expect(applyMutation(atMax, mut({ op: 'NUDGE', param: 'atrTrailMult', direction: 'UP' }), codes, ['h0'], NOW)).toEqual({ ok: false, reason: 'PARAM_AT_BOUND' });
    const tight = harness({ params: { ...harness().params, breakevenAtR: 1.5, trailStartR: 1.5 } });
    expect(applyMutation(tight, mut({ op: 'NUDGE', param: 'breakevenAtR', direction: 'UP' }), codes, ['h0'], NOW)).toEqual({ ok: false, reason: 'BREAKEVEN_AFTER_TRAIL_START' });
    expect(applyMutation(harness(), mut({ op: 'NUDGE', param: 'minRR' }), codes, ['h0'], NOW)).toEqual({ ok: false, reason: 'NUDGE_NEEDS_PARAM_AND_DIRECTION' });
  });
  it('only disables buckets with proven negative edge', () => {
    expect(applyMutation(harness(), mut({ op: 'DISABLE', bucket: 'OTHER' }), codes, ['h0'], NOW)).toEqual({ ok: false, reason: 'DISABLE_WITHOUT_NEGATIVE_EDGE' });
    const res = applyMutation(harness(), mut({ op: 'DISABLE', bucket: KEY }), codes, ['h0'], NOW);
    expect(res.ok && res.harness.disabled).toEqual([KEY]);
    expect(applyMutation(harness(), mut({ op: 'ENABLE', bucket: KEY }), codes, ['h0'], NOW)).toEqual({ ok: false, reason: 'NOT_DISABLED' });
  });
  it('caps lineage depth at 3 and ignores NONE', () => {
    expect(applyMutation(harness({ depth: 3 }), mut({ op: 'NUDGE', param: 'minRR', direction: 'UP' }), codes, ['h0'], NOW)).toEqual({ ok: false, reason: 'LINEAGE_DEPTH_EXCEEDED' });
    expect(applyMutation(harness(), mut({}), codes, ['h0'], NOW)).toEqual({ ok: false, reason: 'NO_CHANGE_PROPOSED' });
  });
});

describe('promotion gate', () => {
  it('needs 80 out-of-sample trades and a CI above zero', () => {
    expect(promotionGate(many(79, () => trade(1)), 1)).toEqual({ pass: false, reason: 'INSUFFICIENT_OOS_TRADES' });
    expect(promotionGate(many(120, (i) => trade(i % 2 ? 1 : -1)), 1)).toEqual({ pass: false, reason: 'EXPECTANCY_CI_INCLUDES_ZERO' });
    expect(promotionGate(many(120, (i) => trade(i % 3 ? 2 : -1)), 1)).toEqual({ pass: true, reason: 'PASS' });
  });
  it('gets stricter as more candidates are tried', () => {
    const marginal = many(400, (i) => trade(i % 5 < 2 ? 2 : -1)); // mean +0.2R
    expect(promotionGate(marginal, 1).pass).toBe(true);
    expect(promotionGate(marginal, 1000).pass).toBe(false);
  });
});

describe('persistence', () => {
  it('journal survives a torn final line', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ma-')), 'j.jsonl');
    const j = new FileJournal(path);
    j.append(trade(1));
    j.append(unfilled);
    appendFileSync(path, '{"kind":"TRADE","ts":17');
    expect(j.read()).toMatchObject({ corrupt: 1, records: [{ kind: 'TRADE' }, { kind: 'UNFILLED' }] });
  });
  it('harness store round-trips and insists on one ACTIVE harness', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ma-')), 'h.json');
    expect(loadHarnesses(path, NOW)).toMatchObject([{ id: 'h0', status: 'ACTIVE' }]);
    saveHarnesses(path, [harness(), harness({ id: 'h1', status: 'CANDIDATE' })]);
    expect(loadHarnesses(path, NOW).map((h) => h.id)).toEqual(['h0', 'h1']);
    saveHarnesses(path, [harness({ status: 'RETIRED' })]);
    expect(() => loadHarnesses(path, NOW)).toThrow(/exactly one ACTIVE/);
  });
});

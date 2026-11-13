/**
 * Learning step. Runs on a timer inside the runner and on demand via `npm run learn`; never inside a decision.
 *   1. Check every CANDIDATE against the promotion gate; promote at most one.
 *   2. Summarise the ACTIVE harness journal as reason codes per bucket.
 *   3. Ask the model for one bounded mutation and register it as a new CANDIDATE.
 * The model sees parameter names and reason codes. It never sees performance numbers.
 */
import { join } from 'node:path';
import { chatJson } from '../agent/ollama';
import type { AppConfig } from '../config';
import { FileJournal } from '../journal/journal';
import { bucketStats, reasonCodes } from '../journal/stats';
import { applyMutation, loadHarnesses, MUTATION_JSON_SCHEMA, MutationSchema, promotionGate, saveHarnesses } from './harness';
import type { Harness, Logger } from '../types';

const PROPOSER_SYSTEM = `You tune a trading harness. You receive the current parameters and, for each regime|setup bucket, qualitative reason codes.
Propose exactly ONE change as JSON:
- NUDGE: move one parameter one step UP or DOWN. HIGH_GIVEBACK suggests a tighter trail (atrTrailMult DOWN or trailStartR DOWN). FAST_STOPOUTS suggests wider stops (stopBufferAtr UP or minStopPct UP). LOW_FILL_RATE suggests entryTtlBars UP.
- DISABLE: switch off a bucket. Only allowed for a bucket carrying EDGE_NEGATIVE.
- ENABLE: switch a disabled bucket back on.
- NONE: when nothing is justified. LOW_SAMPLE alone never justifies a change.
Set unused fields to null.`;

export async function runLearnStep(cfg: AppConfig, log: Logger, now: number = Date.now()): Promise<Harness[]> {
  const path = join(cfg.dataDir, 'harnesses.json');
  const harnesses = loadHarnesses(path, now);
  const journalOf = (id: string) => new FileJournal(join(cfg.dataDir, `journal-${id}.jsonl`)).read().records;
  const trials = Math.max(1, harnesses.length - 1);

  for (const cand of harnesses.filter((h) => h.status === 'CANDIDATE')) {
    const gate = promotionGate(journalOf(cand.id), trials);
    log('info', 'promotion_gate', { harness: cand.id, ...gate });
    if (gate.pass) {
      for (const h of harnesses) if (h.status === 'ACTIVE') h.status = 'RETIRED';
      cand.status = 'ACTIVE';
      saveHarnesses(path, harnesses);
      log('info', 'promoted', { harness: cand.id });
      break;
    }
  }

  const active = harnesses.find((h) => h.status === 'ACTIVE')!;
  const stats = bucketStats(journalOf(active.id));
  const codes: Record<string, string[]> = {};
  for (const [key, b] of stats) if (key !== 'ALL') codes[key] = reasonCodes(b);
  if (Object.keys(codes).length === 0) {
    log('info', 'learn_skip', { reason: 'EMPTY_JOURNAL' });
    saveHarnesses(path, harnesses);
    return harnesses;
  }

  let raw: unknown;
  try {
    raw = await chatJson({ ...cfg.ollama, timeoutMs: Math.max(cfg.ollama.timeoutMs, 60_000) }, PROPOSER_SYSTEM, JSON.stringify({ parameters: Object.keys(active.params), disabled_buckets: active.disabled, bucket_reason_codes: codes }), MUTATION_JSON_SCHEMA);
  } catch (err) {
    log('warn', 'proposer_failed', { error: String(err) });
    saveHarnesses(path, harnesses);
    return harnesses;
  }
  const parsed = MutationSchema.safeParse(raw);
  if (!parsed.success) {
    log('warn', 'proposer_schema_violation', { raw });
    saveHarnesses(path, harnesses);
    return harnesses;
  }
  const res = applyMutation(active, parsed.data, codes, harnesses.map((h) => h.id), now);
  if (res.ok) {
    harnesses.push(res.harness);
    log('info', 'candidate_created', { harness: res.harness.id, parent: active.id, mutation: parsed.data });
  } else {
    log('info', 'mutation_rejected', { reason: res.reason, mutation: parsed.data });
  }
  saveHarnesses(path, harnesses);
  return harnesses;
}

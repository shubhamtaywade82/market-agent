import { z } from 'zod';

export const ACTIONS = ['ENTER_LONG', 'ENTER_SHORT', 'HOLD', 'EXIT', 'NO_TRADE'] as const;
export const SETUPS = ['TREND_PULLBACK', 'BREAKOUT_RETEST', 'CASCADE_FADE', 'RANGE_REVERSION', 'NONE'] as const;
export const ENTRY_REFS = ['BEST_BID_ASK', 'EMA20_15M', 'SWING_15M'] as const;
export const INVALIDATION_REFS = ['SWING_15M', 'SWING_1H', 'ATR_15M'] as const;
export const TRAIL_MODES = ['ATR_CHANDELIER', 'STRUCTURE', 'BREAKEVEN_THEN_ATR'] as const;
export const BANDS = ['P1_3', 'P3_6', 'P6_10'] as const;
export const CONFIDENCE = ['LOW', 'MEDIUM', 'HIGH'] as const;
export const REASONS = [
  'HTF_TREND_ALIGNED',
  'HTF_TREND_AGAINST',
  'VOL_EXPANSION',
  'VOL_COMPRESSION',
  'FLOW_CONFIRMS',
  'FLOW_DIVERGES',
  'LIQUIDATION_FLUSH',
  'FUNDING_CROWDED',
  'OI_BUILDING',
  'OI_UNWINDING',
  'AT_STRUCTURE',
  'NO_EDGE',
  'DATA_QUALITY',
] as const;

/**
 * The model never emits a price or a size. It picks references; the resolver turns
 * them into numbers from live state. A hallucinated level is therefore impossible.
 */
export const IntentSchema = z
  .object({
    action: z.enum(ACTIONS),
    setup: z.enum(SETUPS),
    entry_ref: z.enum(ENTRY_REFS),
    entry_offset_atr: z.number().min(0).max(1),
    invalidation_ref: z.enum(INVALIDATION_REFS),
    invalidation_atr_mult: z.number().min(0.5).max(4),
    trail_mode: z.enum(TRAIL_MODES),
    target_band: z.enum(BANDS),
    confidence: z.enum(CONFIDENCE),
    reason_codes: z.array(z.enum(REASONS)).max(5),
  })
  .strict();

export type Intent = z.infer<typeof IntentSchema>;

/** JSON Schema passed to Ollama's `format` field. Kept in lockstep with IntentSchema by a test. */
export const INTENT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'setup', 'entry_ref', 'entry_offset_atr', 'invalidation_ref', 'invalidation_atr_mult', 'trail_mode', 'target_band', 'confidence', 'reason_codes'],
  properties: {
    action: { type: 'string', enum: ACTIONS },
    setup: { type: 'string', enum: SETUPS },
    entry_ref: { type: 'string', enum: ENTRY_REFS },
    entry_offset_atr: { type: 'number', minimum: 0, maximum: 1 },
    invalidation_ref: { type: 'string', enum: INVALIDATION_REFS },
    invalidation_atr_mult: { type: 'number', minimum: 0.5, maximum: 4 },
    trail_mode: { type: 'string', enum: TRAIL_MODES },
    target_band: { type: 'string', enum: BANDS },
    confidence: { type: 'string', enum: CONFIDENCE },
    reason_codes: { type: 'array', maxItems: 5, items: { type: 'string', enum: REASONS } },
  },
} as const;

/** Safe default: do nothing when flat, keep the position (and its stop) when open. */
export function failClosedIntent(inPosition: boolean, trailMode: Intent['trail_mode'] = 'BREAKEVEN_THEN_ATR'): Intent {
  return {
    action: inPosition ? 'HOLD' : 'NO_TRADE',
    setup: 'NONE',
    entry_ref: 'BEST_BID_ASK',
    entry_offset_atr: 0,
    invalidation_ref: 'ATR_15M',
    invalidation_atr_mult: 2,
    trail_mode: trailMode,
    target_band: 'P1_3',
    confidence: 'LOW',
    reason_codes: ['DATA_QUALITY'],
  };
}

import type { MarketContext, TfView, TrailMode } from '../types';
import { failClosedIntent, INTENT_JSON_SCHEMA, IntentSchema, type Intent } from './intent';
import { chatJson, OllamaError, type OllamaOpts } from './ollama';

export type PositionSummary =
  | { state: 'FLAT' }
  | { state: 'OPEN'; side: 'LONG' | 'SHORT'; unrealizedR: number; barsHeld: number; trailMode: TrailMode };

/** What the desk and playbook currently think. Qualitative labels only. */
export interface Brief {
  deskMode: string;
  /** Tier per setup in the current regime. */
  setupTiers: Record<string, string>;
  similarPast: { long: string; short: string };
}

export interface DecisionMeta {
  ok: boolean;
  latencyMs: number;
  error: string | null;
}

export const SYSTEM_PROMPT = `You are the market-context analyst inside a crypto perpetual futures trading system.
You read a multi-timeframe snapshot and output ONE JSON object describing intent. You never output prices or sizes.
A deterministic engine resolves your references into prices, enforces a mandatory stop, and may reject your intent.

Rules:
- If position.state is FLAT, action must be ENTER_LONG, ENTER_SHORT or NO_TRADE.
- If position.state is OPEN, action must be HOLD or EXIT. You may change trail_mode; the stop only ever tightens.
- Prefer NO_TRADE. Enter only when higher timeframes, flow and structure agree.
- Moves targeted are 1% to 10%. target_band is your estimate of the move available: P1_3, P3_6 or P6_10.
- invalidation_ref is the level that proves the idea wrong. SWING_* uses the last confirmed swing; ATR_15M uses invalidation_atr_mult x ATR.
- entry_ref is where a passive limit order rests. entry_offset_atr moves it further from price, in 15m ATR units.
- CASCADE_FADE is only valid in a CASCADE_* regime.
- reason_codes must describe what you actually see in the snapshot.
- brief.setup_tiers is the desk's record for each setup in this regime: PROVEN, PROBATION or BENCHED. Never choose a BENCHED setup.
- brief.similar_past says how the nearest past entries to this exact situation ended. SIMILAR_MOSTLY_LOST is a strong reason for NO_TRADE.
- brief.desk_mode REDUCED means the desk is in drawdown: only take the clearest setups.`;

const r = (v: number, d: number) => Number(v.toFixed(d));

function tfSummary(v: TfView | null) {
  if (!v) return null;
  return { trend: v.trend, atr_pct: r(v.atrPct * 100, 3), atr_pctile: r(v.atrPctile, 2), range_pos: r(v.rangePos, 2), close_vs_ema20_pct: r(((v.close - v.ema20) / v.ema20) * 100, 3) };
}

export function renderUserPrompt(ctx: MarketContext, pos: PositionSummary, brief?: Brief): string {
  const view = {
    symbol: ctx.symbol,
    regime: ctx.regime,
    trend_score: ctx.trendScore,
    timeframes: { '5m': tfSummary(ctx.tf['5m']), '15m': tfSummary(ctx.tf['15m']), '1h': tfSummary(ctx.tf['1h']), '4h': tfSummary(ctx.tf['4h']) },
    flow_usd: { cvd_1m: ctx.flow.cvd1m && r(ctx.flow.cvd1m, 0), cvd_5m: ctx.flow.cvd5m && r(ctx.flow.cvd5m, 0), cvd_15m: ctx.flow.cvd15m && r(ctx.flow.cvd15m, 0) },
    liquidations_usd_5m: { longs_flushed: r(ctx.liq.longLiqUsd5m, 0), shorts_squeezed: r(ctx.liq.shortLiqUsd5m, 0) },
    derivatives: {
      funding_rate_pct: r(ctx.derivs.fundingRate * 100, 4),
      premium_bps: r(ctx.derivs.premiumBps, 2),
      oi_change_1h_pct: ctx.derivs.oiChange1hPct === null ? null : r(ctx.derivs.oiChange1hPct * 100, 2),
      long_short_ratio: ctx.derivs.longShortRatio,
    },
    book: { spread_bps: r(ctx.book.spreadBps, 2), imbalance: r(ctx.book.imbalance, 2) },
    position: pos.state === 'FLAT' ? pos : { ...pos, unrealizedR: r(pos.unrealizedR, 2) },
    brief: brief ? { desk_mode: brief.deskMode, setup_tiers: brief.setupTiers, similar_past: brief.similarPast } : null,
  };
  return JSON.stringify(view);
}

/**
 * Ask the model for an intent. Every failure path returns the fail-closed intent:
 * stale data, timeout, bad JSON, schema violation, or an action illegal for the
 * current position state. The model is never retried inside a decision.
 */
export async function decide(ctx: MarketContext, pos: PositionSummary, ollama: OllamaOpts, now: () => number = Date.now, brief?: Brief): Promise<{ intent: Intent; meta: DecisionMeta }> {
  const inPos = pos.state === 'OPEN';
  const fallback = failClosedIntent(inPos, inPos ? pos.trailMode : undefined);
  if (ctx.quality.stale) {
    return { intent: fallback, meta: { ok: false, latencyMs: 0, error: `STALE_CONTEXT:${ctx.quality.reasons.join(',')}` } };
  }
  const started = now();
  try {
    const raw = await chatJson(ollama, SYSTEM_PROMPT, renderUserPrompt(ctx, pos, brief), INTENT_JSON_SCHEMA);
    const latencyMs = now() - started;
    const parsed = IntentSchema.safeParse(raw);
    if (!parsed.success) {
      return { intent: fallback, meta: { ok: false, latencyMs, error: `SCHEMA:${parsed.error.issues.map((i) => i.path.join('.')).join(',')}` } };
    }
    const a = parsed.data.action;
    const legal = inPos ? a === 'HOLD' || a === 'EXIT' : a === 'ENTER_LONG' || a === 'ENTER_SHORT' || a === 'NO_TRADE';
    if (!legal) return { intent: fallback, meta: { ok: false, latencyMs, error: `ILLEGAL_ACTION:${a}` } };
    return { intent: parsed.data, meta: { ok: true, latencyMs, error: null } };
  } catch (err) {
    const code = err instanceof OllamaError ? err.code : 'UNKNOWN';
    return { intent: fallback, meta: { ok: false, latencyMs: now() - started, error: `${code}:${err instanceof Error ? err.message : String(err)}` } };
  }
}

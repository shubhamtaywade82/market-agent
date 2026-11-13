import type { HarnessParams } from './types';

export interface AppConfig {
  symbols: string[];
  wsBase: string;
  restBase: string;
  ollama: { host: string; model: string; think: boolean | undefined; temperature: number; timeoutMs: number };
  /** Leverage assumed by the liquidation-buffer gate. Hard-capped at 10. */
  leverage: number;
  /** Stop distance must stay below liqBufferFrac / leverage. */
  liqBufferFrac: number;
  fees: { makerBps: number; takerBps: number };
  slippageBps: number;
  /** Liquidation notional (USD, 5m window) that flags a cascade regime. Infinity = disabled. */
  cascadeLiqUsd5m: Record<string, number>;
  stale: { markMs: number; bookMs: number };
  dataDir: string;
  /** Account equity for sizing. No default: the runner refuses to start without it. */
  equityUsd: number | null;
  /** Base risk per trade as a fraction of equity, before desk scaling. */
  riskPct: number;
  desk: DeskLimits;
  /** Hours between automatic learning steps inside the runner. 0 disables. */
  learnIntervalH: number;
  /** null = in-memory paper fills. Set PX_URL to route orders to a paper_exchange server. */
  px: PxConfig | null;
}

export interface PxConfig {
  url: string;
  apiKey: string;
  accountPrefix: string;
  /** push: this process feeds quotes and marks. autonomous: the exchange runs its own Binance feed. */
  feed: 'push' | 'autonomous';
}

export interface DeskLimits {
  /** Stop opening trades for the UTC day once the day's result reaches minus this many risk units. */
  dailyLossLimitR: number;
  /** Halve risk once drawdown from the equity peak reaches this many risk units. */
  throttleDrawdownR: number;
  /** Halt until a human resets the desk once drawdown reaches this many risk units. */
  maxDrawdownR: number;
  maxConsecLosses: number;
  cooldownMs: number;
  maxOpenPositions: number;
  maxOpenRiskUnits: number;
}

/** Starting values only. They are not calibrated; the learning pipeline is what moves them. */
export const DEFAULT_PARAMS: HarnessParams = {
  atrTrailMult: 3,
  breakevenAtR: 1,
  trailStartR: 1.5,
  minRR: 1.5,
  minStopPct: 0.002,
  maxStopPct: 0.03,
  entryTtlBars: 3,
  stopBufferAtr: 0.25,
};

export const PARAM_BOUNDS: Record<keyof HarnessParams, [number, number]> = {
  atrTrailMult: [1, 6],
  breakevenAtR: [0.5, 3],
  trailStartR: [0.5, 4],
  minRR: [1, 5],
  minStopPct: [0.001, 0.01],
  maxStopPct: [0.005, 0.05],
  entryTtlBars: [1, 12],
  stopBufferAtr: [0, 1],
};

/**
 * Credential-zero guard: this process is data-only. If anything that looks like an
 * exchange credential is in the environment, refuse to start.
 */
export function assertNoCredentials(env: NodeJS.ProcessEnv = process.env): void {
  const bad = Object.keys(env).filter((k) => /(BINANCE|COINDCX|DELTA).*(KEY|SECRET)/i.test(k));
  if (bad.length > 0) {
    throw new Error(`Refusing to start: exchange credentials present in env (${bad.join(', ')}). This process is data-only.`);
  }
}

function loadPx(env: NodeJS.ProcessEnv): PxConfig | null {
  if (!env.PX_URL) return null;
  if (!env.PAPER_EXCHANGE_API_KEY) throw new Error('PX_URL is set but PAPER_EXCHANGE_API_KEY is missing');
  const feed = env.PX_FEED ?? 'push';
  if (feed !== 'push' && feed !== 'autonomous') throw new Error(`PX_FEED must be push or autonomous, got ${feed}`);
  return { url: env.PX_URL.replace(/\/$/, ''), apiKey: env.PAPER_EXCHANGE_API_KEY, accountPrefix: env.PX_ACCOUNT_PREFIX ?? 'market-agent', feed };
}

function num(env: NodeJS.ProcessEnv, key: string, dflt: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return dflt;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`Config ${key} is not a number: ${raw}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const symbols = (env.SYMBOLS ?? 'SOLUSDT,ETHUSDT,XRPUSDT')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (symbols.length === 0) throw new Error('SYMBOLS is empty');

  const leverage = num(env, 'LEVERAGE', 5);
  if (leverage < 1 || leverage > 10) throw new Error(`LEVERAGE must be within 1..10, got ${leverage}`);

  const cascade: Record<string, number> = {};
  for (const s of symbols) cascade[s] = num(env, `CASCADE_LIQ_USD_5M_${s}`, Number.POSITIVE_INFINITY);

  const thinkRaw = env.OLLAMA_THINK;
  return {
    symbols,
    wsBase: env.BINANCE_WS_BASE ?? 'wss://fstream.binance.com',
    restBase: env.BINANCE_REST_BASE ?? 'https://fapi.binance.com',
    ollama: {
      host: env.OLLAMA_HOST ?? 'http://127.0.0.1:11434',
      model: env.OLLAMA_MODEL ?? 'openbmb/minicpm5-2b',
      think: thinkRaw === undefined ? undefined : thinkRaw === 'true',
      temperature: num(env, 'OLLAMA_TEMPERATURE', 0.2),
      timeoutMs: num(env, 'OLLAMA_TIMEOUT_MS', 20_000),
    },
    leverage,
    liqBufferFrac: num(env, 'LIQ_BUFFER_FRAC', 0.5),
    fees: { makerBps: num(env, 'MAKER_BPS', 2), takerBps: num(env, 'TAKER_BPS', 5) },
    slippageBps: num(env, 'SLIPPAGE_BPS', 2),
    cascadeLiqUsd5m: cascade,
    stale: { markMs: num(env, 'STALE_MARK_MS', 5_000), bookMs: num(env, 'STALE_BOOK_MS', 15_000) },
    dataDir: env.DATA_DIR ?? './data',
    equityUsd: env.EQUITY_USD === undefined || env.EQUITY_USD === '' ? null : num(env, 'EQUITY_USD', 0),
    riskPct: num(env, 'RISK_PCT', 0.005),
    desk: {
      dailyLossLimitR: num(env, 'DESK_DAILY_LOSS_R', 3),
      throttleDrawdownR: num(env, 'DESK_THROTTLE_DD_R', 5),
      maxDrawdownR: num(env, 'DESK_MAX_DD_R', 10),
      maxConsecLosses: num(env, 'DESK_MAX_CONSEC_LOSSES', 3),
      cooldownMs: num(env, 'DESK_COOLDOWN_MIN', 240) * 60_000,
      maxOpenPositions: num(env, 'DESK_MAX_POSITIONS', 2),
      maxOpenRiskUnits: num(env, 'DESK_MAX_OPEN_RISK', 2),
    },
    learnIntervalH: num(env, 'LEARN_INTERVAL_H', 24),
    px: loadPx(env),
  };
}

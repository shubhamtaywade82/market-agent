export const TFS = ['1m', '5m', '15m', '1h', '4h'] as const;
export type Tf = (typeof TFS)[number];
export const TF_MS: Record<Tf, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
};

/** t = open time (ms), q = quote volume, tbq = taker-buy quote volume, x = closed. */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  q: number;
  tbq: number;
  x: boolean;
}

export type MarketEvent =
  | { type: 'aggTrade'; symbol: string; id: number; price: number; qty: number; ts: number; buyerIsMaker: boolean }
  | { type: 'kline'; symbol: string; tf: Tf; candle: Candle; ts: number }
  | { type: 'markPrice'; symbol: string; mark: number; index: number; funding: number; nextFundingTs: number; ts: number }
  | { type: 'bookTicker'; symbol: string; bid: number; bidQty: number; ask: number; askQty: number; ts: number }
  | { type: 'liquidation'; symbol: string; side: 'BUY' | 'SELL'; price: number; qty: number; ts: number }
  | { type: 'derivs'; symbol: string; oiChange1hPct: number | null; longShortRatio: number | null; ts: number };

export type Trend = 'UP' | 'DOWN' | 'FLAT';

export interface TfView {
  trend: Trend;
  close: number;
  ema20: number;
  ema50: number;
  atr: number;
  atrPct: number;
  /** Percentile rank (0..1) of current ATR% within the last 100 closed bars. */
  atrPctile: number;
  /** Position of close inside the 50-bar high/low range, 0..1. */
  rangePos: number;
  swingLow: number | null;
  swingHigh: number | null;
}

export interface MarketContext {
  symbol: string;
  ts: number;
  mark: number;
  bid: number;
  ask: number;
  tf: Record<Tf, TfView | null>;
  flow: { cvd1m: number | null; cvd5m: number | null; cvd15m: number | null };
  liq: { longLiqUsd5m: number; shortLiqUsd5m: number };
  derivs: { fundingRate: number; premiumBps: number; oiChange1hPct: number | null; longShortRatio: number | null };
  book: { spreadBps: number; imbalance: number };
  trendScore: number;
  regime: string;
  quality: { stale: boolean; reasons: string[] };
}

export type Side = 'LONG' | 'SHORT';
export type TrailMode = 'ATR_CHANDELIER' | 'STRUCTURE' | 'BREAKEVEN_THEN_ATR';
export type TargetBand = 'P1_3' | 'P3_6' | 'P6_10';
export const BAND: Record<TargetBand, { min: number; max: number }> = {
  P1_3: { min: 0.01, max: 0.03 },
  P3_6: { min: 0.03, max: 0.06 },
  P6_10: { min: 0.06, max: 0.1 },
};

export interface HarnessParams {
  atrTrailMult: number;
  breakevenAtR: number;
  trailStartR: number;
  minRR: number;
  minStopPct: number;
  maxStopPct: number;
  entryTtlBars: number;
  stopBufferAtr: number;
}

export interface Harness {
  id: string;
  parentId: string | null;
  depth: number;
  status: 'ACTIVE' | 'CANDIDATE' | 'RETIRED';
  createdTs: number;
  params: HarnessParams;
  /** Disabled `${regime}|${setup}` buckets. */
  disabled: string[];
}

export interface OrderPlan {
  symbol: string;
  side: Side;
  entry: number;
  stop: number;
  stopPct: number;
  trailMode: TrailMode;
  band: TargetBand;
  ttlBars: number;
  /** Set by the risk desk. riskFrac scales base risk; qty is 0 until sized. */
  riskFrac: number;
  qty: number;
  intentId: string;
}

export type JournalRecord =
  | {
      kind: 'INTENT';
      ts: number;
      symbol: string;
      harnessId: string;
      regime: string;
      setup: string;
      action: string;
      accepted: boolean;
      rejectReason: string | null;
      llm: { ok: boolean; latencyMs: number; error: string | null };
      ctx: MarketContext;
      intentId?: string;
    }
  | { kind: 'UNFILLED'; ts: number; symbol: string; harnessId: string; regime: string; setup: string; reason: 'TTL' | 'CANCELLED' | 'REJECTED'; intentId?: string }
  | {
      kind: 'TRADE';
      ts: number;
      symbol: string;
      harnessId: string;
      regime: string;
      setup: string;
      side: Side;
      entry: number;
      exit: number;
      initialStop: number;
      r: number;
      mfeR: number;
      maeR: number;
      bars: number;
      exitReason: 'STOP' | 'TRAIL' | 'LLM_EXIT' | 'KILL';
      intentId?: string;
      /** Fraction of base risk this trade carried; desk accounting uses r * riskFrac. */
      riskFrac?: number;
      qty?: number;
      pnlUsd?: number;
    };

export interface JournalSink {
  append(rec: JournalRecord): void;
}

export type Logger = (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;
export const jsonLogger: Logger = (level, msg, fields = {}) => {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }) + '\n');
};

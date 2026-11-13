import type { Candle, Logger, MarketEvent, Tf } from '../types';

export type FetchFn = typeof fetch;

/** GET with timeout and bounded retry. 418 (IP ban) and other 4xx are not retried. */
export async function getJson(url: string, fetchFn: FetchFn = fetch, log?: Logger, retries = 3): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetchFn(url, { signal: ctrl.signal });
      if (res.ok) return await res.json();
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after') ?? '0');
        lastErr = new Error(`HTTP ${res.status} for ${url}`);
        await sleep(Math.max(retryAfter * 1000, 500 * 2 ** attempt));
        continue;
      }
      throw new FatalHttpError(res.status, url);
    } catch (err) {
      if (err instanceof FatalHttpError) throw err;
      lastErr = err;
      log?.('warn', 'rest_retry', { url, attempt, error: String(err) });
      await sleep(500 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export class FatalHttpError extends Error {
  constructor(public readonly status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function n(v: unknown, field: string): number {
  const x = Number(v);
  if (!Number.isFinite(x)) throw new Error(`Non-numeric ${field}: ${String(v)}`);
  return x;
}

/** GET /fapi/v1/klines. The final row is the forming candle; it is marked open by close time. */
export async function fetchKlines(restBase: string, symbol: string, tf: Tf, limit: number, now: number, fetchFn: FetchFn = fetch, log?: Logger): Promise<Candle[]> {
  const rows = await getJson(`${restBase}/fapi/v1/klines?symbol=${symbol}&interval=${tf}&limit=${limit}`, fetchFn, log);
  if (!Array.isArray(rows)) throw new Error('klines: expected array');
  return rows.map((r: unknown) => {
    if (!Array.isArray(r) || r.length < 11) throw new Error('klines: malformed row');
    return {
      t: n(r[0], 'openTime'),
      o: n(r[1], 'open'),
      h: n(r[2], 'high'),
      l: n(r[3], 'low'),
      c: n(r[4], 'close'),
      v: n(r[5], 'volume'),
      q: n(r[7], 'quoteVolume'),
      tbq: n(r[10], 'takerBuyQuote'),
      x: n(r[6], 'closeTime') < now,
    };
  });
}

export interface SymbolFilters {
  tickSize: number;
  stepSize: number;
  minQty: number;
}

/** GET /fapi/v1/exchangeInfo -> PRICE_FILTER.tickSize and LOT_SIZE.stepSize/minQty per symbol. */
export async function fetchSymbolFilters(restBase: string, symbols: string[], fetchFn: FetchFn = fetch, log?: Logger): Promise<Record<string, SymbolFilters>> {
  type Filter = { filterType: string; tickSize?: string; stepSize?: string; minQty?: string };
  const info = (await getJson(`${restBase}/fapi/v1/exchangeInfo`, fetchFn, log)) as { symbols?: Array<{ symbol: string; filters: Filter[] }> };
  const out: Record<string, SymbolFilters> = {};
  for (const sym of symbols) {
    const row = info.symbols?.find((s) => s.symbol === sym);
    const price = row?.filters.find((f) => f.filterType === 'PRICE_FILTER');
    const lot = row?.filters.find((f) => f.filterType === 'LOT_SIZE');
    if (price?.tickSize === undefined || lot?.stepSize === undefined || lot?.minQty === undefined) {
      throw new Error(`exchangeInfo: missing PRICE_FILTER/LOT_SIZE for ${sym}`);
    }
    const f = { tickSize: n(price.tickSize, 'tickSize'), stepSize: n(lot.stepSize, 'stepSize'), minQty: n(lot.minQty, 'minQty') };
    if (!(f.tickSize > 0) || !(f.stepSize > 0)) throw new Error(`exchangeInfo: non-positive filter for ${sym}`);
    out[sym] = f;
  }
  return out;
}

/** Positioning snapshot from /futures/data/* (5m period; these endpoints keep limited history). */
export async function fetchDerivs(restBase: string, symbol: string, now: number, fetchFn: FetchFn = fetch, log?: Logger): Promise<MarketEvent> {
  let oiChange1hPct: number | null = null;
  let longShortRatio: number | null = null;
  try {
    const oi = await getJson(`${restBase}/futures/data/openInterestHist?symbol=${symbol}&period=5m&limit=13`, fetchFn, log, 1);
    if (Array.isArray(oi) && oi.length >= 2) {
      const first = n((oi[0] as Record<string, unknown>).sumOpenInterest, 'sumOpenInterest');
      const last = n((oi[oi.length - 1] as Record<string, unknown>).sumOpenInterest, 'sumOpenInterest');
      if (first > 0) oiChange1hPct = (last - first) / first;
    }
    const ls = await getJson(`${restBase}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=1`, fetchFn, log, 1);
    if (Array.isArray(ls) && ls.length > 0) longShortRatio = n((ls[ls.length - 1] as Record<string, unknown>).longShortRatio, 'longShortRatio');
  } catch (err) {
    log?.('warn', 'derivs_fetch_failed', { symbol, error: String(err) });
  }
  return { type: 'derivs', symbol, oiChange1hPct, longShortRatio, ts: now };
}

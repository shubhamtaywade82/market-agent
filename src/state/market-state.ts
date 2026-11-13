import { TFS, TF_MS, type Candle, type MarketEvent, type Tf } from '../types';

const FLOW_KEEP_MS = 16 * 60_000;

interface FlowBucket {
  sec: number;
  buyQuote: number;
  sellQuote: number;
}
interface Liq {
  ts: number;
  side: 'BUY' | 'SELL';
  notional: number;
}

/** Per-symbol state. All mutation goes through MarketState.apply, which is idempotent per event. */
export class SymbolState {
  candles: Record<Tf, Candle[]> = { '1m': [], '5m': [], '15m': [], '1h': [], '4h': [] };
  candleGap: Record<Tf, boolean> = { '1m': false, '5m': false, '15m': false, '1h': false, '4h': false };
  lastAggId = -1;
  /** Flow windows are only trustworthy from this timestamp (first trade seen, or last id gap). */
  flowValidFrom: number | null = null;
  flow: FlowBucket[] = [];
  liqs: Liq[] = [];
  mark = 0;
  index = 0;
  funding = 0;
  nextFundingTs = 0;
  bid = 0;
  ask = 0;
  bidQty = 0;
  askQty = 0;
  oiChange1hPct: number | null = null;
  longShortRatio: number | null = null;
  lastMarkTs = 0;
  lastBookTs = 0;
  dropped = { dupTrade: 0, oldKline: 0, dupLiq: 0 };
  private liqKeys = new Set<string>();

  constructor(readonly symbol: string, private readonly maxCandles: number) {}

  closed(tf: Tf): Candle[] {
    return this.candles[tf].filter((c) => c.x);
  }

  /** Replace a timeframe from a REST backfill and clear its gap flag. */
  seed(tf: Tf, candles: Candle[]): void {
    const sorted = [...candles].sort((a, b) => a.t - b.t);
    this.candles[tf] = sorted.slice(-this.maxCandles);
    this.candleGap[tf] = false;
  }

  /** Signed taker quote volume over the window, or null when the window is not fully covered. */
  cvd(windowMs: number, now: number): number | null {
    if (this.flowValidFrom === null || now - windowMs < this.flowValidFrom) return null;
    const fromSec = Math.floor((now - windowMs) / 1000);
    let sum = 0;
    for (const b of this.flow) if (b.sec > fromSec) sum += b.buyQuote - b.sellQuote;
    return sum;
  }

  /** SELL-side forced orders close longs; BUY-side close shorts. */
  liqNotional(windowMs: number, now: number): { long: number; short: number } {
    let long = 0;
    let short = 0;
    for (const l of this.liqs) {
      if (l.ts <= now - windowMs) continue;
      if (l.side === 'SELL') long += l.notional;
      else short += l.notional;
    }
    return { long, short };
  }

  applyAggTrade(ev: Extract<MarketEvent, { type: 'aggTrade' }>): boolean {
    if (ev.id <= this.lastAggId) {
      this.dropped.dupTrade += 1;
      return false;
    }
    if (this.flowValidFrom === null) this.flowValidFrom = ev.ts;
    else if (ev.id > this.lastAggId + 1) this.flowValidFrom = ev.ts; // id gap: trades were missed
    this.lastAggId = ev.id;

    const sec = Math.floor(ev.ts / 1000);
    const quote = ev.price * ev.qty;
    let b = this.flow[this.flow.length - 1];
    if (!b || b.sec !== sec) {
      b = { sec, buyQuote: 0, sellQuote: 0 };
      this.flow.push(b);
      const minSec = Math.floor((ev.ts - FLOW_KEEP_MS) / 1000);
      while (this.flow.length > 0 && this.flow[0]!.sec < minSec) this.flow.shift();
    }
    if (ev.buyerIsMaker) b.sellQuote += quote;
    else b.buyQuote += quote;
    return true;
  }

  /** Returns false for stale or duplicate updates, so a bar close is acted on exactly once. */
  applyKline(tf: Tf, c: Candle): boolean {
    const arr = this.candles[tf];
    const last = arr[arr.length - 1];
    if (!last || c.t > last.t) {
      if (last && (c.t - last.t > TF_MS[tf] || !last.x)) this.candleGap[tf] = true; // a close was missed
      arr.push(c);
      if (arr.length > this.maxCandles) arr.shift();
      return true;
    }
    if (c.t === last.t && !last.x) {
      arr[arr.length - 1] = c;
      return true;
    }
    this.dropped.oldKline += 1; // older bar, or a repeat of an already-closed bar
    return false;
  }

  applyLiquidation(ev: Extract<MarketEvent, { type: 'liquidation' }>): void {
    const key = `${ev.ts}|${ev.side}|${ev.price}|${ev.qty}`;
    if (this.liqKeys.has(key)) {
      this.dropped.dupLiq += 1;
      return;
    }
    this.liqKeys.add(key);
    this.liqs.push({ ts: ev.ts, side: ev.side, notional: ev.price * ev.qty });
    while (this.liqs.length > 0 && this.liqs[0]!.ts < ev.ts - FLOW_KEEP_MS) {
      const old = this.liqs.shift()!;
      for (const k of this.liqKeys) {
        if (k.startsWith(`${old.ts}|`)) this.liqKeys.delete(k);
      }
    }
  }
}

export class MarketState {
  private readonly bySymbol = new Map<string, SymbolState>();

  constructor(symbols: string[], maxCandles = 500) {
    for (const s of symbols) this.bySymbol.set(s, new SymbolState(s, maxCandles));
  }

  get(symbol: string): SymbolState {
    const s = this.bySymbol.get(symbol);
    if (!s) throw new Error(`Unknown symbol ${symbol}`);
    return s;
  }

  has(symbol: string): boolean {
    return this.bySymbol.has(symbol);
  }

  /** Returns false when the event was a duplicate or for an untracked symbol. */
  apply(ev: MarketEvent): boolean {
    const s = this.bySymbol.get(ev.symbol);
    if (!s) return false;
    switch (ev.type) {
      case 'aggTrade':
        return s.applyAggTrade(ev);
      case 'kline':
        return s.applyKline(ev.tf, ev.candle);
      case 'markPrice':
        if (ev.ts < s.lastMarkTs) return false;
        s.mark = ev.mark;
        s.index = ev.index;
        s.funding = ev.funding;
        s.nextFundingTs = ev.nextFundingTs;
        s.lastMarkTs = ev.ts;
        return true;
      case 'bookTicker':
        if (ev.ts < s.lastBookTs) return false;
        s.bid = ev.bid;
        s.ask = ev.ask;
        s.bidQty = ev.bidQty;
        s.askQty = ev.askQty;
        s.lastBookTs = ev.ts;
        return true;
      case 'liquidation':
        s.applyLiquidation(ev);
        return true;
      case 'derivs':
        s.oiChange1hPct = ev.oiChange1hPct;
        s.longShortRatio = ev.longShortRatio;
        return true;
    }
  }

  gaps(): Array<{ symbol: string; tf: Tf }> {
    const out: Array<{ symbol: string; tf: Tf }> = [];
    for (const s of this.bySymbol.values()) for (const tf of TFS) if (s.candleGap[tf]) out.push({ symbol: s.symbol, tf });
    return out;
  }
}

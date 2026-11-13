/**
 * Client for the paper_exchange REST API (github.com/shubhamtaywade82/paper_exchange).
 * Written from its controllers: X-API-Key authenticates, X-Account-Id selects the account,
 * a limit order is order_type "bounded", decimals arrive as strings.
 */
export class PxError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
  /** The exchange understood the request and refused it; retrying the same request cannot help. */
  get refused(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}

export interface PxOrder {
  id: number;
  clientOrderId: string | null;
  symbol: string;
  status: 'pending' | 'open' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected' | 'expired';
  quantity: number;
  filledQuantity: number;
}
export interface PxPosition {
  id: number;
  symbol: string;
  side: 'long' | 'short';
  quantity: number;
  averagePrice: number;
}
export interface PxProtection {
  id: number;
  status: string;
  triggerPrice: number | null;
}
export interface PxFill {
  orderId: number;
  positionId: number | null;
  price: number;
  quantity: number;
  charges: number;
  ts: number;
}
export interface PxOrderRequest {
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  orderType: 'market' | 'bounded';
  price?: number;
  leverage: number;
  clientOrderId: string;
  reduceOnly?: boolean;
  executionPrice?: number;
}

const dec = (v: unknown, field: string): number => {
  const x = Number(v);
  if (v === null || v === undefined || v === '' || !Number.isFinite(x)) throw new PxError(502, `paper_exchange: non-numeric ${field}: ${String(v)}`);
  return x;
};
type Row = Record<string, unknown>;

export class PxClient {
  constructor(private readonly o: { url: string; apiKey: string; accountId: string; fetchFn?: typeof fetch; timeoutMs?: number }) {}

  get accountId(): string {
    return this.o.accountId;
  }

  private async req(method: string, path: string, body?: unknown): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? 5_000);
    let res: Response;
    try {
      res = await (this.o.fetchFn ?? fetch)(`${this.o.url}${path}`, {
        method,
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': this.o.apiKey, 'x-account-id': this.o.accountId },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new PxError(0, `paper_exchange unreachable (${method} ${path}): ${String(err)}`);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok) throw new PxError(res.status, `paper_exchange ${method} ${path} -> ${res.status}: ${(json as Row | null)?.error ?? text.slice(0, 200)}`);
    return json;
  }

  private static order(r: Row): PxOrder {
    return { id: dec(r.id, 'order.id'), clientOrderId: (r.client_order_id as string | null) ?? null, symbol: String(r.symbol), status: r.status as PxOrder['status'], quantity: dec(r.quantity, 'order.quantity'), filledQuantity: dec(r.filled_quantity ?? 0, 'order.filled_quantity') };
  }
  private static protection(r: Row): PxProtection {
    return { id: dec(r.id, 'protection.id'), status: String(r.status), triggerPrice: r.trigger_price === null || r.trigger_price === undefined ? null : dec(r.trigger_price, 'protection.trigger_price') };
  }

  async equity(): Promise<number> {
    return dec(((await this.req('GET', '/api/account')) as Row).equity, 'account.equity');
  }

  /** Accounts are created by POST /api/account/reset, which the server allows in development only. */
  async ensureAccount(margin: number): Promise<number> {
    try {
      return await this.equity();
    } catch (err) {
      if (!(err instanceof PxError) || err.status !== 404) throw err;
    }
    await this.req('POST', '/api/account/reset', { margin });
    return this.equity();
  }

  /** Idempotent on clientOrderId: the server returns the existing order for a repeated id. */
  async createOrder(o: PxOrderRequest): Promise<PxOrder> {
    const body: Row = { symbol: o.symbol, side: o.side, quantity: o.quantity, order_type: o.orderType, instrument_type: 'CRYPTO_PERPETUAL', leverage: o.leverage, margin_type: 'isolated', client_order_id: o.clientOrderId };
    if (o.price !== undefined) body.price = o.price;
    if (o.reduceOnly) body.reduce_only = true;
    if (o.executionPrice !== undefined) body.execution_price = o.executionPrice;
    return PxClient.order((await this.req('POST', '/api/orders', body)) as Row);
  }
  async getOrder(id: number): Promise<PxOrder> {
    return PxClient.order((await this.req('GET', `/api/orders/${id}`)) as Row);
  }
  async cancelOrder(id: number): Promise<PxOrder> {
    return PxClient.order((await this.req('DELETE', `/api/orders/${id}`)) as Row);
  }

  async positions(): Promise<PxPosition[]> {
    const rows = (await this.req('GET', '/api/positions')) as Row[];
    return rows
      .map((r) => ({ id: dec(r.id, 'position.id'), symbol: String(r.symbol), side: r.side as 'long' | 'short', quantity: dec(r.quantity, 'position.quantity'), averagePrice: dec(r.average_price ?? 0, 'position.average_price') }))
      .filter((p) => p.quantity > 0);
  }

  async createStop(positionId: number, triggerPrice: number, quantity: number): Promise<PxProtection> {
    return PxClient.protection((await this.req('POST', `/api/positions/${positionId}/protections`, { protection: { protection_type: 'stop_loss', trigger_price: triggerPrice, quantity } })) as Row);
  }
  async cancelProtection(positionId: number, id: number): Promise<void> {
    await this.req('DELETE', `/api/positions/${positionId}/protections/${id}`);
  }
  async activeProtections(positionId: number): Promise<PxProtection[]> {
    return ((await this.req('GET', `/api/positions/${positionId}/protections`)) as Row[]).map(PxClient.protection).filter((p) => p.status === 'active');
  }

  /** TRADE ledger rows at or after sinceTs, newest first. Walks at most maxPages pages. */
  async fillsSince(sinceTs: number, maxPages = 5): Promise<PxFill[]> {
    const out: PxFill[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const res = (await this.req('GET', `/api/ledger?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)) as { data: Row[]; next_cursor: string | null };
      let reachedOlder = false;
      for (const e of res.data) {
        const ts = Date.parse(String(e.occurred_at));
        if (ts < sinceTs) {
          reachedOlder = true;
          continue;
        }
        if (e.event_type !== 'TRADE') continue;
        const p = (e.payload ?? {}) as Row;
        out.push({ orderId: dec(p.order_id, 'ledger.order_id'), positionId: p.position_id === null || p.position_id === undefined ? null : dec(p.position_id, 'ledger.position_id'), price: dec(p.price, 'ledger.price'), quantity: dec(p.quantity, 'ledger.quantity'), charges: dec(p.charges ?? 0, 'ledger.charges'), ts });
      }
      if (reachedOlder || !res.next_cursor) break;
      cursor = res.next_cursor;
    }
    return out;
  }

  /** Push-mode feed: quotes drive the matching worker, marks drive protections and liquidation. */
  async pushQuotes(quotes: Array<{ symbol: string; bid: number; ask: number; mark: number; ts: number }>): Promise<void> {
    if (quotes.length === 0) return;
    await this.req('POST', '/api/market_events', { events: quotes.map((q) => ({ symbol: q.symbol, bid: q.bid, ask: q.ask, ltp: (q.bid + q.ask) / 2, timestamp: new Date(q.ts).toISOString(), source: 'binance_usdm' })) });
    await this.req('POST', '/api/mark_prices', { prices: Object.fromEntries(quotes.map((q) => [q.symbol, String(q.mark)])) });
  }
}

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { PxClient, PxError } from '../src/exchange/px-client';
import { RemoteExecutor } from '../src/exchange/remote-executor';
import { buildContext } from '../src/features/context';
import { MemoryJournal } from '../src/journal/journal';
import type { OrderPlan } from '../src/types';
import { CTX_OPTS, harness, NOW, seededState } from './helpers';

type Row = Record<string, unknown>;

/** In-memory stand-in for the paper_exchange REST API, shaped after its controllers. */
class FakePx {
  orders: Row[] = [];
  positions: Row[] = [];
  protections: Row[] = [];
  ledger: Row[] = [];
  account: Row | null = { equity: '5000.0' };
  calls: string[] = [];
  down = false;
  failProtections = false;
  private seq = 0;

  fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Row) : {};
    this.calls.push(`${method} ${u.pathname}`);
    if (this.down) throw new Error('ECONNREFUSED');
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
    const headers = init?.headers as Record<string, string>;
    if (headers['x-api-key'] !== 'key') return json(401, { error: 'Missing or invalid API key' });
    const path = u.pathname;
    let m: RegExpMatchArray | null;

    if (path === '/api/account') return this.account ? json(200, this.account) : json(404, { error: 'Account not found' });
    if (path === '/api/account/reset') return (this.account = { equity: String(body.margin) }), json(200, { status: 'reset_complete' });
    if (path === '/api/orders' && method === 'POST') {
      const dup = this.orders.find((o) => o.client_order_id === body.client_order_id);
      if (dup) return json(201, dup);
      if (Number(body.quantity) > 1000) return json(422, { error: '[:MARGIN_REJECTED]' });
      const order: Row = { id: ++this.seq, client_order_id: body.client_order_id, symbol: body.symbol, side: body.side, quantity: String(body.quantity), filled_quantity: '0.0', status: 'open', price: body.price ?? null, order_type: body.order_type, reduce_only: body.reduce_only ?? false, execution_price: body.execution_price };
      this.orders.push(order);
      if (body.order_type === 'market' && body.reduce_only) this.closePosition(String(body.symbol), Number(body.execution_price ?? 0), order);
      return json(201, order);
    }
    if ((m = path.match(/^\/api\/orders\/(\d+)$/))) {
      const order = this.orders.find((o) => o.id === Number(m![1]));
      if (!order) return json(404, { error: 'Order not found' });
      if (method === 'DELETE') {
        if (order.status !== 'open' && order.status !== 'partially_filled') return json(409, { error: 'cannot cancel' });
        order.status = 'cancelled';
      }
      return json(200, order);
    }
    if (path === '/api/positions') return json(200, this.positions);
    if ((m = path.match(/^\/api\/positions\/(\d+)\/protections$/))) {
      if (this.failProtections) return json(500, { error: 'Internal error' });
      const pid = Number(m[1]);
      if (method === 'POST') {
        const p = body.protection as Row;
        const prot: Row = { id: ++this.seq, position_id: pid, protection_type: p.protection_type, trigger_price: String(p.trigger_price), quantity: String(p.quantity), status: 'active' };
        this.protections.push(prot);
        return json(201, prot);
      }
      return json(200, this.protections.filter((p) => p.position_id === pid));
    }
    if ((m = path.match(/^\/api\/positions\/(\d+)\/protections\/(\d+)$/))) {
      const prot = this.protections.find((p) => p.id === Number(m![2]))!;
      prot.status = 'cancelled';
      return json(200, prot);
    }
    if (path === '/api/ledger') return json(200, { data: [...this.ledger].reverse(), next_cursor: null });
    if (path === '/api/market_events' || path === '/api/mark_prices') return json(201, { accepted: 1, body });
    return json(404, { error: 'no route' });
  }) as typeof fetch;

  private trade(order: Row, positionId: number, price: number, qty: number, charges: number) {
    this.ledger.push({ id: ++this.seq, event_type: 'FEE', payload: {}, occurred_at: new Date().toISOString() });
    this.ledger.push({ id: ++this.seq, event_type: 'TRADE', payload: { order_id: order.id, position_id: positionId, price: String(price), quantity: String(qty), charges: String(charges) }, occurred_at: new Date().toISOString() });
  }
  /** The matching worker fills a resting order. */
  fill(orderId: number, price: number, qty?: number) {
    const order = this.orders.find((o) => o.id === orderId)!;
    const q = qty ?? Number(order.quantity);
    order.filled_quantity = String(q);
    order.status = q < Number(order.quantity) ? 'partially_filled' : 'filled';
    const pos: Row = { id: ++this.seq, symbol: order.symbol, side: order.side === 'buy' ? 'long' : 'short', quantity: String(q), average_price: String(price) };
    this.positions.push(pos);
    this.trade(order, Number(pos.id), price, q, 0.2);
    return pos;
  }
  closePosition(symbol: string, price: number, order: Row) {
    const pos = this.positions.find((p) => p.symbol === symbol && Number(p.quantity) > 0);
    if (!pos) return;
    this.trade(order, Number(pos.id), price, Number(pos.quantity), 0.5);
    pos.quantity = '0.0'; // the row stays, as a flat position
    order.status = 'filled';
  }
  /** ProtectionMonitorJob fires the active stop at the mark price. */
  triggerStop(symbol: string, markPrice: number) {
    const pos = this.positions.find((p) => p.symbol === symbol && Number(p.quantity) > 0)!;
    const prot = this.protections.find((p) => p.position_id === pos.id && p.status === 'active')!;
    prot.status = 'triggered';
    const order: Row = { id: ++this.seq, client_order_id: `protection-${prot.id}`, symbol, status: 'open', quantity: pos.quantity, filled_quantity: pos.quantity };
    this.orders.push(order);
    this.closePosition(symbol, markPrice, order);
  }
}

const plan: OrderPlan = { symbol: 'SOLUSDT', side: 'LONG', entry: 100, stop: 99, stopPct: 0.01, trailMode: 'BREAKEVEN_THEN_ATR', band: 'P3_6', ttlBars: 2, riskFrac: 1, qty: 10, intentId: 'h0:SOLUSDT:1' };
const ctx = buildContext(seededState(0.05).s, NOW, CTX_OPTS);

function setup(statePath = join(mkdtempSync(join(tmpdir(), 'rx-')), 'exec.json'), px = new FakePx(), journal = new MemoryJournal()) {
  const logs: Array<{ level: string; msg: string }> = [];
  const client = new PxClient({ url: 'http://px', apiKey: 'key', accountId: 'market-agent-h0', fetchFn: px.fetch });
  const exec = new RemoteExecutor(harness(), client, journal, (level, msg) => logs.push({ level, msg }), { leverage: 5, statePath, pinExitPrice: true, breakevenBufferPct: 0.0007, maxUnprotectedMs: 10_000 });
  const tick = async (now = Date.now()) => {
    await exec.reconcile(now);
    await exec.idle();
  };
  return { px, journal, exec, client, logs, statePath, tick };
}
async function openLong(t: ReturnType<typeof setup>) {
  expect(t.exec.submit(plan, 'TREND_UP_NORMAL', 'TREND_PULLBACK')).toBe(true);
  await t.exec.idle();
  t.px.fill(1, 99.98);
  await t.tick();
}

describe('paper_exchange client', () => {
  it('sends auth and account headers and surfaces refusals', async () => {
    const px = new FakePx();
    const bad = new PxClient({ url: 'http://px', apiKey: 'wrong', accountId: 'a', fetchFn: px.fetch });
    await expect(bad.equity()).rejects.toMatchObject({ status: 401, refused: true });
    px.down = true;
    const err = await new PxClient({ url: 'http://px', apiKey: 'key', accountId: 'a', fetchFn: px.fetch }).equity().catch((e) => e);
    expect(err).toBeInstanceOf(PxError);
    expect(err.refused).toBe(false);
  });
  it('creates a missing account through the reset endpoint', async () => {
    const t = setup();
    t.px.account = null;
    expect(await t.client.ensureAccount(2500)).toBe(2500);
    expect(t.px.calls).toEqual(['GET /api/account', 'POST /api/account/reset', 'GET /api/account']);
  });
  it('reads PX settings and demands the API key', () => {
    expect(loadConfig({}).px).toBeNull();
    expect(() => loadConfig({ PX_URL: 'http://localhost:3100' })).toThrow(/PAPER_EXCHANGE_API_KEY/);
    expect(loadConfig({ PX_URL: 'http://localhost:3100/', PAPER_EXCHANGE_API_KEY: 'k', PX_FEED: 'autonomous' }).px).toEqual({ url: 'http://localhost:3100', apiKey: 'k', accountPrefix: 'market-agent', feed: 'autonomous' });
  });
});

describe('remote executor', () => {
  it('rests a bounded limit order with an idempotent client id', async () => {
    const t = setup();
    expect(t.exec.submit(plan, 'R', 'S')).toBe(true);
    expect(t.exec.submit(plan, 'R', 'S')).toBe(false);
    await t.exec.idle();
    expect(t.px.orders[0]).toMatchObject({ order_type: 'bounded', side: 'buy', price: 100, quantity: '10', client_order_id: 'entry-h0_SOLUSDT_1', status: 'open' });
    expect(t.exec.state('SOLUSDT').s).toBe('ENTRY_PENDING');
    expect(t.exec.exposure()).toEqual({ positions: 1, riskUnits: 1 });
  });
  it('places the stop on the exchange as soon as the fill is seen', async () => {
    const t = setup();
    await openLong(t);
    const st = t.exec.state('SOLUSDT');
    expect(st.s === 'OPEN' && st.pos).toMatchObject({ entry: 99.98, stop: 99, initialStop: 99 });
    expect(t.px.protections).toMatchObject([{ protection_type: 'stop_loss', trigger_price: '99', quantity: '10', status: 'active' }]);
    await t.tick();
    expect(t.px.protections).toHaveLength(1); // reconcile does not stack duplicate stops
  });
  it('journals a stop-out with the real fill price and fees from the ledger', async () => {
    const t = setup();
    await openLong(t);
    t.px.triggerStop('SOLUSDT', 98.9);
    await t.tick();
    expect(t.exec.state('SOLUSDT').s).toBe('IDLE');
    const rec = t.journal.records[0]!;
    expect(rec).toMatchObject({ kind: 'TRADE', exitReason: 'STOP', entry: 99.98, exit: 98.9, qty: 10, intentId: 'h0:SOLUSDT:1' });
    if (rec.kind === 'TRADE') {
      expect(rec.pnlUsd).toBeCloseTo((98.9 - 99.98) * 10 - 0.7, 6);
      expect(rec.r).toBeCloseTo(rec.pnlUsd! / (0.98 * 10), 6);
    }
  });
  it('trails by placing the new stop before cancelling the old one', async () => {
    const t = setup();
    await openLong(t);
    t.exec.onTrade('SOLUSDT', 104);
    t.exec.onBarClose('SOLUSDT', ctx);
    await t.exec.idle();
    const st = t.exec.state('SOLUSDT');
    expect(st.s === 'OPEN' && st.pos.stop).toBeGreaterThan(100);
    expect(t.px.protections.map((p) => p.status)).toEqual(['cancelled', 'active']);
    const order = t.px.calls.filter((c) => c.includes('/protections'));
    expect(order.lastIndexOf('POST /api/positions/2/protections')).toBeLessThan(order.findIndex((c) => c.startsWith('DELETE')));
    expect(t.exec.exposure().riskUnits).toBe(0); // stop beyond entry: risk freed
    t.px.triggerStop('SOLUSDT', 100.5);
    await t.tick();
    expect(t.journal.records[0]).toMatchObject({ kind: 'TRADE', exitReason: 'TRAIL', bars: 1 });
  });
  it('cancels an unfilled entry after its TTL', async () => {
    const t = setup();
    t.exec.submit(plan, 'R', 'S');
    await t.exec.idle();
    t.exec.onBarClose('SOLUSDT', ctx);
    t.exec.onBarClose('SOLUSDT', ctx);
    await t.tick();
    expect(t.px.orders[0]!.status).toBe('cancelled');
    expect(t.journal.records).toMatchObject([{ kind: 'UNFILLED', reason: 'TTL' }]);
    expect(t.exec.state('SOLUSDT').s).toBe('IDLE');
  });
  it('a fill that beats the cancel becomes a protected position, not a lost order', async () => {
    const t = setup();
    t.exec.submit(plan, 'R', 'S');
    await t.exec.idle();
    t.exec.cancelPending('SOLUSDT');
    t.px.fill(1, 100); // filled before the queued cancel reaches the exchange
    await t.tick();
    expect(t.exec.state('SOLUSDT').s).toBe('OPEN');
    expect(t.px.protections).toHaveLength(1);
    expect(t.journal.records).toEqual([]);
  });
  it('keeps the filled part of a partial fill and cancels the rest', async () => {
    const t = setup();
    t.exec.submit(plan, 'R', 'S');
    await t.exec.idle();
    t.px.fill(1, 100, 4);
    await t.tick();
    expect(t.px.orders[0]!.status).toBe('cancelled');
    const st = t.exec.state('SOLUSDT');
    expect(st.s === 'OPEN' && st.plan.qty).toBe(4);
    expect(t.px.protections[0]).toMatchObject({ quantity: '4' });
  });
  it('journals a refused order and frees the slot', async () => {
    const t = setup();
    t.exec.submit({ ...plan, qty: 5000 }, 'R', 'S');
    await t.exec.idle();
    expect(t.journal.records).toMatchObject([{ kind: 'UNFILLED', reason: 'REJECTED' }]);
    expect(t.exec.state('SOLUSDT').s).toBe('IDLE');
  });
  it('retries the same order after an outage instead of sending a second one', async () => {
    const t = setup();
    t.px.down = true;
    t.exec.submit(plan, 'R', 'S');
    await t.exec.idle();
    expect(t.exec.state('SOLUSDT').s).toBe('ENTRY_PENDING');
    t.px.down = false;
    await t.tick();
    await t.tick();
    expect(t.px.orders).toHaveLength(1);
  });
  it('exits on request with a reduce-only market order and cancels the stop', async () => {
    const t = setup();
    await openLong(t);
    expect(t.exec.requestExit('SOLUSDT', 101.2, NOW, 'LLM_EXIT')).toBe(true);
    await t.exec.idle();
    expect(t.px.orders[1]).toMatchObject({ order_type: 'market', reduce_only: true, side: 'sell', execution_price: 101.2, client_order_id: 'exit-h0_SOLUSDT_1' });
    await t.tick();
    expect(t.journal.records[0]).toMatchObject({ kind: 'TRADE', exitReason: 'LLM_EXIT', exit: 101.2 });
    expect(t.px.protections[0]!.status).toBe('cancelled');
  });
  it('flattens a position it cannot protect', async () => {
    const t = setup();
    t.px.failProtections = true;
    t.exec.submit(plan, 'R', 'S');
    await t.exec.idle();
    t.px.fill(1, 100);
    const t0 = Date.now();
    await t.tick(t0);
    expect(t.exec.state('SOLUSDT').s).toBe('OPEN');
    await t.tick(t0 + 11_000); // still no stop after the limit
    await t.tick(t0 + 12_000);
    expect(t.logs.map((l) => l.msg)).toContain('unprotected_position_flatten');
    expect(t.px.orders.at(-1)).toMatchObject({ order_type: 'market', reduce_only: true });
    await t.tick(t0 + 13_000);
    expect(t.journal.records[0]).toMatchObject({ kind: 'TRADE', exitReason: 'KILL' });
  });
  it('resumes an open position after a restart and still records its exit', async () => {
    const a = setup();
    await openLong(a);
    a.exec.onTrade('SOLUSDT', 104);
    a.exec.onBarClose('SOLUSDT', ctx);
    await a.exec.idle();
    const stopBefore = (a.exec.state('SOLUSDT') as { pos: { stop: number } }).pos.stop;

    const b = setup(a.statePath, a.px); // new process, same exchange, same state file
    expect(b.logs.map((l) => l.msg)).toContain('executor_state_restored');
    const st = b.exec.state('SOLUSDT');
    expect(st.s === 'OPEN' && st.pos).toMatchObject({ entry: 99.98, stop: stopBefore, best: 104 });
    a.px.triggerStop('SOLUSDT', stopBefore); // stopped out while the bot was down or just after
    await b.tick();
    expect(b.journal.records[0]).toMatchObject({ kind: 'TRADE', exitReason: 'TRAIL', intentId: 'h0:SOLUSDT:1' });
  });
  it('resumes a resting order after a restart', async () => {
    const a = setup();
    a.exec.submit(plan, 'R', 'S');
    await a.exec.idle();
    const b = setup(a.statePath, a.px);
    expect(b.exec.state('SOLUSDT').s).toBe('ENTRY_PENDING');
    a.px.fill(1, 100);
    await b.tick();
    expect(b.exec.state('SOLUSDT').s).toBe('OPEN');
    expect(a.px.orders).toHaveLength(1);
  });
  it('blocks entries on a symbol where the exchange holds a position it does not know', async () => {
    const t = setup();
    t.px.positions.push({ id: 77, symbol: 'SOLUSDT', side: 'long', quantity: '3', average_price: '100' });
    await t.tick();
    expect(t.logs).toContainEqual({ level: 'error', msg: 'orphan_position' });
    expect(t.exec.submit(plan, 'R', 'S')).toBe(false);
    expect(t.exec.exposure()).toEqual({ positions: 1, riskUnits: 1 });
    t.px.positions[0]!.quantity = '0';
    await t.tick();
    expect(t.exec.submit(plan, 'R', 'S')).toBe(true);
  });
  it('pushes fresh quotes and marks in the shapes the exchange expects', async () => {
    const t = setup();
    await t.client.pushQuotes([{ symbol: 'SOLUSDT', bid: 99.9, ask: 100.1, mark: 100, ts: NOW }]);
    expect(t.px.calls).toEqual(['POST /api/market_events', 'POST /api/mark_prices']);
    await t.client.pushQuotes([]);
    expect(t.px.calls).toHaveLength(2);
  });
});

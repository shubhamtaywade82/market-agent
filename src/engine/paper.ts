import type { Harness, JournalSink, MarketContext, OrderPlan, TrailMode } from '../types';
import { dirOf, nextStop, rDist, toR, type Position } from './trail';

export type PosState =
  | { s: 'IDLE' }
  | { s: 'ENTRY_PENDING'; plan: OrderPlan; regime: string; setup: string; barsWaited: number }
  | { s: 'OPEN'; plan: OrderPlan; regime: string; setup: string; pos: Position; bars: number };

export interface Executor {
  state(symbol: string): PosState;
  submit(plan: OrderPlan, regime: string, setup: string): boolean;
  onTrade(symbol: string, price: number, ts: number): void;
  onBarClose(symbol: string, ctx: MarketContext): void;
  requestExit(symbol: string, price: number, ts: number, reason?: 'LLM_EXIT' | 'KILL'): boolean;
  setTrailMode(symbol: string, mode: TrailMode): void;
  cancelPending(symbol: string, ts: number): boolean;
  exposure(): Exposure;
  /** Remote executors pull order, position and protection state from the venue here. */
  reconcile?(now: number): Promise<void>;
}

export interface Exposure {
  positions: number;
  /** Sum of riskFrac over pending and open positions whose stop has not reached breakeven. */
  riskUnits: number;
}

export interface PaperOpts {
  makerBps: number;
  takerBps: number;
  slippageBps: number;
}

/**
 * Paper executor and position state machine:
 *   IDLE -> ENTRY_PENDING -> OPEN -> IDLE,  ENTRY_PENDING -> IDLE on TTL.
 * Fill model is pessimistic: a limit fills only when a trade prints strictly through
 * it, and a print through the stop exits at the stop plus slippage as a taker.
 * Funding accrual is not modelled.
 */
export class PaperExecutor implements Executor {
  private readonly states = new Map<string, PosState>();

  constructor(private readonly harness: Harness, private readonly journal: JournalSink, private readonly opts: PaperOpts) {}

  state(symbol: string): PosState {
    return this.states.get(symbol) ?? { s: 'IDLE' };
  }

  submit(plan: OrderPlan, regime: string, setup: string): boolean {
    if (this.state(plan.symbol).s !== 'IDLE') return false;
    this.states.set(plan.symbol, { s: 'ENTRY_PENDING', plan, regime, setup, barsWaited: 0 });
    return true;
  }

  onTrade(symbol: string, price: number, ts: number): void {
    let st = this.state(symbol);
    if (st.s === 'ENTRY_PENDING') {
      const { plan } = st;
      const through = plan.side === 'LONG' ? price < plan.entry : price > plan.entry;
      if (!through) return;
      st = {
        s: 'OPEN',
        plan,
        regime: st.regime,
        setup: st.setup,
        bars: 0,
        pos: { side: plan.side, entry: plan.entry, initialStop: plan.stop, stop: plan.stop, best: plan.entry, worst: plan.entry, trailMode: plan.trailMode, band: plan.band },
      };
      this.states.set(symbol, st);
      // fall through: the same print may already be beyond the stop
    }
    if (st.s !== 'OPEN') return;
    const p = st.pos;
    const dir = dirOf(p.side);
    if (dir * (price - p.best) > 0) p.best = price;
    if (dir * (price - p.worst) < 0) p.worst = price;
    if (dir * (price - p.stop) <= 0) {
      // A print beyond the stop (gap, or a stop ratcheted past price) exits at the worse of the two.
      const ref = dir > 0 ? Math.min(p.stop, price) : Math.max(p.stop, price);
      const exit = ref * (1 - (dir * this.opts.slippageBps) / 1e4);
      this.close(symbol, st, exit, ts, dir * (p.stop - p.initialStop) > 0 ? 'TRAIL' : 'STOP');
    }
  }

  onBarClose(symbol: string, ctx: MarketContext): void {
    const st = this.state(symbol);
    if (st.s === 'ENTRY_PENDING') {
      st.barsWaited += 1;
      if (st.barsWaited >= st.plan.ttlBars) {
        this.journal.append({ kind: 'UNFILLED', ts: ctx.ts, symbol, harnessId: this.harness.id, regime: st.regime, setup: st.setup, reason: 'TTL', intentId: st.plan.intentId });
        this.states.set(symbol, { s: 'IDLE' });
      }
      return;
    }
    if (st.s !== 'OPEN') return;
    st.bars += 1;
    const v15 = ctx.tf['15m'];
    if (!v15) return; // no view: keep the current stop, never loosen
    st.pos.stop = nextStop(
      st.pos,
      { atr15: v15.atr, swingLow15: v15.swingLow, swingHigh15: v15.swingHigh, breakevenBufferPct: (this.opts.makerBps + this.opts.takerBps) / 1e4 },
      this.harness.params,
    );
  }

  requestExit(symbol: string, price: number, ts: number, reason: 'LLM_EXIT' | 'KILL' = 'LLM_EXIT'): boolean {
    const st = this.state(symbol);
    if (st.s !== 'OPEN' || !(price > 0)) return false;
    this.close(symbol, st, price, ts, reason);
    return true;
  }

  cancelPending(symbol: string, ts: number): boolean {
    const st = this.state(symbol);
    if (st.s !== 'ENTRY_PENDING') return false;
    this.journal.append({ kind: 'UNFILLED', ts, symbol, harnessId: this.harness.id, regime: st.regime, setup: st.setup, reason: 'CANCELLED', intentId: st.plan.intentId });
    this.states.set(symbol, { s: 'IDLE' });
    return true;
  }

  exposure(): Exposure {
    let positions = 0;
    let riskUnits = 0;
    for (const st of this.states.values()) {
      if (st.s === 'IDLE') continue;
      positions += 1;
      if (st.s === 'ENTRY_PENDING') riskUnits += st.plan.riskFrac;
      else if (dirOf(st.pos.side) * (st.pos.stop - st.pos.entry) < 0) riskUnits += st.plan.riskFrac;
    }
    return { positions, riskUnits };
  }

  setTrailMode(symbol: string, mode: TrailMode): void {
    const st = this.state(symbol);
    if (st.s === 'OPEN') st.pos.trailMode = mode;
  }

  private close(symbol: string, st: Extract<PosState, { s: 'OPEN' }>, exit: number, ts: number, exitReason: 'STOP' | 'TRAIL' | 'LLM_EXIT' | 'KILL'): void {
    const p = st.pos;
    const feesR = ((this.opts.makerBps * p.entry + this.opts.takerBps * exit) / 1e4) / rDist(p);
    const r = toR(p, exit) - feesR;
    // Free the slot before journaling so listeners see the post-close exposure.
    this.states.set(symbol, { s: 'IDLE' });
    this.journal.append({
      kind: 'TRADE',
      ts,
      symbol,
      harnessId: this.harness.id,
      regime: st.regime,
      setup: st.setup,
      side: p.side,
      entry: p.entry,
      exit,
      initialStop: p.initialStop,
      r,
      mfeR: toR(p, p.best),
      maeR: -toR(p, p.worst),
      bars: st.bars,
      exitReason,
      intentId: st.plan.intentId,
      riskFrac: st.plan.riskFrac,
      qty: st.plan.qty,
      pnlUsd: r * rDist(p) * st.plan.qty,
    });
  }
}

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DeskLimits } from '../config';
import type { Exposure } from '../engine/paper';
import type { JournalRecord } from '../types';

export type Tier = 'PROVEN' | 'PROBATION' | 'BENCHED';
export type DeskMode = 'NORMAL' | 'REDUCED' | 'COOLDOWN' | 'DAY_STOPPED' | 'HALTED';

export interface DeskState {
  dayKey: string;
  dayR: number;
  cumR: number;
  peakR: number;
  consecLosses: number;
  cooldownUntil: number;
  halted: boolean;
}

export type Approval = { ok: true; riskFrac: number; mode: DeskMode } | { ok: false; reason: string; mode: DeskMode };

const TIER_RISK: Record<Tier, number> = { PROVEN: 1, PROBATION: 0.5, BENCHED: 0 };
const dayKeyOf = (ts: number) => new Date(ts).toISOString().slice(0, 10);

/**
 * The risk desk has the last word on every entry. It only ever blocks or shrinks risk;
 * nothing the model outputs can raise size. All accounting is in risk units
 * (a trade's R multiplied by the fraction of base risk it carried), so the limits
 * mean the same thing whatever the account size.
 *
 * A drawdown halt is sticky: it persists across restarts until resetHalt() is called.
 */
export class RiskDesk {
  private st: DeskState;

  constructor(
    private readonly limits: DeskLimits,
    private readonly opts: { statePath?: string; killed?: () => boolean } = {},
  ) {
    this.st = { dayKey: '', dayR: 0, cumR: 0, peakR: 0, consecLosses: 0, cooldownUntil: 0, halted: false };
    if (opts.statePath && existsSync(opts.statePath)) {
      const raw = JSON.parse(readFileSync(opts.statePath, 'utf8')) as Partial<DeskState>;
      for (const k of Object.keys(this.st) as (keyof DeskState)[]) {
        if (typeof raw[k] !== typeof this.st[k]) throw new Error(`${opts.statePath}: bad or missing field ${k}`);
      }
      this.st = raw as DeskState;
    }
  }

  get state(): Readonly<DeskState> {
    return this.st;
  }

  private rollDay(now: number): void {
    const key = dayKeyOf(now);
    if (key !== this.st.dayKey) {
      this.st.dayKey = key;
      this.st.dayR = 0;
    }
  }

  mode(now: number): DeskMode {
    this.rollDay(now);
    if (this.st.halted || this.opts.killed?.()) return 'HALTED';
    if (this.st.dayR <= -this.limits.dailyLossLimitR) return 'DAY_STOPPED';
    if (now < this.st.cooldownUntil) return 'COOLDOWN';
    if (this.st.peakR - this.st.cumR >= this.limits.throttleDrawdownR) return 'REDUCED';
    return 'NORMAL';
  }

  approve(req: { tier: Tier; exposure: Exposure; now: number }): Approval {
    const mode = this.mode(req.now);
    if (mode === 'HALTED' || mode === 'DAY_STOPPED' || mode === 'COOLDOWN') return { ok: false, reason: `DESK_${mode}`, mode };
    if (req.tier === 'BENCHED') return { ok: false, reason: 'BUCKET_BENCHED', mode };
    if (req.exposure.positions >= this.limits.maxOpenPositions) return { ok: false, reason: 'MAX_POSITIONS', mode };
    const riskFrac = TIER_RISK[req.tier] * (mode === 'REDUCED' ? 0.5 : 1);
    if (req.exposure.riskUnits + riskFrac > this.limits.maxOpenRiskUnits + 1e-9) return { ok: false, reason: 'OPEN_RISK_CAP', mode };
    return { ok: true, riskFrac, mode };
  }

  onRecord(rec: JournalRecord): void {
    if (rec.kind !== 'TRADE') return;
    this.rollDay(rec.ts);
    const units = rec.r * (rec.riskFrac ?? 1);
    this.st.dayR += units;
    this.st.cumR += units;
    this.st.peakR = Math.max(this.st.peakR, this.st.cumR);
    if (rec.r < 0) {
      this.st.consecLosses += 1;
      if (this.st.consecLosses >= this.limits.maxConsecLosses) {
        this.st.cooldownUntil = rec.ts + this.limits.cooldownMs;
        this.st.consecLosses = 0;
      }
    } else {
      this.st.consecLosses = 0;
    }
    if (this.st.peakR - this.st.cumR >= this.limits.maxDrawdownR) this.st.halted = true;
    this.persist();
  }

  /** Human action. Re-bases the peak so the desk does not halt again on the next tick. */
  resetHalt(): void {
    this.st.halted = false;
    this.st.peakR = this.st.cumR;
    this.persist();
  }

  private persist(): void {
    if (!this.opts.statePath) return;
    mkdirSync(dirname(this.opts.statePath), { recursive: true });
    const tmp = `${this.opts.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.st));
    renameSync(tmp, this.opts.statePath);
  }
}

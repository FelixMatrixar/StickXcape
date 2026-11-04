/**
 * The practice bot (MP-4): a rule-based opponent. It sees the fight a few frames late, like a
 * person reacting, and plays the same buttons a player would. Seeded, so a practice fight
 * replays exactly from its seed and inputs.
 */
import { Button, Rng } from '@sticxcape/shared';
import { toFixed } from './fixed.ts';
import { HIGH, isActiveFrame, LOW } from './moves.ts';
import { GRAB_RANGE, HEAVY_COST, S, SPECIAL_COST, type FightSim, type Fighter } from './sim.ts';

export type BotLevel = 'easy' | 'normal' | 'hard';

interface Tuning {
  /** Frames between something happening and the bot reacting. */
  reaction: number;
  block: number;
  parry: number;
  jumpLow: number;
  aggression: number;
  punish: number;
  combo: number;
  /** Chance per frame to grab an opponent who keeps blocking. */
  grab: number;
}

const TUNING: Record<BotLevel, Tuning> = {
  easy: { reaction: 24, block: 0.25, parry: 0.02, jumpLow: 0.1, aggression: 0.02, punish: 0.2, combo: 0.15, grab: 0.01 },
  normal: { reaction: 15, block: 0.55, parry: 0.12, jumpLow: 0.3, aggression: 0.035, punish: 0.55, combo: 0.5, grab: 0.04 },
  hard: { reaction: 9, block: 0.75, parry: 0.3, jumpLow: 0.5, aggression: 0.05, punish: 0.85, combo: 0.85, grab: 0.08 },
};

interface Seen {
  state: number;
  move: number;
  moveT: number;
  x: number;
}

const NEAR = toFixed(0.25);

export class PracticeBot {
  readonly side: 0 | 1;
  readonly level: BotLevel;
  private readonly rng: Rng;
  private readonly tune: Tuning;
  private readonly history: Seen[] = [];
  /** A plan: hold these buttons (relative: forward/back) for some frames. */
  private plan = 0;
  private planFrames = 0;
  private planFresh = false;
  private parryAt = -1;
  private lastAttackSeen = -1;
  private prev = 0;

  constructor(side: 0 | 1, seed: number, level: BotLevel = 'normal') {
    this.side = side;
    this.level = level;
    this.rng = new Rng(seed ^ 0x5bd1e995);
    this.tune = TUNING[level];
  }

  private chance(p: number): boolean {
    return this.rng.nextInt(1000) < p * 1000;
  }

  /** Buttons for this frame, as a player would press them. */
  input(sim: FightSim): number {
    const me = sim.fighters[this.side];
    const them = sim.fighters[1 - this.side];
    this.history.push({ state: them.state, move: them.move, moveT: them.moveT, x: them.x });
    if (this.history.length > 40) this.history.shift();
    if (sim.phase !== 1 || sim.hitstop > 0) return this.emit(me, this.prev && sim.hitstop > 0 ? this.prev : 0);

    const seen = this.history[Math.max(0, this.history.length - 1 - this.tune.reaction)];
    const gap = Math.abs(them.x - me.x);
    const fwd = FWD;
    const back = BACK;

    // Keep going with a plan in progress.
    if (this.planFrames > 0) {
      this.planFrames -= 1;
      const buttons = this.plan;
      const fresh = this.planFresh;
      this.planFresh = false;
      // Attack buttons are tapped (one frame), everything else is held.
      return this.emit(me, fresh ? buttons : buttons & ~(Button.Light | Button.Heavy | Button.Special | Button.Defense));
    }

    // A timed parry attempt.
    if (this.parryAt >= 0) {
      this.parryAt -= 1;
      if (this.parryAt === 0) {
        this.parryAt = -1;
        return this.hold(Button.Block, 1, me);
      }
      return this.emit(me, 0);
    }

    // Landed a light hit: cancel into a heavy.
    if (me.state === S.attack && me.cancel && this.chance(this.tune.combo)) return this.tap(Button.Heavy, me);
    if (me.state === S.knockdown && me.stun <= 3) {
      const roll = this.rng.nextInt(10);
      return this.hold(roll < 4 ? back : roll < 7 ? fwd : 0, 4, me);
    }
    if (me.state !== S.idle && me.state !== S.block) return this.emit(me, me.state === S.blockstun ? Button.Block : 0);

    // React to what we saw of their attack.
    if (seen.state === S.attack && seen.move >= 0 && seen.move !== this.lastAttackSeen) {
      const move = them.moves[seen.move];
      if (move && move.hasHitbox && seen.moveT < move.startup + move.active && gap < move.reach + toFixed(0.35)) {
        this.lastAttackSeen = seen.move;
        const low = move.height === LOW;
        const framesLeft = move.startup - seen.moveT - this.tune.reaction;
        if (framesLeft >= 1 && framesLeft <= 8 && this.chance(this.tune.parry)) {
          this.parryAt = Math.max(1, framesLeft);
          return this.emit(me, 0);
        }
        if (low && this.chance(this.tune.jumpLow)) return this.hold(Button.Up | fwd, 6, me);
        if (this.chance(me.guard < 260 ? this.tune.block * 0.4 : this.tune.block)) {
          const crouch = low || (move.height === HIGH && this.chance(0.4));
          return this.hold(Button.Block | (crouch ? Button.Down : 0), move.active + Math.max(4, move.startup - seen.moveT), me);
        }
      }
    }
    if (seen.state !== S.attack) this.lastAttackSeen = -1;

    const light = me.moves[me.slots.light[0]];
    const range = light ? light.reach : toFixed(0.8);
    const heavy = me.moves[me.slots.heavy[0]];

    if ((them.state === S.block || them.state === S.parry) && gap <= GRAB_RANGE && this.chance(this.tune.grab)) return this.tap(Button.Light | Button.Heavy, me);

    // Punish whiffs, staggers, a missed parry and a missed grab.
    const theirMove = them.currentMove;
    const recovering =
      (them.state === S.attack && theirMove && !isActiveFrame(theirMove, them.moveT) && them.moveT > theirMove.startup) ||
      them.state === S.stagger ||
      them.state === S.parryWhiff ||
      them.state === S.guardBreak ||
      (them.state === S.grab && them.stateT > 11);
    if (recovering && gap < (heavy ? heavy.reach : range) + NEAR && this.chance(this.tune.punish)) {
      return this.tap(this.chance(0.35) && me.stamina >= SPECIAL_COST ? Button.Special : me.stamina >= HEAVY_COST ? Button.Heavy : Button.Light, me);
    }

    // They are down: keep a respectful distance, sometimes taunt.
    if (them.state === S.knockdown || them.state === S.getup) {
      if (this.chance(0.02)) return this.tap(Button.Defense | Button.Down, me);
      return this.hold(gap < toFixed(1.4) ? back : 0, 8, me);
    }

    // Spacing and offence.
    if (gap > range + toFixed(0.45)) {
      if (this.chance(0.012)) return this.hold(Button.Up | fwd, 4, me);
      if (gap > toFixed(2.6) && this.chance(0.03)) return this.doubleTap(me);
      return this.hold(fwd, 6 + this.rng.nextInt(10), me);
    }
    if (gap < range + NEAR && this.chance(this.tune.aggression * 3)) {
      const roll = me.stamina >= SPECIAL_COST ? this.rng.nextInt(100) : me.stamina >= HEAVY_COST ? this.rng.nextInt(88) : this.rng.nextInt(60);
      if (them.state === S.block && !them.crouch && roll < 45) return this.tap(Button.Heavy | Button.Down, me);
      if (roll < 45) return this.tap(Button.Light, me);
      if (roll < 60) return this.tap(Button.Light | fwd, me);
      if (roll < 78) return this.tap(Button.Heavy, me);
      if (roll < 88) return this.tap(Button.Heavy | Button.Down, me);
      if (roll < 95) return this.tap(Button.Special, me);
      return this.tap(Button.Heavy | fwd, me);
    }
    if (gap < range - toFixed(0.2) && this.chance(0.05)) return this.hold(back, 8 + this.rng.nextInt(12), me);
    if (this.chance(0.02)) return this.hold(fwd, 6, me);
    if (this.chance(0.01)) return this.hold(back, 10, me);
    return this.emit(me, 0);
  }

  private hold(buttons: number, frames: number, me: Fighter): number {
    this.plan = buttons;
    this.planFrames = Math.max(0, frames - 1);
    this.planFresh = false;
    return this.emit(me, buttons);
  }

  private tap(buttons: number, me: Fighter): number {
    this.plan = 0;
    this.planFrames = 0;
    return this.emit(me, buttons);
  }

  private doubleTap(me: Fighter): number {
    this.plan = FWD;
    this.planFrames = 3;
    this.planFresh = false;
    // Forward, release, forward: the engine's dash.
    this.queue = [FWD, 0, 0, FWD];
    return this.emit(me, 0);
  }

  private queue: number[] = [];

  /** Turns forward/back into screen directions and remembers what was pressed. */
  private emit(me: Fighter, relative: number): number {
    if (this.queue.length > 0) relative = this.queue.shift()!;
    let buttons = relative & ~(FWD | BACK);
    if (relative & FWD) buttons |= me.facing > 0 ? Button.Right : Button.Left;
    if (relative & BACK) buttons |= me.facing > 0 ? Button.Left : Button.Right;
    this.prev = relative;
    return buttons;
  }
}

/** Relative directions, outside the 9 button bits. */
const FWD = 1 << 12;
const BACK = 1 << 13;

/**
 * The thin fight HUD (LS-6): health bars with a trailing white chunk that drains after a hit,
 * the round timer, round dots, and the big announcer text (ROUND 1, FIGHT, K.O.).
 */
import { GUARD_MAX, HEAVY_COST, MAX_HEALTH, S, STAMINA_MAX, type FightSim } from '../engine/sim.ts';
import type { Ink } from '../render/inks.ts';
import { h } from './dom.ts';

interface Side {
  el: HTMLElement;
  bar: HTMLElement;
  fill: HTMLElement;
  trail: HTMLElement;
  dots: HTMLElement[];
  health: number;
  wins: number;
  stamina: HTMLElement;
  guard: HTMLElement;
  meters: number;
}

export class Hud {
  readonly el: HTMLElement;
  readonly announcer: HTMLElement;
  private readonly sides: [Side, Side];
  private readonly timer: HTMLElement;
  private readonly roundLabel: HTMLElement;
  private seconds = -1;

  constructor(names: [string, string], inks: [Ink, Ink], localSide: 0 | 1 | null) {
    const side = (i: 0 | 1): Side => {
      const fill = h('i', { class: 'bar-fill' });
      const trail = h('i', { class: 'bar-trail' });
      const bar = h('div', { class: 'bar' }, trail, fill);
      bar.style.setProperty('--c', inks[i].ink);
      bar.style.setProperty('--c-deep', inks[i].deep);
      bar.style.setProperty('--c-glow', inks[i].glow);
      const dots = [h('i'), h('i')];
      const name = h('div', { class: 'hud-name' }, h('span', { text: names[i] }), localSide === i ? h('span', { class: 'you', text: 'YOU' }) : null);
      if (i === 1) name.style.flexDirection = 'row-reverse';
      // Stamina and guard (CB-7): thin bars under the health bar.
      const stamina = h('div', { class: 'meter-bar stamina', attrs: { 'aria-label': 'Stamina' } }, h('i', { class: 'meter-fill' }));
      const guard = h('div', { class: 'meter-bar guard', attrs: { 'aria-label': 'Guard' } }, h('i', { class: 'meter-fill' }));
      const el = h('div', { class: `hud-side ${i === 0 ? 'left' : 'right'}` }, name, bar, h('div', { class: 'meters' }, stamina, guard), h('div', { class: 'hud-dots' }, ...dots));
      return { el, bar, fill, trail, dots, health: MAX_HEALTH, wins: 0, stamina, guard, meters: -1 };
    };
    this.sides = [side(0), side(1)];
    this.timer = h('div', { class: 'hud-timer', text: '60' });
    this.roundLabel = h('div', { class: 'hud-round', text: 'Round 1' });
    this.el = h('div', { class: 'hud' }, this.sides[0].el, h('div', { class: 'hud-center' }, this.timer, this.roundLabel), this.sides[1].el);
    this.announcer = h('div', { class: 'announce', attrs: { 'aria-live': 'assertive' } });
  }

  update(sim: FightSim): void {
    for (const f of sim.fighters) {
      const side = this.sides[f.side];
      if (f.health !== side.health) {
        const ratio = f.health / MAX_HEALTH;
        side.fill.style.setProperty('--h', String(ratio));
        side.trail.style.setProperty('--h', String(ratio));
        if (f.health < side.health) {
          side.bar.classList.remove('is-hit');
          void side.bar.offsetWidth;
          side.bar.classList.add('is-hit');
        } else {
          // A new round refills the bar at once.
          side.trail.style.transition = 'none';
          void side.trail.offsetWidth;
          side.trail.style.transition = '';
        }
        side.bar.classList.toggle('is-low', ratio <= 0.25 && ratio > 0);
        side.health = f.health;
      }
      // Meters change most frames; only touch the DOM when the shown value moves.
      const key = Math.round(f.stamina / 20) * 10000 + Math.round(f.guard / 20) * 10 + (f.state === S.guardBreak ? 1 : 0);
      if (key !== side.meters) {
        side.meters = key;
        side.stamina.style.setProperty('--v', String(f.stamina / STAMINA_MAX));
        side.guard.style.setProperty('--v', String(f.guard / GUARD_MAX));
        side.stamina.classList.toggle('is-low', f.stamina < HEAVY_COST);
        side.guard.classList.toggle('is-broken', f.state === S.guardBreak);
      }
      if (f.roundsWon !== side.wins) {
        side.wins = f.roundsWon;
        side.dots.forEach((dot, i) => dot.classList.toggle('is-won', i < side.wins));
      }
    }
    const seconds = sim.seconds;
    if (seconds !== this.seconds) {
      this.seconds = seconds;
      this.timer.textContent = String(seconds);
      this.timer.classList.toggle('is-urgent', seconds <= 10 && sim.phase === 1);
    }
    this.roundLabel.textContent = `Round ${sim.round}`;
  }

  /** Shakes a meter: out of stamina, or the guard just broke. */
  pulse(side: number, which: 'stamina' | 'guard'): void {
    const bar = this.sides[side === 0 ? 0 : 1][which];
    bar.classList.remove('is-pulse');
    void bar.offsetWidth;
    bar.classList.add('is-pulse');
  }

  /** Big announcer text that slams in, holds, and flies off. */
  announce(text: string, options: { sub?: string; hold?: number; ko?: boolean; band?: string } = {}): void {
    this.announcer.replaceChildren();
    const el = h('div', { class: `announce-text${options.ko ? ' is-ko' : ''}` });
    if (options.sub) el.append(h('span', { class: 'announce-sub', text: options.sub }));
    el.append(document.createTextNode(text));
    if (options.band) el.style.setProperty('--band', options.band);
    this.announcer.append(el);
    const hold = options.hold ?? 900;
    setTimeout(() => el.classList.add('is-out'), hold);
    setTimeout(() => el.remove(), hold + 400);
  }
}

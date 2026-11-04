/**
 * Title: tap to start (browsers only allow sound after a tap). Behind the logo two bots fight
 * a real match on the real engine, so the first thing anyone sees is the game itself.
 */
import { FRAME_MS } from '@sticxcape/shared';
import type { Screen } from '../app/router.ts';
import { audio } from '../audio/engine.ts';
import { ui } from '../audio/sfx.ts';
import { PracticeBot } from '../engine/bot.ts';
import { FightSim, PHASE } from '../engine/sim.ts';
import { defaultMoves } from '../moves/defaults.ts';
import { simArena } from '../render/arena-files.ts';
import { arenaById } from '../render/arenas.ts';
import { inkById } from '../render/inks.ts';
import { FightScene } from '../render/scene.ts';
import { h, svg } from '../ui/dom.ts';

export function titleScreen(onStart: () => void): Screen {
  const canvas = h('canvas', { class: 'attract', attrs: { 'aria-hidden': 'true' } });
  const letters = 'STICXCAPE'.split('').map((ch, i) => h('span', { class: ch === 'X' ? 'x' : '', style: `--i:${i}`, text: ch }));
  const logo = h('h1', { class: 'logo', attrs: { 'aria-label': 'SticXcape' } }, ...letters);
  const brush = svg('<svg viewBox="0 0 520 22" preserveAspectRatio="none"><path d="M6 14 C 120 4, 260 18, 380 9 S 500 8, 514 12" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round"/></svg>', 'brush');
  const tagline = h('div', { class: 'tagline' }, h('span', { style: '--i:0', text: 'Your moves.' }), h('span', { style: '--i:1', text: 'Your turf.' }), h('span', { style: '--i:2', text: 'Your fight.' }));
  const tap = h('div', { class: 'tap-start', text: 'Tap to start' });
  const body = h('div', { class: 'title-body' }, logo, brush, tagline, tap);
  const foot = h('div', { class: 'title-foot', text: 'Best played sideways · Sound on' });
  const el = h('section', { class: 'title', attrs: { role: 'button', tabindex: '0', 'aria-label': 'Tap to start' } }, canvas, h('div', { class: 'title-shade' }), body, foot);

  const loadout = defaultMoves();
  const arena = arenaById('rooftop');
  let seed = (Math.random() * 1e9) | 0;
  const makeSim = () => new FightSim({ seed: seed++, arena: simArena(arena.file), loadouts: [loadout, loadout] });
  let sim = makeSim();
  let bots = [new PracticeBot(0, seed, 'hard'), new PracticeBot(1, seed + 1, 'hard')];
  const scene = new FightScene({ canvas, sim, arena, inks: [inkById('vermillion'), inkById('cobalt')], localSide: null, quiet: true, shake: 0.5, flashes: 0.4 });

  let raf = 0;
  let last = performance.now();
  let acc = 0;
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(250, now - last);
    last = now;
    acc = Math.min(acc + dt, 200);
    while (acc >= FRAME_MS) {
      sim.step([bots[0].input(sim), bots[1].input(sim)]);
      scene.onStep();
      acc -= FRAME_MS;
      if (sim.phase === PHASE.over) {
        sim = makeSim();
        bots = [new PracticeBot(0, seed, 'hard'), new PracticeBot(1, seed + 1, 'hard')];
        scene.setSim(sim);
      }
    }
    scene.frame(dt);
  };

  let started = false;
  const start = (event?: PointerEvent | KeyboardEvent) => {
    if (started) return;
    started = true;
    audio.unlock();
    // Sound is allowed from here on.
    setTimeout(() => ui.confirm(), 30);
    const x = event instanceof PointerEvent ? event.clientX : innerWidth / 2;
    const y = event instanceof PointerEvent ? event.clientY : innerHeight / 2;
    const burst = h('i', { class: 'burst-fx', style: `left:${x}px;top:${y}px` });
    document.body.append(burst);
    setTimeout(() => burst.remove(), 700);
    tap.style.transform = 'scale(.9)';
    setTimeout(onStart, 160);
  };
  el.addEventListener('pointerdown', (e) => start(e));
  const key = (e: KeyboardEvent) => {
    if (e.code === 'Enter' || e.code === 'Space') start(e);
  };

  const onResize = () => scene.resize();
  return {
    el,
    enter() {
      scene.resize();
      raf = requestAnimationFrame(frame);
      window.addEventListener('keydown', key);
      window.addEventListener('resize', onResize);
    },
    leave() {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', key);
      window.removeEventListener('resize', onResize);
    },
  };
}

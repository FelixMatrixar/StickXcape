/**
 * The fight screen: the simulation, the scene, the HUD and the controls, for practice against
 * the bot or an online match through the relay. Practice steps the engine at a fixed 60 Hz;
 * online play hands stepping to the netcode's LockstepDriver, which feeds both phones the same
 * inputs on the same frames.
 */
import { FRAME_MS, type EndReason, type MatchEndMessage, type MoveFile } from '@sticxcape/shared';
import { LockstepDriver, type LockstepSession } from '@sticxcape/netcode';
import { haptic } from '../app/haptics.ts';
import type { Screen } from '../app/router.ts';
import { settings } from '../app/settings.ts';
import { music } from '../audio/music.ts';
import { fightSound, stinger, ui } from '../audio/sfx.ts';
import { PracticeBot, type BotLevel } from '../engine/bot.ts';
import type { CompiledMove } from '../engine/moves.ts';
import { FightSim, MAX_ROUNDS, PHASE, type SimEvent } from '../engine/sim.ts';
import { simArena } from '../render/arena-files.ts';
import type { ArenaArt } from '../render/arenas.ts';
import type { Ink } from '../render/inks.ts';
import { FightScene } from '../render/scene.ts';
import { Controls } from '../ui/controls.ts';
import { h, press, svg, toast } from '../ui/dom.ts';
import { Hud } from '../ui/hud.ts';
import { ICON } from '../ui/icons.ts';
import { openSettings, setCornerDark, setCornerVisible, toggleMute } from '../ui/overlay.ts';
import { settings as liveSettings } from '../app/settings.ts';

export interface FightConfig {
  mode: 'practice' | 'online';
  seed: number;
  arena: ArenaArt;
  loadouts: [MoveFile[], MoveFile[]];
  names: [string, string];
  inks: [Ink, Ink];
  localSide: 0 | 1;
  botLevel?: BotLevel;
  session?: LockstepSession;
  /** Recorded idle stances to draw, per side (looks only). */
  idles?: [CompiledMove | null, CompiledMove | null];
  onFinish(result: FightResult): void;
  onQuit(): void;
}

export interface FightResult {
  sim: FightSim;
  config: FightConfig;
  reason: EndReason;
  winnerSide: 0 | 1 | null;
}

export function fightScreen(config: FightConfig): Screen {
  const canvas = h('canvas', { class: 'world', attrs: { 'aria-label': 'The fight' } });
  const waiting = h('div', { class: 'waiting', style: 'display:none' }, h('i', { class: 'spinner' }), h('span', { text: 'Waiting for the other phone…' }));
  const netStats = h('div', { class: 'net-stats' });
  const el = h('section', { class: 'fight' }, canvas);
  let sim = newSim();
  const hud = new Hud(config.names, config.inks, config.localSide);
  let paused = false;
  let pauseEl: HTMLElement | null = null;
  const controls = new Controls({ onPause: () => togglePause() });
  const pauseButton = press(h('button', { class: 'btn btn-icon btn-small hud-mini', attrs: { 'aria-label': 'Pause' } }, svg(ICON.pause)), () => togglePause(), { sound: 'none' });
  const muteButton = press(h('button', { class: 'btn btn-icon btn-small hud-mini', attrs: { 'aria-label': 'Mute' } }, svg(liveSettings.muted ? ICON.muted : ICON.sound)), () => {
    toggleMute();
    muteButton.replaceChildren(svg(liveSettings.muted ? ICON.muted : ICON.sound));
  }, { sound: 'none' });
  hud.el.querySelector('.hud-center')!.append(h('div', { class: 'hud-buttons' }, pauseButton, muteButton));
  el.append(hud.el, hud.announcer, controls.el, waiting);
  if (config.mode === 'online') el.append(netStats);

  const scene = new FightScene({
    canvas,
    sim,
    arena: config.arena,
    inks: config.inks,
    localSide: config.localSide,
    sound: fightSound,
    haptic,
    shake: settings.shake,
    flashes: settings.flashes,
    damageNumbers: settings.damageNumbers,
    idles: config.idles,
    onEvent: (event) => onEvent(event),
  });

  if (import.meta.env.DEV) (window as unknown as { __fight?: unknown }).__fight = { get sim() { return sim; }, controls, scene };

  function newSim(): FightSim {
    return new FightSim({ seed: config.seed, arena: simArena(config.arena.file), loadouts: config.loadouts });
  }

  let bot = config.mode === 'practice' ? new PracticeBot(config.localSide === 0 ? 1 : 0, config.seed, config.botLevel ?? 'normal') : null;
  let driver: LockstepDriver | null = null;
  let endMessage: MatchEndMessage | null = null;
  let finished = false;
  let reportedWinner = false;
  let overAt = 0;

  if (config.mode === 'online' && config.session) {
    const session = config.session;
    driver = new LockstepDriver(session, {
      sampleInput: () => controls.sample(),
      simulate: (inputs) => step(inputs),
      stateHash: () => sim.hash(),
    });
    session.onDesync(() => toast('The phones disagreed about the fight. Ending the match.', 'error'));
    session.onEnd((end) => {
      endMessage = end;
      if (end.reason !== 'finished') finish(end.reason, end.winner === null ? null : sideOfPlayer(end.winner));
    });
  }

  function sideOfPlayer(player: number): 0 | 1 | null {
    const fighters = config.session?.fighters;
    if (!fighters) return null;
    return fighters[0] === player ? 0 : fighters[1] === player ? 1 : null;
  }

  function step(inputs: readonly [number, number]): void {
    sim.step(inputs);
    scene.onStep();
  }

  // Announcer, music and HUD cues from the fight.
  function onEvent(event: SimEvent): void {
    switch (event.type) {
      case 'round': {
        const final = sim.fighters[0].roundsWon === 1 && sim.fighters[1].roundsWon === 1;
        const last = event.round === MAX_ROUNDS;
        hud.announce(final || last ? 'Final round' : `Round ${event.round}`, { hold: 820 });
        stinger.round(event.round);
        music.intensity = final || last ? 2 : 1;
        if (event.round > 1) music.resume();
        return;
      }
      case 'fight':
        hud.announce('Fight!', { hold: 520, band: config.inks[config.localSide].ink });
        stinger.fight();
        return;
      case 'ko':
        music.cut();
        setTimeout(() => {
          hud.announce('K.O.', { ko: true, hold: 1500 });
          stinger.ko();
        }, 420);
        return;
      case 'ringout':
        music.cut();
        setTimeout(() => {
          hud.announce('Ring out', { ko: true, hold: 1500 });
          stinger.ko();
        }, 380);
        return;
      case 'guardBreak':
        hud.pulse(event.side, 'guard');
        return;
      case 'tired':
        hud.pulse(event.side, 'stamina');
        return;
      case 'timeup':
        music.cut();
        hud.announce('Time', { hold: 1100 });
        stinger.timeUp();
        return;
      case 'tick':
        stinger.tick(event.seconds);
        return;
      case 'matchEnd': {
        const win = event.winner === config.localSide;
        const text = event.winner === null ? 'Draw' : win ? 'Victory' : 'Defeat';
        setTimeout(() => {
          hud.announce(text, { hold: 2600, sub: event.winner === null ? 'Nobody' : `${config.names[event.winner]} wins` });
          if (win || event.winner === null) stinger.victory();
          else stinger.defeat();
        }, 250);
        music.stop(1.2);
        if (config.session && !reportedWinner) {
          reportedWinner = true;
          const fighters = config.session.fighters;
          config.session.finish(event.winner === null ? null : fighters[event.winner]);
        }
        return;
      }
    }
  }

  function finish(reason: EndReason, winnerSide: 0 | 1 | null): void {
    if (finished) return;
    finished = true;
    setTimeout(() => config.onFinish({ sim, config, reason, winnerSide }), reason === 'finished' ? 200 : 1200);
  }

  // Pause (practice only; an online match can't stop for one phone).
  function togglePause(): void {
    if (config.mode === 'online') {
      if (pauseEl) return closePause();
      return showPause();
    }
    if (paused) closePause();
    else showPause();
  }

  function showPause(): void {
    if (finished) return;
    paused = config.mode === 'practice';
    ui.tap();
    const resume = press(h('button', { class: 'btn btn-primary', text: config.mode === 'practice' ? 'Resume' : 'Back to the fight' }), () => closePause());
    const restart = press(h('button', { class: 'btn', text: 'Restart' }), () => {
      closePause();
      restartFight();
    });
    const options = press(h('button', { class: 'btn', text: 'Settings' }), () => openSettings());
    const quit = press(h('button', { class: 'btn btn-ghost', text: config.mode === 'practice' ? 'Quit to home' : 'Leave the match' }), () => {
      closePause();
      config.onQuit();
    }, { sound: 'back' });
    pauseEl = h(
      'div',
      { class: 'pause-menu' },
      h('div', { class: 'card pause-card' }, h('h2', { text: config.mode === 'practice' ? 'Paused' : 'Menu' }), resume, config.mode === 'practice' ? restart : null, options, quit),
    );
    el.append(pauseEl);
    controls.enabled = false;
  }

  function closePause(): void {
    pauseEl?.remove();
    pauseEl = null;
    paused = false;
    controls.enabled = true;
    last = performance.now();
  }

  function restartFight(): void {
    sim = newSim();
    bot = new PracticeBot(config.localSide === 0 ? 1 : 0, config.seed + 1, config.botLevel ?? 'normal');
    scene.setSim(sim);
    music.play('fight');
    overAt = 0;
  }

  // The loop.
  let raf = 0;
  let last = performance.now();
  let acc = 0;
  let lastStatsAt = 0;
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    // A frame's timestamp can be older than the last one taken (after the tab was in the
    // background): never step backwards.
    const dt = Math.max(0, Math.min(250, now - last));
    last = now;
    if (!paused) {
      if (driver && config.session && !config.session.ended) {
        driver.update(now);
        const stalled = driver.stalled && config.session.stalledFor() > 180;
        waiting.style.display = stalled ? '' : 'none';
      } else if (!finished || config.mode === 'practice' || endMessage) {
        // Practice, or an online match the relay has ended: the last frames are only for show.
        waiting.style.display = 'none';
        acc = Math.min(acc + dt, 250);
        let steps = 0;
        while (acc >= FRAME_MS && steps < 5) {
          const local = config.mode === 'practice' ? controls.sample() : 0;
          const other = bot ? bot.input(sim) : 0;
          step(config.localSide === 0 ? [local, other] : [other, local]);
          acc -= FRAME_MS;
          steps += 1;
        }
      }
    }
    scene.shake = settings.shake;
    scene.flashes = settings.flashes;
    scene.frame(dt);
    hud.update(sim);
    if (config.session && now - lastStatsAt > 500) {
      lastStatsAt = now;
      netStats.textContent = `delay ${config.session.inputDelay}f · frame ${config.session.frame}`;
    }
    if (sim.phase === PHASE.over) {
      overAt ||= now;
      if (now - overAt > 300) finish(endMessage?.reason ?? 'finished', sim.winner === undefined || sim.winner === null ? null : (sim.winner as 0 | 1));
    }
  };

  const onResize = () => scene.resize();
  const onVisibility = () => {
    if (document.hidden && config.mode === 'practice' && !paused && !finished) showPause();
  };

  return {
    el,
    enter() {
      setCornerDark(true);
      setCornerVisible(false);
      scene.resize();
      window.addEventListener('resize', onResize);
      document.addEventListener('visibilitychange', onVisibility);
      music.play('fight');
      last = performance.now();
      raf = requestAnimationFrame(frame);
    },
    leave() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      controls.destroy();
      setCornerDark(false);
      setCornerVisible(true);
    },
  };
}

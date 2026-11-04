/**
 * Screens and the ink-wipe transition between them. A screen is a plain element plus optional
 * enter/leave hooks; the router mounts one at a time and sweeps a brush stroke across the
 * screen while it swaps them.
 */
import { ui } from '../audio/sfx.ts';
import { h } from '../ui/dom.ts';

export interface Screen {
  el: HTMLElement;
  /** After the screen is visible. */
  enter?(): void;
  /** Before it is removed; stop loops and listeners here. */
  leave?(): void;
}

export type Transition = 'wipe' | 'fade' | 'none';

let stage: HTMLElement;
let wipe: HTMLElement;
let current: Screen | null = null;
let busy: Promise<void> = Promise.resolve();

export function initRouter(root: HTMLElement): void {
  stage = h('main', { class: 'stage' });
  wipe = h(
    'div',
    { class: 'wipe', attrs: { 'aria-hidden': 'true' } },
    h('div', { class: 'wipe-band' }),
    h('div', { class: 'wipe-band wipe-band-2' }),
  );
  root.append(stage, wipe);
}

/** Shows a screen. Calls queue up, so rapid taps never mount two screens at once. */
export function show(make: () => Screen | Promise<Screen>, transition: Transition = 'wipe'): Promise<void> {
  busy = busy.then(() => swap(make, transition)).catch((err) => console.error(err));
  return busy;
}

async function swap(make: () => Screen | Promise<Screen>, transition: Transition): Promise<void> {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mode = reduced && transition === 'wipe' ? 'fade' : transition;
  const next = await make();
  next.el.classList.add('screen');

  if (!current || mode === 'none') {
    current?.leave?.();
    current?.el.remove();
    stage.append(next.el);
    current = next;
    requestAnimationFrame(() => next.enter?.());
    return;
  }

  if (mode === 'fade') {
    const prev = current;
    prev.el.classList.add('is-fading-out');
    await wait(180);
    prev.leave?.();
    prev.el.remove();
    next.el.classList.add('is-fading-in');
    stage.append(next.el);
    current = next;
    requestAnimationFrame(() => next.enter?.());
    return;
  }

  ui.swoosh();
  wipe.classList.remove('is-out');
  wipe.classList.add('is-in');
  await wait(330);
  const prev = current;
  prev.leave?.();
  prev.el.remove();
  stage.append(next.el);
  current = next;
  wipe.classList.remove('is-in');
  wipe.classList.add('is-out');
  next.el.classList.add('is-arriving');
  requestAnimationFrame(() => next.enter?.());
  await wait(420);
  wipe.classList.remove('is-out');
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

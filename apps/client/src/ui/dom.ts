/** Small DOM helpers and the shared microinteractions: press ripples, tilt, toasts, counters. */
import { haptic } from '../app/haptics.ts';
import { ui } from '../audio/sfx.ts';

type Child = Node | string | number | null | undefined | false;
type Props = {
  class?: string;
  style?: string | Partial<CSSStyleDeclaration>;
  dataset?: Record<string, string>;
  attrs?: Record<string, string>;
  text?: string;
  html?: string;
  [handler: `on${string}`]: ((event: never) => void) | undefined;
} & Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = value as string;
      else if (key === 'style') {
        if (typeof value === 'string') el.setAttribute('style', value);
        else Object.assign(el.style, value);
      } else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'attrs') for (const [a, v] of Object.entries(value as Record<string, string>)) el.setAttribute(a, v);
      else if (key === 'text') el.textContent = value as string;
      else if (key === 'html') el.innerHTML = value as string;
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      else if (key in el) (el as unknown as Record<string, unknown>)[key] = value;
      else el.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** An inline SVG from markup. */
export function svg(markup: string, className = ''): SVGElement {
  const wrap = document.createElement('div');
  wrap.innerHTML = markup.trim();
  const el = wrap.firstElementChild as SVGElement;
  if (className) el.setAttribute('class', className);
  return el;
}

export interface PressOptions {
  sound?: 'tap' | 'confirm' | 'back' | 'pop' | 'none';
  /** Skip the ink ripple (for elements that animate themselves). */
  noRipple?: boolean;
}

/**
 * Makes an element feel physical: an ink ripple from the touch point, a click and a tick of
 * vibration on press, then runs `action` on click (so keyboards and screen readers work too).
 */
export function press<T extends HTMLElement>(el: T, action: (event: MouseEvent) => void, options: PressOptions = {}): T {
  el.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || (el as unknown as HTMLButtonElement).disabled) return;
    el.classList.add('is-pressed');
    if (!options.noRipple) ripple(el, event);
    haptic('ui');
  });
  const release = () => el.classList.remove('is-pressed');
  el.addEventListener('pointerup', release);
  el.addEventListener('pointerleave', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('click', (event) => {
    if ((el as unknown as HTMLButtonElement).disabled) return;
    const sound = options.sound ?? 'tap';
    if (sound !== 'none') ui[sound]();
    action(event);
  });
  if (matchMedia('(hover: hover)').matches) el.addEventListener('pointerenter', () => ui.hover());
  return el;
}

export function ripple(el: HTMLElement, event: PointerEvent): void {
  const rect = el.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height) * 2.2;
  const dot = h('span', { class: 'ripple' });
  dot.style.width = dot.style.height = `${size}px`;
  dot.style.left = `${event.clientX - rect.left - size / 2}px`;
  dot.style.top = `${event.clientY - rect.top - size / 2}px`;
  el.append(dot);
  dot.addEventListener('animationend', () => dot.remove());
}

/** A gentle 3D tilt that follows the pointer (mouse and pen only). */
export function tilt(el: HTMLElement, strength = 7): void {
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  el.addEventListener('pointermove', (event) => {
    const rect = el.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    el.style.setProperty('--tilt-x', `${(-y * strength).toFixed(2)}deg`);
    el.style.setProperty('--tilt-y', `${(x * strength).toFixed(2)}deg`);
    el.style.setProperty('--glare-x', `${((x + 0.5) * 100).toFixed(1)}%`);
    el.style.setProperty('--glare-y', `${((y + 0.5) * 100).toFixed(1)}%`);
  });
  el.addEventListener('pointerleave', () => {
    el.style.setProperty('--tilt-x', '0deg');
    el.style.setProperty('--tilt-y', '0deg');
  });
}

/** Sets --i on children so CSS can stagger their entrance. */
export function stagger(parent: HTMLElement, startIndex = 0): void {
  Array.from(parent.children).forEach((child, i) => (child as HTMLElement).style.setProperty('--i', String(i + startIndex)));
}

/** Counts a number up with an ease-out. */
export function countUp(el: HTMLElement, to: number, ms = 700, format: (n: number) => string = (n) => String(Math.round(n))): void {
  const start = performance.now();
  const tick = (now: number) => {
    const t = Math.min(1, (now - start) / ms);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = format(to * eased);
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

let toastHost: HTMLElement | null = null;

export function toast(message: string, kind: 'info' | 'error' | 'good' = 'info', ms = 2800): void {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', attrs: { role: 'status', 'aria-live': 'polite' } });
    document.body.append(toastHost);
  }
  const item = h('div', { class: `toast toast-${kind}` }, h('span', { class: 'toast-text', text: message }), h('i', { class: 'toast-bar', style: `animation-duration:${ms}ms` }));
  toastHost.append(item);
  if (kind === 'error') ui.error();
  else ui.pop();
  setTimeout(() => {
    item.classList.add('is-leaving');
    item.addEventListener('animationend', () => item.remove());
  }, ms);
}

/** Types text in letter by letter, for the AI coach's tips. */
export function typewriter(el: HTMLElement, text: string, cps = 55): Promise<void> {
  return new Promise((resolve) => {
    el.textContent = '';
    let i = 0;
    const step = () => {
      i += 1;
      el.textContent = text.slice(0, i);
      if (i % 3 === 0) ui.type();
      if (i < text.length) setTimeout(step, 1000 / cps);
      else resolve();
    };
    step();
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Copies text, falling back to a prompt when the clipboard is blocked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h('textarea', { value: text, style: 'position:fixed;opacity:0' });
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

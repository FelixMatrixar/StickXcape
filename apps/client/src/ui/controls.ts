/**
 * Fight input: an on-screen virtual stick under the left thumb and five buttons under the right
 * (L, H, S, D and Block), plus keyboard and gamepad for desktop testing. Everything folds into
 * the 9-bit button field the engine and the relay use.
 */
import { Button } from '@sticxcape/shared';
import { haptic } from '../app/haptics.ts';
import { settings } from '../app/settings.ts';
import { ui } from '../audio/sfx.ts';
import { h, svg } from './dom.ts';

const SHIELD = '<svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor" aria-hidden="true"><path d="M12 2.5l8 3v6.2c0 4.8-3.4 8.6-8 9.8-4.6-1.2-8-5-8-9.8V5.5z" opacity=".95"/></svg>';

const KEYS: Record<string, number> = {
  ArrowLeft: Button.Left,
  KeyA: Button.Left,
  ArrowRight: Button.Right,
  KeyD: Button.Right,
  ArrowUp: Button.Up,
  KeyW: Button.Up,
  ArrowDown: Button.Down,
  KeyS: Button.Down,
  KeyJ: Button.Light,
  KeyK: Button.Heavy,
  KeyL: Button.Special,
  KeyI: Button.Defense,
  Space: Button.Block,
  ShiftLeft: Button.Block,
  KeyO: Button.Block,
};

interface PadButton {
  bit: number;
  key: string;
  label: string;
  caption: string;
  x: number;
  y: number;
  color: string;
  cls?: string;
}

/** Positions inside the 250 × 196 pad, before scaling. */
const PAD: PadButton[] = [
  { bit: Button.Block, key: 'block', label: '', caption: 'Block', x: 172, y: 118, color: '#4f7cff', cls: 'block' },
  { bit: Button.Light, key: 'l', label: 'L', caption: 'Light', x: 96, y: 128, color: '#e8432d' },
  { bit: Button.Heavy, key: 'h', label: 'H', caption: 'Heavy', x: 112, y: 52, color: '#de3790' },
  { bit: Button.Special, key: 's', label: 'S', caption: 'Special', x: 186, y: 30, color: '#ee960c' },
  { bit: Button.Defense, key: 'd', label: 'D', caption: 'Defense', x: 24, y: 96, color: '#0f9f7c' },
];

export interface ControlsOptions {
  onPause?: () => void;
}

export class Controls {
  readonly el: HTMLElement;
  private stickBits = 0;
  private buttonBits = 0;
  private keyBits = 0;
  private readonly heldKeys = new Map<string, number>();
  private readonly stick: HTMLElement;
  private readonly zone: HTMLElement;
  private stickPointer: number | null = null;
  private home = { x: 0, y: 0 };
  private touchSeen = false;
  private legend: HTMLElement | null = null;
  private readonly cleanup: (() => void)[] = [];
  private lastPadButtons = 0;
  enabled = true;

  constructor(options: ControlsOptions = {}) {
    this.stick = h('div', { class: 'stick' }, h('div', { class: 'wedge' }), h('div', { class: 'knob' }));
    this.zone = h('div', { class: 'stick-zone', attrs: { 'aria-label': 'Move: drag to walk, jump and crouch' } }, this.stick);
    const pad = h('div', { class: 'pad' });
    for (const def of PAD) pad.append(this.padButton(def));
    this.el = h('div', { class: 'controls' }, this.zone, pad);
    this.el.style.setProperty('--ui-scale', String(settings.buttonScale));
    this.bindStick();

    const coarse = matchMedia('(pointer: coarse)').matches;
    if (!coarse) {
      this.el.classList.add('is-desktop');
      pad.style.opacity = '0';
      this.stick.style.opacity = '0';
      this.legend = h(
        'div',
        { class: 'keys-legend' },
        legendItem(['A', 'D'], 'Walk'),
        legendItem(['W'], 'Jump'),
        legendItem(['S'], 'Crouch'),
        legendItem(['J'], 'Light'),
        legendItem(['K'], 'Heavy'),
        legendItem(['L'], 'Special'),
        legendItem(['I'], 'Defense'),
        legendItem(['Space'], 'Block · tap to parry'),
      );
      this.el.append(this.legend);
    }

    const down = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.code === 'Escape' || event.code === 'KeyP') {
        options.onPause?.();
        return;
      }
      const bit = KEYS[event.code];
      if (bit === undefined) return;
      event.preventDefault();
      if (!event.repeat && this.legend) this.fadeLegend();
      this.heldKeys.set(event.code, bit);
      this.recomputeKeys();
    };
    const up = (event: KeyboardEvent) => {
      if (this.heldKeys.delete(event.code)) this.recomputeKeys();
    };
    const blur = () => {
      this.heldKeys.clear();
      this.recomputeKeys();
      this.buttonBits = 0;
      this.stickBits = 0;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    this.cleanup.push(() => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    });
    // The first touch on a laptop with a touch screen reveals the touch controls.
    const touch = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' || this.touchSeen) return;
      this.touchSeen = true;
      pad.style.opacity = '';
      this.stick.style.opacity = '';
      this.fadeLegend();
    };
    window.addEventListener('pointerdown', touch, true);
    this.cleanup.push(() => window.removeEventListener('pointerdown', touch, true));
    requestAnimationFrame(() => this.placeHome());
    const resize = () => this.placeHome();
    window.addEventListener('resize', resize);
    this.cleanup.push(() => window.removeEventListener('resize', resize));
    this.pauseHandler = options.onPause ?? null;
  }

  private pauseHandler: (() => void) | null;

  private fadeLegend(): void {
    if (!this.legend) return;
    const legend = this.legend;
    this.legend = null;
    legend.style.transition = 'opacity .6s';
    setTimeout(() => (legend.style.opacity = '0'), 1800);
    setTimeout(() => legend.remove(), 2600);
  }

  private recomputeKeys(): void {
    let bits = 0;
    for (const bit of this.heldKeys.values()) bits |= bit;
    this.keyBits = bits;
  }

  private padButton(def: PadButton): HTMLElement {
    const face = def.label ? h('b', { text: def.label }) : svg(SHIELD);
    const el = h('button', { class: `cbtn ${def.cls ?? ''}`, attrs: { 'aria-label': def.caption } }, face, h('small', { text: def.caption }));
    el.style.left = `calc(${def.x}px * var(--ui-scale, 1))`;
    el.style.top = `calc(${def.y}px * var(--ui-scale, 1))`;
    el.style.setProperty('--btn-c', def.color);
    const pointers = new Set<number>();
    const release = (event: PointerEvent) => {
      if (!pointers.delete(event.pointerId)) return;
      if (pointers.size === 0) {
        this.buttonBits &= ~def.bit;
        el.classList.remove('is-held');
      }
    };
    el.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      el.setPointerCapture(event.pointerId);
      pointers.add(event.pointerId);
      this.buttonBits |= def.bit;
      el.classList.add('is-held');
      el.classList.remove('flash-ring');
      void el.offsetWidth;
      el.classList.add('flash-ring');
      haptic('button');
      ui.press();
    });
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('lostpointercapture', release);
    el.addEventListener('contextmenu', (event) => event.preventDefault());
    return el;
  }

  private placeHome(): void {
    const rect = this.zone.getBoundingClientRect();
    const scale = settings.buttonScale;
    this.home = { x: Math.max(90 * scale, rect.width * 0.24), y: rect.height - 96 * scale };
    if (this.stickPointer === null) {
      this.stick.style.left = `${this.home.x}px`;
      this.stick.style.top = `${this.home.y}px`;
    }
  }

  private bindStick(): void {
    let originX = 0;
    let originY = 0;
    const radius = () => 64 * settings.buttonScale;
    const move = (event: PointerEvent) => {
      if (event.pointerId !== this.stickPointer) return;
      const r = radius();
      let dx = event.clientX - originX;
      let dy = event.clientY - originY;
      const len = Math.hypot(dx, dy);
      // A floating stick: dragging past the rim pulls the base along.
      if (len > r * 1.15) {
        const pull = (len - r * 1.15) / len;
        originX += dx * pull;
        originY += dy * pull;
        const rect = this.zone.getBoundingClientRect();
        this.stick.style.left = `${originX - rect.left}px`;
        this.stick.style.top = `${originY - rect.top}px`;
        dx = event.clientX - originX;
        dy = event.clientY - originY;
      }
      const clamped = Math.min(1, Math.hypot(dx, dy) / r);
      const angle = Math.atan2(dy, dx);
      const kx = Math.cos(angle) * clamped * r * 0.62;
      const ky = Math.sin(angle) * clamped * r * 0.62;
      this.stick.style.setProperty('--kx', `${kx}px`);
      this.stick.style.setProperty('--ky', `${ky}px`);
      let bits = 0;
      if (clamped > 0.3) {
        const nx = Math.cos(angle);
        const ny = Math.sin(angle);
        if (nx > 0.42) bits |= Button.Right;
        if (nx < -0.42) bits |= Button.Left;
        if (ny < -0.55) bits |= Button.Up;
        if (ny > 0.55) bits |= Button.Down;
      }
      if (bits !== this.stickBits) {
        if (bits !== 0) haptic('button');
        this.stickBits = bits;
      }
      this.stick.classList.toggle('has-dir', bits !== 0);
      this.stick.style.setProperty('--a', `${(angle * 180) / Math.PI + 90}deg`);
    };
    const end = (event: PointerEvent) => {
      if (event.pointerId !== this.stickPointer) return;
      this.stickPointer = null;
      this.stickBits = 0;
      this.stick.classList.remove('is-active', 'has-dir');
      this.stick.style.setProperty('--kx', '0px');
      this.stick.style.setProperty('--ky', '0px');
      this.stick.style.left = `${this.home.x}px`;
      this.stick.style.top = `${this.home.y}px`;
    };
    this.zone.addEventListener('pointerdown', (event) => {
      if (this.stickPointer !== null) return;
      event.preventDefault();
      this.zone.setPointerCapture(event.pointerId);
      this.stickPointer = event.pointerId;
      const rect = this.zone.getBoundingClientRect();
      const r = radius();
      originX = Math.max(rect.left + r * 0.8, Math.min(rect.right - r * 0.8, event.clientX));
      originY = Math.max(rect.top + r * 0.8, Math.min(rect.bottom - r * 0.6, event.clientY));
      this.stick.style.left = `${originX - rect.left}px`;
      this.stick.style.top = `${originY - rect.top}px`;
      this.stick.classList.add('is-active');
      move(event);
    });
    this.zone.addEventListener('pointermove', move);
    this.zone.addEventListener('pointerup', end);
    this.zone.addEventListener('pointercancel', end);
    this.zone.addEventListener('lostpointercapture', end);
  }

  private gamepadBits(): number {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    let bits = 0;
    for (const pad of pads) {
      if (!pad) continue;
      const pressed = (i: number) => pad.buttons[i]?.pressed ?? false;
      const x = pad.axes[0] ?? 0;
      const y = pad.axes[1] ?? 0;
      if (x < -0.45 || pressed(14)) bits |= Button.Left;
      if (x > 0.45 || pressed(15)) bits |= Button.Right;
      if (y < -0.55 || pressed(12)) bits |= Button.Up;
      if (y > 0.55 || pressed(13)) bits |= Button.Down;
      if (pressed(2)) bits |= Button.Light;
      if (pressed(3)) bits |= Button.Heavy;
      if (pressed(1)) bits |= Button.Special;
      if (pressed(0)) bits |= Button.Defense;
      if (pressed(4) || pressed(5) || pressed(6) || pressed(7)) bits |= Button.Block;
      if (pressed(9) && !(this.lastPadButtons & 1)) this.pauseHandler?.();
      this.lastPadButtons = pressed(9) ? 1 : 0;
    }
    return bits;
  }

  /** The buttons held right now, as the 9-bit field. */
  sample(): number {
    if (!this.enabled) return 0;
    return this.stickBits | this.buttonBits | this.keyBits | this.gamepadBits();
  }

  destroy(): void {
    for (const fn of this.cleanup) fn();
    this.el.remove();
  }
}

function legendItem(keys: string[], label: string): HTMLElement {
  return h('span', null, ...keys.map((k) => h('kbd', { text: k })), ` ${label}`);
}

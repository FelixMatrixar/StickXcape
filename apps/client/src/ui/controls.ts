/**
 * Fight input: an on-screen virtual stick and buttons, plus keyboard and gamepad for desktop
 * testing. Everything folds into the 9-bit button field the engine and the relay use.
 *
 * Accessibility (product PRD): there is a two-thumb layout and a one-thumb layout for either
 * hand, and every button can be dragged to where the player's thumbs rest; positions are saved
 * per layout as fractions of the screen, so they survive rotating or changing phones.
 */
import { Button } from '@sticxcape/shared';
import { haptic } from '../app/haptics.ts';
import { settings, updateSettings, type ControlLayout } from '../app/settings.ts';
import { ui } from '../audio/sfx.ts';
import { h, svg } from './dom.ts';

const SHIELD =
  '<svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor" aria-hidden="true"><path d="M12 2.5l8 3v6.2c0 4.8-3.4 8.6-8 9.8-4.6-1.2-8-5-8-9.8V5.5z" opacity=".95"/></svg>';

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

interface ButtonDef {
  key: string;
  /** Empty for the shield icon. */
  label: string;
  caption: string;
  /** Bits held while the button is down. */
  hold: number;
  /** Bits added only for the first frames, such as the direction of a one-thumb combo. */
  pulse?: number;
  color: string;
  /** Size in px at scale 1. */
  size: number;
}

const B = Button;

/** Two thumbs: the stick floats under the left thumb, five buttons under the right. */
const TWO: (ButtonDef & { dx: number; dy: number })[] = [
  // dx, dy: the centre's offset from the bottom-right corner at scale 1.
  { key: 'block', label: '', caption: 'Block', hold: B.Block, color: '#4f7cff', size: 78, dx: 53, dy: 53 },
  { key: 'l', label: 'L', caption: 'Light', hold: B.Light, color: '#e8432d', size: 66, dx: 135, dy: 49 },
  { key: 'h', label: 'H', caption: 'Heavy', hold: B.Heavy, color: '#de3790', size: 66, dx: 119, dy: 125 },
  { key: 's', label: 'S', caption: 'Special', hold: B.Special, color: '#ee960c', size: 66, dx: 45, dy: 147 },
  { key: 'd', label: 'D', caption: 'Defense', hold: B.Defense, color: '#0f9f7c', size: 66, dx: 207, dy: 81 },
];

/**
 * One thumb: a fixed stick ringed by a button for every move. Moves that normally need a
 * direction held with a button (Light 2, Heavy 2, Low, Taunt) get their own button instead.
 */
const ONE: (ButtonDef & { angle: number })[] = [
  { key: 'block', label: '', caption: 'Block', hold: B.Block, color: '#4f7cff', size: 62, angle: 100 },
  { key: 'd', label: 'D', caption: 'Defense', hold: B.Defense, color: '#0f9f7c', size: 56, angle: 130 },
  { key: 'l', label: 'L', caption: 'Light', hold: B.Light, color: '#e8432d', size: 56, angle: 160 },
  { key: 'l2', label: 'L2', caption: 'Light 2', hold: B.Light, pulse: B.Right, color: '#e8432d', size: 56, angle: 190 },
  { key: 'low', label: '↓H', caption: 'Low', hold: B.Heavy, pulse: B.Down, color: '#de3790', size: 56, angle: 220 },
  { key: 'h', label: 'H', caption: 'Heavy', hold: B.Heavy, color: '#de3790', size: 56, angle: 250 },
  { key: 'h2', label: 'H2', caption: 'Heavy 2', hold: B.Heavy, pulse: B.Right, color: '#de3790', size: 56, angle: 280 },
  { key: 's', label: 'S', caption: 'Special', hold: B.Special, color: '#ee960c', size: 56, angle: 310 },
  { key: 'taunt', label: '↓D', caption: 'Taunt', hold: B.Defense, pulse: B.Down, color: '#7a4fe0', size: 56, angle: 340 },
];
const ONE_RING = 112;
const ONE_PAD = 46;
const PULSE_FRAMES = 2;

export const LAYOUT_NAMES: Record<ControlLayout, string> = { two: 'Two thumbs', oneRight: 'One thumb, right', oneLeft: 'One thumb, left' };

export interface ControlsOptions {
  onPause?: () => void;
  /** Drag elements around instead of pressing them (the layout editor). */
  editing?: boolean;
  layout?: ControlLayout;
}

interface PadButton {
  def: ButtonDef;
  el: HTMLButtonElement;
  pointers: Set<number>;
  x: number;
  y: number;
}

export class Controls {
  readonly el: HTMLElement;
  readonly layoutId: ControlLayout;
  readonly editing: boolean;
  private stickBits = 0;
  private holdBits = 0;
  private pulseBits = 0;
  private pulseLeft = 0;
  private keyBits = 0;
  private readonly heldKeys = new Map<string, number>();
  private readonly stick: HTMLElement;
  private readonly zone: HTMLElement;
  private readonly buttons: PadButton[] = [];
  private stickPointer: number | null = null;
  /** Where the stick rests (two thumbs) or sits (one thumb), in screen px. */
  private home = { x: 0, y: 0 };
  private touchSeen = false;
  private legend: HTMLElement | null = null;
  private readonly cleanup: (() => void)[] = [];
  private lastPadButtons = 0;
  private readonly pauseHandler: (() => void) | null;
  enabled = true;

  constructor(options: ControlsOptions = {}) {
    this.layoutId = options.layout ?? settings.controlLayout;
    this.editing = options.editing ?? false;
    this.pauseHandler = options.onPause ?? null;
    const one = this.layoutId !== 'two';
    this.stick = h('div', { class: 'stick' }, h('div', { class: 'wedge' }), h('div', { class: 'knob' }));
    this.zone = h('div', { class: `stick-zone${one ? ' is-fixed' : ''}`, attrs: { 'aria-label': 'Move: drag to walk, jump and crouch' } }, this.stick);
    this.el = h('div', { class: `controls${this.editing ? ' is-editing' : ''}` }, this.zone);
    for (const def of one ? ONE : TWO) {
      const face = def.label ? h('b', { text: def.label }) : svg(SHIELD);
      const el = h('button', { class: `cbtn${def.key === 'block' ? ' block' : ''}`, attrs: { 'aria-label': def.caption } }, face, h('small', { text: def.caption }));
      el.style.setProperty('--btn-c', def.color);
      const button: PadButton = { def, el, pointers: new Set(), x: 0, y: 0 };
      if (this.editing) this.bindDrag(el, def.key, def.size, (x, y) => this.moveButton(button, x, y));
      else this.bindButton(button);
      this.buttons.push(button);
      this.el.append(el);
    }
    if (this.editing) this.bindDrag(this.stick, one ? 'pad' : 'stick', one ? ONE_PAD * 2 : 128, (x, y) => this.moveStick(x, y));
    else this.bindStick();

    const coarse = matchMedia('(pointer: coarse)').matches;
    if (!coarse && !this.editing) {
      this.el.classList.add('is-desktop');
      this.legend = h(
        'div',
        { class: 'keys-legend' },
        legendItem(['A', 'D'], 'Walk'),
        legendItem(['W'], 'Jump'),
        legendItem(['S'], 'Crouch'),
        legendItem(['J'], 'Light'),
        legendItem(['K'], 'Heavy'),
        legendItem(['J', 'K'], 'Grab'),
        legendItem(['L'], 'Special'),
        legendItem(['I'], 'Defense'),
        legendItem(['Space'], 'Block · tap to parry'),
      );
      this.el.append(this.legend);
    }

    if (!this.editing) this.bindKeys();
    requestAnimationFrame(() => this.layout());
    const resize = () => this.layout();
    window.addEventListener('resize', resize);
    this.cleanup.push(() => window.removeEventListener('resize', resize));
    // Lay out again once the controls are on screen, and whenever their space changes. The stick
    // rests relative to its zone, which reads as starting at the top until the screen is
    // attached, and an in-app browser's toolbar can change the space without a window resize.
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(resize);
      observer.observe(this.el);
      this.cleanup.push(() => observer.disconnect());
    }
  }

  private bindKeys(): void {
    const down = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.code === 'Escape' || event.code === 'KeyP') {
        this.pauseHandler?.();
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
      this.holdBits = 0;
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
      this.el.classList.remove('is-desktop');
      this.fadeLegend();
    };
    window.addEventListener('pointerdown', touch, true);
    this.cleanup.push(() => window.removeEventListener('pointerdown', touch, true));
  }

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

  // Layout.

  /** Places every element from the layout's defaults and the player's saved positions. */
  layout(): void {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const s = uiScale();
    const safe = safeInsets();
    const saved = settings.controlPositions[this.layoutId] ?? {};
    this.el.style.setProperty('--ui-scale', String(s));
    const fromSaved = (key: string): { x: number; y: number } | null => {
      const p = saved[key];
      return p ? { x: p.x * W, y: p.y * H } : null;
    };
    if (this.layoutId === 'two') {
      const zoneW = W * 0.46;
      this.home = fromSaved('stick') ?? { x: safe.left + Math.max(90 * s, zoneW * 0.24), y: H - safe.bottom - 96 * s };
      this.zone.removeAttribute('style');
      for (const b of this.buttons) {
        const def = b.def as ButtonDef & { dx: number; dy: number };
        const p = fromSaved(def.key) ?? { x: W - safe.right - def.dx * s, y: H - safe.bottom - def.dy * s };
        this.placeButton(b, p.x, p.y, s);
      }
    } else {
      const right = this.layoutId === 'oneRight';
      const centre = { x: right ? W - safe.right - 150 * s : safe.left + 150 * s, y: H - safe.bottom - 140 * s };
      this.home = fromSaved('pad') ?? centre;
      // Buttons left where they are follow the stick if it was moved.
      for (const b of this.buttons) {
        const def = b.def as ButtonDef & { angle: number };
        const angle = ((right ? def.angle : 180 - def.angle) * Math.PI) / 180;
        const p = fromSaved(def.key) ?? { x: this.home.x + Math.cos(angle) * ONE_RING * s, y: this.home.y + Math.sin(angle) * ONE_RING * s };
        this.placeButton(b, p.x, p.y, s);
      }
      const r = ONE_PAD * s * 1.45;
      Object.assign(this.zone.style, { left: `${this.home.x - r}px`, top: `${this.home.y - r}px`, width: `${r * 2}px`, height: `${r * 2}px`, bottom: 'auto' });
    }
    this.restStick();
  }

  private placeButton(b: PadButton, x: number, y: number, s: number): void {
    const size = b.def.size * s;
    const half = size / 2 + 4;
    b.x = Math.max(half, Math.min(window.innerWidth - half, x));
    b.y = Math.max(half, Math.min(window.innerHeight - half, y));
    Object.assign(b.el.style, { left: `${b.x - size / 2}px`, top: `${b.y - size / 2}px`, width: `${size}px`, height: `${size}px` });
    // Labels scale with each button.
    b.el.style.setProperty('--ui-scale', String((s * b.def.size) / 66));
  }

  /** Puts the stick back at its home, in the zone's coordinates. */
  private restStick(): void {
    const rect = this.zone.getBoundingClientRect();
    const one = this.layoutId !== 'two';
    const size = one ? ONE_PAD * 2 * uiScale() : 128 * uiScale();
    Object.assign(this.stick.style, { width: `${size}px`, height: `${size}px`, margin: `${-size / 2}px 0 0 ${-size / 2}px` });
    if (this.stickPointer === null) {
      this.stick.style.left = `${this.home.x - rect.left}px`;
      this.stick.style.top = `${this.home.y - rect.top}px`;
    }
  }

  // Pressing.

  private bindButton(b: PadButton): void {
    const { el, def } = b;
    const release = (event: PointerEvent) => {
      if (!b.pointers.delete(event.pointerId)) return;
      if (b.pointers.size === 0) {
        this.holdBits = this.buttons.reduce((bits, other) => (other.pointers.size > 0 ? bits | other.def.hold : bits), 0);
        el.classList.remove('is-held');
      }
    };
    el.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      capture(el, event.pointerId);
      b.pointers.add(event.pointerId);
      this.holdBits |= def.hold;
      if (def.pulse) {
        this.pulseBits = def.pulse;
        this.pulseLeft = PULSE_FRAMES;
      }
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
  }

  private bindStick(): void {
    const fixed = this.layoutId !== 'two';
    let originX = 0;
    let originY = 0;
    const radius = () => (fixed ? ONE_PAD : 64) * uiScale();
    const move = (event: PointerEvent) => {
      if (event.pointerId !== this.stickPointer) return;
      const r = radius();
      let dx = event.clientX - originX;
      let dy = event.clientY - originY;
      const len = Math.hypot(dx, dy);
      // The floating stick's base follows a thumb that drags past the rim; the fixed one stays put.
      if (!fixed && len > r * 1.15) {
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
      this.stick.style.setProperty('--kx', `${Math.cos(angle) * clamped * r * 0.62}px`);
      this.stick.style.setProperty('--ky', `${Math.sin(angle) * clamped * r * 0.62}px`);
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
      this.restStick();
    };
    this.zone.addEventListener('pointerdown', (event) => {
      if (this.stickPointer !== null) return;
      event.preventDefault();
      capture(this.zone, event.pointerId);
      this.stickPointer = event.pointerId;
      const rect = this.zone.getBoundingClientRect();
      const r = radius();
      if (fixed) {
        originX = this.home.x;
        originY = this.home.y;
      } else {
        originX = Math.max(rect.left + r * 0.8, Math.min(rect.right - r * 0.8, event.clientX));
        originY = Math.max(rect.top + r * 0.8, Math.min(rect.bottom - r * 0.6, event.clientY));
        this.stick.style.left = `${originX - rect.left}px`;
        this.stick.style.top = `${originY - rect.top}px`;
      }
      this.stick.classList.add('is-active');
      move(event);
    });
    this.zone.addEventListener('pointermove', move);
    this.zone.addEventListener('pointerup', end);
    this.zone.addEventListener('pointercancel', end);
    this.zone.addEventListener('lostpointercapture', end);
  }

  // Arranging (the layout editor).

  private bindDrag(el: HTMLElement, key: string, size: number, place: (x: number, y: number) => void): void {
    let offX = 0;
    let offY = 0;
    let dragging = false;
    el.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      capture(el, event.pointerId);
      const rect = el.getBoundingClientRect();
      offX = event.clientX - (rect.left + rect.width / 2);
      offY = event.clientY - (rect.top + rect.height / 2);
      dragging = true;
      el.classList.add('is-dragging');
      haptic('button');
      ui.pop();
    });
    el.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      place(event.clientX - offX, event.clientY - offY);
    });
    const drop = (event: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('is-dragging');
      const rect = el.getBoundingClientRect();
      const x = (rect.left + rect.width / 2) / window.innerWidth;
      const y = (rect.top + rect.height / 2) / window.innerHeight;
      const current = settings.controlPositions[this.layoutId] ?? {};
      updateSettings({ controlPositions: { ...settings.controlPositions, [this.layoutId]: { ...current, [key]: { x, y } } } });
      ui.tap();
      void event;
      void size;
      // Buttons that follow the stick move with it in one-thumb layouts.
      if (key === 'pad') this.layout();
    };
    el.addEventListener('pointerup', drop);
    el.addEventListener('pointercancel', drop);
  }

  private moveButton(b: PadButton, x: number, y: number): void {
    this.placeButton(b, x, y, uiScale());
  }

  private moveStick(x: number, y: number): void {
    this.home = { x, y };
    if (this.layoutId !== 'two') {
      const r = ONE_PAD * uiScale() * 1.45;
      Object.assign(this.zone.style, { left: `${x - r}px`, top: `${y - r}px`, width: `${r * 2}px`, height: `${r * 2}px`, bottom: 'auto' });
    }
    this.restStick();
  }

  /** Forgets the saved positions for this layout. */
  reset(): void {
    const next = { ...settings.controlPositions };
    delete next[this.layoutId];
    updateSettings({ controlPositions: next });
    this.layout();
  }

  // Sampling.

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

  /** The buttons held right now, as the 9-bit field. Call once per simulated frame. */
  sample(): number {
    if (!this.enabled || this.editing) return 0;
    let pulse = 0;
    if (this.pulseLeft > 0) {
      this.pulseLeft -= 1;
      pulse = this.pulseBits;
    }
    return this.stickBits | this.holdBits | pulse | this.keyBits | this.gamepadBits();
  }

  destroy(): void {
    for (const fn of this.cleanup) fn();
    this.el.remove();
  }
}

/** Control size: the player's setting, scaled down on short screens (a phone held sideways). */
function uiScale(): number {
  return settings.buttonScale * Math.max(0.72, Math.min(1.1, window.innerHeight / 470));
}

let probe: HTMLElement | null = null;

/** The safe-area insets (notches, home bars), read through a hidden element. */
function safeInsets(): { top: number; right: number; bottom: number; left: number } {
  if (!probe) {
    probe = h('div', { style: 'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)' });
    document.body.append(probe);
  }
  const cs = getComputedStyle(probe);
  return { top: parseFloat(cs.paddingTop) || 0, right: parseFloat(cs.paddingRight) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0 };
}

/** Pointer capture keeps a held button pressed when the thumb slides off it; some pointers refuse it. */
function capture(el: Element, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // Without capture the press still counts; it ends on pointerup or pointerleave.
  }
}

function legendItem(keys: string[], label: string): HTMLElement {
  return h('span', null, ...keys.map((k) => h('kbd', { text: k })), ` ${label}`);
}

/**
 * Pop-ups near the fighters: PARRY, COUNTER, BLOCKED, WHIFF and the combo count. They punch in
 * on a spring, tilt a little, drift up and fade, so players always know what just happened.
 */
import type { FightCamera } from './camera.ts';

export interface PopupStyle {
  fill: string;
  stroke: string;
  /** Text height in metres on the fight plane. */
  size: number;
  /** Extra line under the main text, such as "HITS". */
  sub?: string;
  tilt?: number;
  life?: number;
  rise?: number;
}

interface Popup {
  text: string;
  x: number;
  y: number;
  age: number;
  life: number;
  scale: number;
  vel: number;
  style: PopupStyle;
  tilt: number;
  key: string | null;
}

export const DISPLAY_FONT = '"Anton", Impact, "Arial Narrow Bold", sans-serif';

export class Popups {
  private readonly list: Popup[] = [];

  /** Shows a pop-up. A `key` replaces any live pop-up with the same key (combo counters). */
  show(text: string, x: number, y: number, style: PopupStyle, key: string | null = null): void {
    if (key) {
      const live = this.list.find((p) => p.key === key);
      if (live) {
        live.text = text;
        live.age = 0;
        live.scale = 0.6;
        live.vel = 9;
        live.x = x;
        live.y = y;
        live.style = style;
        return;
      }
    }
    if (this.list.length > 12) this.list.shift();
    this.list.push({ text, x, y, age: 0, life: style.life ?? 0.9, scale: 0.2, vel: 14, style, tilt: (style.tilt ?? 0.12) * (Math.random() - 0.5) * 2, key });
  }

  clear(): void {
    this.list.length = 0;
  }

  update(dt: number): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.age += dt;
      // Spring toward full size with a bouncy overshoot.
      p.vel += (1 - p.scale) * 320 * dt - p.vel * 16 * dt;
      p.scale += p.vel * dt;
      p.y += (p.style.rise ?? 0.35) * dt;
      if (p.age >= p.life) this.list.splice(i, 1);
    }
  }

  draw(ctx: CanvasRenderingContext2D, cam: FightCamera): void {
    for (const p of this.list) {
      const fade = Math.min(1, (p.life - p.age) / 0.25);
      const px = cam.sx(p.x);
      const py = cam.sy(p.y);
      const size = Math.max(12, p.style.size * cam.ppm);
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(p.tilt);
      ctx.scale(p.scale, p.scale);
      ctx.globalAlpha = fade;
      ctx.font = `${Math.round(size)}px ${DISPLAY_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = size * 0.22;
      ctx.strokeStyle = p.style.stroke;
      ctx.strokeText(p.text, 0, 0);
      ctx.fillStyle = p.style.fill;
      ctx.fillText(p.text, 0, 0);
      if (p.style.sub) {
        const sub = size * 0.42;
        ctx.font = `${Math.round(sub)}px ${DISPLAY_FONT}`;
        ctx.lineWidth = sub * 0.26;
        ctx.strokeText(p.style.sub, 0, size * 0.68);
        ctx.fillText(p.style.sub, 0, size * 0.68);
      }
      ctx.restore();
    }
  }
}

export const POP = {
  parry: { fill: '#fff6d8', stroke: '#c48a12', size: 0.34, life: 1.0, tilt: 0.08 } as PopupStyle,
  counter: { fill: '#ffffff', stroke: '#e8432d', size: 0.26, life: 0.85 } as PopupStyle,
  blocked: { fill: '#e9eefc', stroke: '#3a4a74', size: 0.18, life: 0.6 } as PopupStyle,
  whiff: { fill: '#f1ece2', stroke: '#6f6a62', size: 0.17, life: 0.6, rise: 0.5 } as PopupStyle,
  armor: { fill: '#e8eef3', stroke: '#465663', size: 0.17, life: 0.6 } as PopupStyle,
  damage: { fill: '#ffffff', stroke: '#1d1b1a', size: 0.14, life: 0.55, rise: 0.8 } as PopupStyle,
};

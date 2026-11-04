/**
 * A small looping stick-man preview: one move on its own, for loadout cards, Move Studio's
 * replay, the home screen and the results screen. Pauses itself when off screen.
 */
import type { MoveFile } from '@sticxcape/shared';
import { compileMove, recordedFrame, sampleMove, type CompiledMove } from '../engine/moves.ts';
import { builtinPose, P } from '../engine/poses.ts';
import { createPose, J, JOINT_COUNT } from '../engine/skeleton.ts';
import type { Ink } from './inks.ts';
import { jointsBetween } from './pose.ts';
import { drawFigure } from './stickman.ts';

export interface PreviewOptions {
  ink: Ink;
  /** Fill colour behind the figure; null leaves the canvas transparent. */
  background?: string | null;
  floor?: string | null;
  /** Metres of world shown across the canvas height. */
  span?: number;
  /** Pause between loops, seconds. */
  rest?: number;
  facing?: 1 | -1;
  /** Plays at its own speed and loops forever. */
  loop?: boolean;
  trails?: boolean;
  outline?: string | null;
}

const TIPS = [J.lWrist, J.rWrist, J.lToe, J.rToe];

export class MovePreview {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private move: CompiledMove | null = null;
  private readonly options: Required<PreviewOptions>;
  private raf = 0;
  private visible = true;
  private start = 0;
  private readonly a = createPose();
  private readonly b = createPose();
  private readonly local = new Float32Array(JOINT_COUNT * 2);
  private readonly screen = new Float32Array(JOINT_COUNT * 2);
  private readonly trail: { x: number; y: number; t: number }[][] = TIPS.map(() => []);
  private observer: IntersectionObserver | null = null;
  /** Called each frame with the recorded frame shown, for Move Studio's trim playhead. */
  onFrame: ((frame: number) => void) | null = null;
  /** Restricts playback to recorded frames [from, to]. */
  range: [number, number] | null = null;
  speed = 1;
  private rootStart = 0;

  constructor(canvas: HTMLCanvasElement, options: PreviewOptions) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.options = {
      background: null,
      floor: 'rgba(22,21,20,0.18)',
      span: 2.3,
      rest: 0.5,
      facing: 1,
      loop: true,
      trails: true,
      outline: 'rgba(255,250,240,0.92)',
      ...options,
    };
    if (typeof IntersectionObserver === 'function') {
      this.observer = new IntersectionObserver((entries) => {
        this.visible = entries.some((e) => e.isIntersecting);
        if (this.visible && !this.raf) this.loop();
      });
      this.observer.observe(canvas);
    }
  }

  setInk(ink: Ink): void {
    this.options.ink = ink;
  }

  setMove(file: MoveFile | null): void {
    this.move = file ? compileMove(file, 0) : null;
    this.start = performance.now();
    for (const t of this.trail) t.length = 0;
    if (this.move) {
      sampleMove(this.move, 0, this.a);
      this.rootStart = this.a[0];
    }
  }

  play(): void {
    this.start = performance.now();
    if (!this.raf) this.loop();
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  destroy(): void {
    this.stop();
    this.observer?.disconnect();
  }

  private loop = (): void => {
    this.raf = 0;
    if (!this.visible || !this.canvas.isConnected) return;
    this.draw(performance.now());
    this.raf = requestAnimationFrame(this.loop);
  };

  private fit(): { w: number; h: number } {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(rect.width * ratio));
    const hgt = Math.max(1, Math.round(rect.height * ratio));
    if (this.canvas.width !== w || this.canvas.height !== hgt) {
      this.canvas.width = w;
      this.canvas.height = hgt;
    }
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { w: rect.width, h: rect.height };
  }

  draw(now: number): void {
    const { w, h } = this.fit();
    const ctx = this.ctx;
    if (this.options.background) {
      ctx.fillStyle = this.options.background;
      ctx.fillRect(0, 0, w, h);
    } else {
      ctx.clearRect(0, 0, w, h);
    }
    const t = ((now - this.start) / 1000) * this.speed;
    const move = this.move;
    let rootX = 0;
    if (move) {
      const first = this.range ? this.range[0] : 0;
      const last = this.range ? this.range[1] : move.frameCount - 1;
      const length = (last - first + 1) / 60;
      const cycle = length + this.options.rest;
      const into = this.options.loop ? t % cycle : Math.min(t, length);
      const frame = Math.min(last, first + into * 60);
      const r16 = Math.floor(frame * 65536);
      sampleMove(move, move.rules.natural ? r16 : r16, this.a);
      rootX = (this.a[0] - this.rootStart) / 65536;
      this.a[0] = 0;
      jointsBetween(this.a, this.a, 0, this.local);
      this.onFrame?.(frame);
      void recordedFrame;
    } else {
      builtinPose(this.a, P.stance, Math.floor(t * 60));
      this.b.set(this.a);
      jointsBetween(this.a, this.b, 0, this.local);
    }
    const scale = h / this.options.span;
    const floorY = h * 0.9;
    // Keep the body centred even when the move travels.
    const centerX = w / 2 - Math.max(-0.6, Math.min(0.6, rootX * 0.5)) * scale * this.options.facing;
    for (let j = 0; j < JOINT_COUNT; j++) {
      this.screen[2 * j] = centerX + (this.local[2 * j] + rootX) * scale * this.options.facing;
      this.screen[2 * j + 1] = floorY - this.local[2 * j + 1] * scale;
    }
    if (this.options.floor) {
      ctx.fillStyle = this.options.floor;
      ctx.beginPath();
      ctx.ellipse(this.screen[2 * J.pelvis], floorY + 2, scale * 0.42, Math.max(2, scale * 0.06), 0, 0, Math.PI * 2);
      ctx.fill();
    }
    if (this.options.trails) this.drawTrails(ctx, now);
    drawFigure(ctx, this.screen, { ink: this.options.ink, scale, facing: this.options.facing, outline: this.options.outline });
  }

  private drawTrails(ctx: CanvasRenderingContext2D, now: number): void {
    const ink = this.options.ink;
    TIPS.forEach((tip, i) => {
      const list = this.trail[i];
      const x = this.screen[2 * tip];
      const y = this.screen[2 * tip + 1];
      const last = list[list.length - 1];
      const moved = last ? Math.hypot(x - last.x, y - last.y) : 0;
      if (!last || moved > 2) list.push({ x, y, t: now });
      while (list.length > 0 && now - list[0].t > 110) list.shift();
      if (list.length < 3) return;
      const speed = moved;
      if (speed < 3) return;
      ctx.lineCap = 'round';
      for (let n = 1; n < list.length; n++) {
        const k = n / list.length;
        ctx.strokeStyle = `rgba(${ink.rgb[0]},${ink.rgb[1]},${ink.rgb[2]},${0.4 * k})`;
        ctx.lineWidth = Math.max(1, 7 * k);
        ctx.beginPath();
        ctx.moveTo(list[n - 1].x, list[n - 1].y);
        ctx.lineTo(list[n].x, list[n].y);
        ctx.stroke();
      }
    });
  }
}

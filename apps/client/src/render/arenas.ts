/**
 * The two official arenas (AR-1), painted in a muted ink wash so the stick men stand out. Each
 * is a little 2.5D stage: a sky, layers at depths behind the fight plane (parallax comes from
 * the camera dollying), a perspective floor, and some life: lights, lanterns, leaves, birds.
 */
import { ARENA_FORMAT_VERSION, type ArenaFile } from '@sticxcape/shared';
import type { FightCamera } from './camera.ts';
import { K, type Particles } from './particles.ts';

export interface ArenaArt {
  id: string;
  name: string;
  file: ArenaFile;
  /** Short line for the arena picker. */
  blurb: string;
  /** Colours for menus and thumbnails. */
  swatch: [string, string, string];
  draw(ctx: CanvasRenderingContext2D, cam: FightCamera, t: number): void;
  /** Drawn over the fighters (kept light so it never hides them). */
  drawFront(ctx: CanvasRenderingContext2D, cam: FightCamera, t: number): void;
  ambient(ps: Particles, cam: FightCamera, dt: number): void;
}

const WIDTH = 10;

function arenaFile(id: string, name: string): ArenaFile {
  return {
    id,
    version: ARENA_FORMAT_VERSION,
    name,
    layers: [`builtin:${id}`],
    floor: 0,
    width: WIDTH,
    spawns: [3.6, 6.4],
    ledges: [],
    edges: { left: 'wall', right: 'wall' },
  };
}

/** Seeded random numbers so the art paints the same every time. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A layer painted once in metres and drawn at its depth. */
interface Layer {
  canvas: HTMLCanvasElement;
  depth: number;
  /** World rectangle it covers, metres. */
  x0: number;
  y0: number;
  w: number;
  h: number;
}

const RES = 48;

function makeLayer(depth: number, x0: number, y0: number, w: number, h: number, paint: (g: CanvasRenderingContext2D, px: (m: number) => number, py: (m: number) => number) => void): Layer {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(w * RES);
  canvas.height = Math.ceil(h * RES);
  const g = canvas.getContext('2d')!;
  paint(
    g,
    (m) => (m - x0) * RES,
    (m) => (y0 + h - m) * RES,
  );
  return { canvas, depth, x0, y0, w, h };
}

function drawLayer(ctx: CanvasRenderingContext2D, cam: FightCamera, layer: Layer): void {
  const x = cam.sx(layer.x0, layer.depth);
  const y = cam.sy(layer.y0 + layer.h, layer.depth);
  const k = cam.k(layer.depth);
  ctx.drawImage(layer.canvas, x, y, layer.w * k, layer.h * k);
}

let paperPattern: CanvasPattern | null = null;

/** A faint paper grain laid over the whole scene. */
export function paperGrain(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  if (paperPattern) return paperPattern;
  const tile = document.createElement('canvas');
  tile.width = tile.height = 160;
  const g = tile.getContext('2d')!;
  const rand = seeded(42);
  const img = g.createImageData(160, 160);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 128 + (rand() - 0.5) * 70;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 22;
  }
  g.putImageData(img, 0, 0);
  paperPattern = ctx.createPattern(tile, 'repeat');
  return paperPattern;
}

// Rooftop at dusk.

function rooftop(): ArenaArt {
  const rand = seeded(7);
  const far: Layer = makeLayer(26, -30, 0, 70, 22, (g, px, py) => {
    g.fillStyle = 'rgba(122, 86, 112, 0.42)';
    let x = -30;
    while (x < 40) {
      const w = 1.5 + rand() * 4;
      const h = 4 + rand() * 12;
      g.fillRect(px(x), py(h), w * RES, h * RES);
      if (rand() < 0.3) g.fillRect(px(x + w * 0.4), py(h + 2.5), 0.12 * RES, 2.5 * RES);
      x += w + rand() * 0.6;
    }
  });
  const mid: Layer = makeLayer(11, -16, 0, 42, 14, (g, px, py) => {
    let x = -16;
    while (x < 26) {
      const w = 1.8 + rand() * 3.2;
      const h = 3 + rand() * 7.5;
      g.fillStyle = 'rgba(78, 52, 74, 0.62)';
      g.fillRect(px(x), py(h), w * RES, h * RES);
      // Windows, some lit.
      for (let wy = 1; wy < h - 0.6; wy += 0.9) {
        for (let wx = x + 0.35; wx < x + w - 0.4; wx += 0.7) {
          const lit = rand();
          g.fillStyle = lit < 0.22 ? 'rgba(255, 214, 140, 0.85)' : lit < 0.3 ? 'rgba(255, 170, 120, 0.6)' : 'rgba(40, 26, 40, 0.35)';
          g.fillRect(px(wx), py(wy + 0.35), 0.28 * RES, 0.35 * RES);
        }
      }
      if (rand() < 0.35) {
        // Water tower.
        g.fillStyle = 'rgba(58, 38, 56, 0.7)';
        const tx = x + w * 0.5;
        g.fillRect(px(tx - 0.5), py(h + 1.6), 1.0 * RES, 1.0 * RES);
        g.beginPath();
        g.moveTo(px(tx - 0.6), py(h + 1.6));
        g.lineTo(px(tx), py(h + 2.1));
        g.lineTo(px(tx + 0.6), py(h + 1.6));
        g.fill();
        g.fillRect(px(tx - 0.4), py(h + 0.6), 0.08 * RES, 0.6 * RES);
        g.fillRect(px(tx + 0.32), py(h + 0.6), 0.08 * RES, 0.6 * RES);
      }
      x += w + 0.2 + rand() * 0.8;
    }
  });
  const near: Layer = makeLayer(3.2, -6, 0, 22, 4, (g, px, py) => {
    // Parapet wall behind the fight line, AC units and pipes.
    g.fillStyle = '#3a2d3a';
    g.fillRect(px(-6), py(1.05), 22 * RES, 1.05 * RES);
    g.fillStyle = 'rgba(255, 210, 180, 0.18)';
    g.fillRect(px(-6), py(1.05), 22 * RES, 0.06 * RES);
    for (let x = -5; x < 16; x += 2.6 + rand() * 2) {
      g.fillStyle = '#2c222c';
      const w = 0.9 + rand() * 0.7;
      const h = 0.6 + rand() * 0.5;
      g.fillRect(px(x), py(1.05 + h), w * RES, h * RES);
      g.strokeStyle = 'rgba(255,220,200,0.12)';
      g.lineWidth = 2;
      for (let i = 1; i < 4; i++) {
        g.beginPath();
        g.moveTo(px(x + 0.1), py(1.05 + (h * i) / 4));
        g.lineTo(px(x + w - 0.1), py(1.05 + (h * i) / 4));
        g.stroke();
      }
    }
    g.strokeStyle = '#2a1f2a';
    g.lineWidth = 0.06 * RES;
    g.beginPath();
    g.moveTo(px(-6), py(1.55));
    g.lineTo(px(16), py(1.55));
    g.stroke();
    for (let x = -6; x < 16; x += 1.2) {
      g.beginPath();
      g.moveTo(px(x), py(1.05));
      g.lineTo(px(x), py(1.6));
      g.stroke();
    }
  });

  const birds = Array.from({ length: 5 }, () => ({ x: rand(), y: rand(), s: 0.6 + rand() * 0.6 }));
  const lights = Array.from({ length: 6 }, () => ({ x: -10 + rand() * 30, y: 8 + rand() * 7, phase: rand() * 6 }));

  return {
    id: 'rooftop',
    name: 'Rooftop at Dusk',
    blurb: 'Warm wind over a sleeping city',
    swatch: ['#f2c6a8', '#9a6a86', '#2c222c'],
    file: arenaFile('rooftop', 'Rooftop at Dusk'),
    draw(ctx, cam, t) {
      const { width: w, height: h } = cam;
      const sky = ctx.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, '#f6dcc6');
      sky.addColorStop(0.45, '#ecbca6');
      sky.addColorStop(0.8, '#cf9fae');
      sky.addColorStop(1, '#a88098');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, w, h);
      // Sun, far away so it barely moves.
      const sunX = cam.sx(3.5, 400);
      const sunY = cam.sy(42, 400);
      const sunR = cam.k(400) * 9;
      const glow = ctx.createRadialGradient(sunX, sunY, sunR * 0.6, sunX, sunY, sunR * 3.4);
      glow.addColorStop(0, 'rgba(255, 240, 214, 0.75)');
      glow.addColorStop(1, 'rgba(255, 240, 214, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(255, 246, 228, 0.92)';
      ctx.beginPath();
      ctx.arc(sunX, sunY, sunR, 0, Math.PI * 2);
      ctx.fill();
      // Cloud wisps.
      ctx.fillStyle = 'rgba(255, 236, 222, 0.45)';
      for (let i = 0; i < 4; i++) {
        const cx = cam.sx(((i * 17 + t * 0.4) % 80) - 30, 60);
        const cy = cam.sy(20 + i * 3.5, 60);
        const k = cam.k(60);
        ctx.beginPath();
        ctx.ellipse(cx, cy, 9 * k, 0.7 * k, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      drawLayer(ctx, cam, far);
      // Antenna lights blink.
      for (const light of lights) {
        const on = Math.sin(t * 2.2 + light.phase) > 0.55;
        if (!on) continue;
        ctx.fillStyle = 'rgba(255, 90, 70, 0.9)';
        ctx.beginPath();
        ctx.arc(cam.sx(light.x, 26), cam.sy(light.y, 26), Math.max(1.5, cam.k(26) * 0.12), 0, Math.PI * 2);
        ctx.fill();
      }
      // Birds glide across now and then.
      ctx.strokeStyle = 'rgba(60, 40, 60, 0.55)';
      ctx.lineWidth = 1.4;
      for (const bird of birds) {
        const cycle = (t * 0.03 * bird.s + bird.x) % 1;
        const bx = cam.sx(-20 + cycle * 60, 40);
        const by = cam.sy(16 + bird.y * 8 + Math.sin(t * 0.7 + bird.x * 9) * 0.6, 40);
        const flap = Math.sin(t * 9 * bird.s + bird.y * 20) * 3;
        ctx.beginPath();
        ctx.moveTo(bx - 6, by - flap);
        ctx.quadraticCurveTo(bx - 2, by - 2, bx, by);
        ctx.quadraticCurveTo(bx + 2, by - 2, bx + 6, by - flap);
        ctx.stroke();
      }
      drawLayer(ctx, cam, mid);
      drawLayer(ctx, cam, near);
      drawFloor(ctx, cam, 3.2, '#3b2f3b', '#221a23', 'rgba(255, 214, 190, 0.2)', 'rgba(20, 12, 20, 0.35)', t, 'seams');
    },
    drawFront(ctx, cam) {
      // A soft dusk haze at the bottom edge.
      const g = ctx.createLinearGradient(0, cam.height * 0.86, 0, cam.height);
      g.addColorStop(0, 'rgba(34, 24, 34, 0)');
      g.addColorStop(1, 'rgba(34, 24, 34, 0.35)');
      ctx.fillStyle = g;
      ctx.fillRect(0, cam.height * 0.86, cam.width, cam.height * 0.14);
    },
    ambient(ps, cam, dt) {
      if (Math.random() < dt * 3) {
        ps.spawn(K.mote, cam.x + (Math.random() - 0.5) * 12, Math.random() * 3, {
          vx: 0.25 + Math.random() * 0.3,
          vy: 0.05 + Math.random() * 0.15,
          life: 3 + Math.random() * 3,
          size: 0.012 + Math.random() * 0.01,
          color: 'rgba(255, 200, 150, 0.9)',
          depth: Math.random() * 3,
          front: false,
        });
      }
    },
  };
}

// Bamboo dojo.

function dojo(): ArenaArt {
  const rand = seeded(11);
  const bamboo: Layer = makeLayer(14, -20, 0, 50, 16, (g, px, py) => {
    for (let i = 0; i < 70; i++) {
      const x = -20 + rand() * 50;
      const shade = 0.18 + rand() * 0.3;
      const w = 0.12 + rand() * 0.14;
      g.fillStyle = `rgba(70, 96, 72, ${shade})`;
      g.fillRect(px(x), py(16), w * RES, 16 * RES);
      g.fillStyle = `rgba(40, 60, 44, ${shade + 0.15})`;
      for (let y = 1 + rand(); y < 16; y += 1.1 + rand() * 0.6) g.fillRect(px(x - 0.02), py(y), (w + 0.04) * RES, 0.05 * RES);
      // Leaves.
      g.fillStyle = `rgba(66, 104, 70, ${shade})`;
      for (let l = 0; l < 6; l++) {
        const ly = 3 + rand() * 12;
        const dir = rand() < 0.5 ? -1 : 1;
        g.beginPath();
        g.ellipse(px(x + dir * 0.35), py(ly), 0.38 * RES, 0.07 * RES, dir * 0.4, 0, Math.PI * 2);
        g.fill();
      }
    }
  });
  const wall: Layer = makeLayer(4.5, -8, 0, 26, 7, (g, px, py) => {
    // Shoji screens with open panels showing the bamboo grove.
    g.fillStyle = '#efe0c4';
    g.fillRect(px(-8), py(7), 26 * RES, 7 * RES);
    for (let x = -8; x < 18; x += 3) {
      const open = Math.floor((x + 8) / 3) % 3 === 1;
      if (open) {
        g.clearRect(px(x + 0.15), py(5.4), 2.7 * RES, 4.9 * RES);
      } else {
        g.strokeStyle = 'rgba(92, 64, 40, 0.5)';
        g.lineWidth = 0.035 * RES;
        for (let gx = x + 0.6; gx < x + 3; gx += 0.6) {
          g.beginPath();
          g.moveTo(px(gx), py(5.4));
          g.lineTo(px(gx), py(0.5));
          g.stroke();
        }
        for (let gy = 0.5; gy < 5.5; gy += 0.7) {
          g.beginPath();
          g.moveTo(px(x + 0.15), py(gy));
          g.lineTo(px(x + 2.85), py(gy));
          g.stroke();
        }
      }
      g.fillStyle = '#5c3f28';
      g.fillRect(px(x), py(7), 0.16 * RES, 7 * RES);
    }
    g.fillStyle = '#4a3220';
    g.fillRect(px(-8), py(5.55), 26 * RES, 0.18 * RES);
    g.fillRect(px(-8), py(0.5), 26 * RES, 0.5 * RES);
    // A calligraphy scroll.
    g.fillStyle = '#f7efdf';
    g.fillRect(px(4.4), py(4.9), 1.2 * RES, 3.2 * RES);
    g.strokeStyle = 'rgba(30, 24, 20, 0.85)';
    g.lineCap = 'round';
    g.lineWidth = 0.09 * RES;
    for (let i = 0; i < 4; i++) {
      g.beginPath();
      g.moveTo(px(4.7 + rand() * 0.2), py(4.4 - i * 0.75));
      g.quadraticCurveTo(px(5 + rand() * 0.3), py(4.2 - i * 0.75 - rand() * 0.2), px(5.3), py(4.25 - i * 0.75 - 0.3));
      g.stroke();
    }
    g.fillStyle = '#b8322a';
    g.fillRect(px(5.15), py(2.15), 0.22 * RES, 0.22 * RES);
  });
  const lanterns = [1.2, 5, 8.8].map((x, i) => ({ x, phase: i * 1.7 }));

  return {
    id: 'dojo',
    name: 'Bamboo Dojo',
    blurb: 'Paper walls, quiet grove, loud fists',
    swatch: ['#efe0c4', '#6e8a64', '#b8322a'],
    file: arenaFile('dojo', 'Bamboo Dojo'),
    draw(ctx, cam, t) {
      const { width: w, height: h } = cam;
      const sky = ctx.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, '#dfe6cf');
      sky.addColorStop(1, '#b9c9a8');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, w, h);
      // The grove sways a little.
      ctx.save();
      const sway = Math.sin(t * 0.8) * 0.06;
      ctx.translate(cam.sx(5, 14), cam.sy(0, 14));
      ctx.transform(1, 0, sway * 0.4, 1, 0, 0);
      ctx.translate(-cam.sx(5, 14), -cam.sy(0, 14));
      drawLayer(ctx, cam, bamboo);
      ctx.restore();
      // Light through the open panels.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 3; i++) {
        const x = cam.sx(-2 + i * 6 + Math.sin(t * 0.2 + i) * 0.2, 4.5);
        const g = ctx.createLinearGradient(x, cam.sy(6, 4.5), x + cam.k(4.5) * 2, cam.sy(0, 0));
        g.addColorStop(0, 'rgba(255, 240, 200, 0.10)');
        g.addColorStop(1, 'rgba(255, 240, 200, 0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(x, cam.sy(5.4, 4.5));
        ctx.lineTo(x + cam.k(4.5) * 2.4, cam.sy(5.4, 4.5));
        ctx.lineTo(x + cam.k(0) * 4.2, cam.sy(0, 0));
        ctx.lineTo(x + cam.k(0) * 1.6, cam.sy(0, 0));
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      drawLayer(ctx, cam, wall);
      drawFloor(ctx, cam, 4.5, '#c8a273', '#8d6844', 'rgba(255, 244, 220, 0.35)', 'rgba(90, 60, 30, 0.35)', t, 'planks');
      // Lanterns sway on their cords.
      for (const lantern of lanterns) {
        const k = cam.k(2.2);
        const angle = Math.sin(t * 1.3 + lantern.phase) * 0.06;
        const topX = cam.sx(lantern.x, 2.2);
        const topY = cam.sy(4.6, 2.2);
        const bx = topX + Math.sin(angle) * k * 1.1;
        const by = topY + Math.cos(angle) * k * 1.1;
        ctx.strokeStyle = 'rgba(60, 40, 30, 0.8)';
        ctx.lineWidth = Math.max(1, k * 0.015);
        ctx.beginPath();
        ctx.moveTo(topX, Math.min(topY, 0) - 10);
        ctx.lineTo(bx, by);
        ctx.stroke();
        const glow = ctx.createRadialGradient(bx, by + k * 0.3, 0, bx, by + k * 0.3, k * 1.6);
        glow.addColorStop(0, 'rgba(255, 170, 90, 0.35)');
        glow.addColorStop(1, 'rgba(255, 170, 90, 0)');
        ctx.fillStyle = glow;
        ctx.fillRect(bx - k * 1.6, by - k * 1.3, k * 3.2, k * 3.2);
        ctx.fillStyle = '#c9402e';
        ctx.beginPath();
        ctx.ellipse(bx, by + k * 0.3, k * 0.22, k * 0.3, angle, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255, 220, 160, 0.5)';
        ctx.beginPath();
        ctx.ellipse(bx - k * 0.05, by + k * 0.25, k * 0.07, k * 0.2, angle, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#2a1d16';
        ctx.fillRect(bx - k * 0.12, by - k * 0.02, k * 0.24, k * 0.05);
        ctx.fillRect(bx - k * 0.12, by + k * 0.57, k * 0.24, k * 0.05);
      }
    },
    drawFront() {},
    ambient(ps, cam, dt) {
      if (Math.random() < dt * 0.9) {
        ps.spawn(K.leaf, cam.x + (Math.random() - 0.3) * 10, 4 + Math.random() * 1.5, {
          vx: -0.2 - Math.random() * 0.4,
          vy: -0.35 - Math.random() * 0.2,
          life: 7,
          size: 0.05 + Math.random() * 0.03,
          rot: Math.random() * 6,
          vr: (Math.random() - 0.5) * 3,
          color: Math.random() < 0.5 ? 'rgba(96, 128, 72, 0.85)' : 'rgba(170, 140, 70, 0.85)',
          depth: Math.random() * 2.5,
          drag: 0.6,
          front: false,
        });
      }
    },
  };
}

/** A perspective floor from the horizon down to the bottom of the screen. */
function drawFloor(ctx: CanvasRenderingContext2D, cam: FightCamera, back: number, top: string, bottom: string, edge: string, line: string, t: number, style: 'planks' | 'seams'): void {
  const yBack = cam.sy(0, back);
  const yFront = cam.height;
  const g = ctx.createLinearGradient(0, yBack, 0, yFront);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, yBack, cam.width, yFront - yBack);
  // Lines receding to the vanishing point.
  const vx = cam.width / 2;
  const vy = cam.horizon;
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const step = style === 'planks' ? 0.55 : 1.6;
  const start = Math.floor((cam.x - 12) / step) * step;
  for (let x = start; x < cam.x + 12; x += step) {
    const fx = cam.sx(x, -1.2);
    const fy = cam.sy(0, -1.2);
    const bx = vx + (fx - vx) * ((yBack - vy) / Math.max(1, fy - vy));
    ctx.moveTo(bx, yBack);
    ctx.lineTo(fx, fy);
  }
  // Crosswise seams at a few depths.
  for (const depth of style === 'planks' ? [3.2, 1.6, 0.35, -0.6] : [2.6, 0.8, -0.7]) {
    const y = cam.sy(0, depth);
    ctx.moveTo(0, y);
    ctx.lineTo(cam.width, y);
  }
  ctx.stroke();
  // The fight line catches the light.
  ctx.strokeStyle = edge;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, cam.sy(0, back));
  ctx.lineTo(cam.width, cam.sy(0, back));
  ctx.stroke();
  void t;
}

let arenas: ArenaArt[] | null = null;

export function allArenas(): ArenaArt[] {
  return (arenas ??= [rooftop(), dojo()]);
}

export function arenaById(id: string | null | undefined): ArenaArt {
  const list = allArenas();
  return list.find((a) => a.id === id) ?? list[0];
}

export const ARENA_IDS = ['rooftop', 'dojo'] as const;
export const ARENA_NAMES: Record<string, string> = { rooftop: 'Rooftop at Dusk', dojo: 'Bamboo Dojo' };

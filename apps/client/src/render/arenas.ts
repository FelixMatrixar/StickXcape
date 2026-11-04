/**
 * The two official arenas (AR-1), painted in a muted ink wash so the stick men stand out. Each
 * is a little 2.5D stage: a sky, layers at depths behind the fight plane (parallax comes from
 * the camera dollying), a perspective floor, and some life: lights, lanterns, leaves, birds.
 */
import type { ArenaFile } from '@sticxcape/shared';
import { ARENA_FILES } from './arena-files.ts';
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
  const near: Layer = makeLayer(3.2, -0.15, 0, 10.3, 4, (g, px, py) => {
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
  // Street lights far below, seen past the roof's edges.
  const street = Array.from({ length: 40 }, () => ({ x: -14 + rand() * 38, y: -6 - rand() * 9, d: 18 + rand() * 20, warm: rand() < 0.7 }));

  return {
    id: 'rooftop',
    name: 'Rooftop at Dusk',
    blurb: 'Warm wind over a sleeping city',
    swatch: ['#f2c6a8', '#9a6a86', '#2c222c'],
    file: ARENA_FILES.rooftop,
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
      // Below roof level: the dark street, far down. It shows past the drop edges.
      const voidTop = cam.sy(0, 11);
      const drop = ctx.createLinearGradient(0, voidTop, 0, h);
      drop.addColorStop(0, 'rgba(58, 40, 60, 0.2)');
      drop.addColorStop(0.2, '#35263a');
      drop.addColorStop(1, '#120c14');
      ctx.fillStyle = drop;
      ctx.fillRect(0, voidTop, w, h - voidTop);
      for (const lamp of street) {
        const flicker = 0.6 + 0.4 * Math.sin(t * 1.7 + lamp.x);
        ctx.fillStyle = lamp.warm ? `rgba(255, 196, 120, ${0.55 * flicker})` : `rgba(170, 200, 255, ${0.4 * flicker})`;
        ctx.beginPath();
        ctx.arc(cam.sx(lamp.x, lamp.d), cam.sy(lamp.y, lamp.d), Math.max(1, cam.k(lamp.d) * 0.08), 0, Math.PI * 2);
        ctx.fill();
      }
      drawLayer(ctx, cam, near);
      drawFloor(ctx, cam, 3.2, '#3b2f3b', '#221a23', 'rgba(255, 214, 190, 0.2)', 'rgba(20, 12, 20, 0.35)', t, 'seams', [0, ARENA_FILES.rooftop.width]);
      for (const ledge of ARENA_FILES.rooftop.ledges) drawAcUnit(ctx, cam, ledge.x, ledge.x + ledge.width, ledge.y, t);
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
    file: ARENA_FILES.dojo,
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

/** Depths a ledge box spans: in front of and behind the fight plane, so fighters stand on its top. */
const BOX_FRONT = -0.5;
const BOX_BACK = 0.85;

/** Colours for a ledge block's faces. */
export interface BlockColours {
  side: string;
  topBack: string;
  topFront: string;
  frontTop: string;
  frontBottom: string;
  /** Light along the top front edge, so the standing surface reads clearly. */
  rim: string;
}

const AC_COLOURS: BlockColours = {
  side: '#35293a',
  topBack: '#7a6578',
  topFront: '#9a8296',
  frontTop: '#68546a',
  frontBottom: '#423445',
  rim: 'rgba(255, 222, 200, 0.55)',
};

/**
 * A ledge (AR-6) drawn as a box through the fight plane, so fighters stand on its top: a contact
 * shadow, the side facing the camera, a lit top and the front face. `detail` draws on the front
 * face before the rim light goes on.
 */
export function drawBlock(ctx: CanvasRenderingContext2D, cam: FightCamera, x0: number, x1: number, top: number, c: BlockColours, detail?: () => void): void {
  const quad = (pts: [number, number, number][]) => {
    ctx.beginPath();
    pts.forEach(([x, y, d], i) => (i === 0 ? ctx.moveTo(cam.sx(x, d), cam.sy(y, d)) : ctx.lineTo(cam.sx(x, d), cam.sy(y, d))));
    ctx.closePath();
  };
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(24, 16, 26, 0.75)';
  ctx.lineWidth = Math.max(1, cam.ppm * 0.012);
  // Contact shadow on the floor.
  ctx.fillStyle = 'rgba(16, 10, 18, 0.35)';
  quad([
    [x0 - 0.08, 0, BOX_FRONT - 0.12],
    [x1 + 0.08, 0, BOX_FRONT - 0.12],
    [x1 + 0.08, 0, BOX_BACK],
    [x0 - 0.08, 0, BOX_BACK],
  ]);
  ctx.fill();
  // The side that faces the camera.
  const side = cam.x < x0 ? x0 : cam.x > x1 ? x1 : null;
  if (side !== null) {
    ctx.fillStyle = c.side;
    quad([
      [side, 0, BOX_FRONT],
      [side, 0, BOX_BACK],
      [side, top, BOX_BACK],
      [side, top, BOX_FRONT],
    ]);
    ctx.fill();
    ctx.stroke();
  }
  // Top: lit from above, brightest along the front edge.
  const topFront = cam.sy(top, BOX_FRONT);
  const topBack = cam.sy(top, BOX_BACK);
  const lit = ctx.createLinearGradient(0, topBack, 0, topFront);
  lit.addColorStop(0, c.topBack);
  lit.addColorStop(1, c.topFront);
  ctx.fillStyle = lit;
  quad([
    [x0, top, BOX_FRONT],
    [x1, top, BOX_FRONT],
    [x1, top, BOX_BACK],
    [x0, top, BOX_BACK],
  ]);
  ctx.fill();
  ctx.stroke();
  // Front face.
  const fy0 = cam.sy(top, BOX_FRONT);
  const fy1 = cam.sy(0, BOX_FRONT);
  const body = ctx.createLinearGradient(0, fy0, 0, fy1);
  body.addColorStop(0, c.frontTop);
  body.addColorStop(1, c.frontBottom);
  ctx.fillStyle = body;
  quad([
    [x0, 0, BOX_FRONT],
    [x1, 0, BOX_FRONT],
    [x1, top, BOX_FRONT],
    [x0, top, BOX_FRONT],
  ]);
  ctx.fill();
  ctx.stroke();
  detail?.();
  ctx.strokeStyle = c.rim;
  ctx.lineWidth = Math.max(1.5, cam.k(BOX_FRONT) * 0.02);
  ctx.beginPath();
  ctx.moveTo(cam.sx(x0, BOX_FRONT), topFront);
  ctx.lineTo(cam.sx(x1, BOX_FRONT), topFront);
  ctx.stroke();
  ctx.restore();
}

/** An air-conditioning unit: a rooftop ledge with vent slats and a turning fan. */
function drawAcUnit(ctx: CanvasRenderingContext2D, cam: FightCamera, x0: number, x1: number, top: number, t: number): void {
  drawBlock(ctx, cam, x0, x1, top, AC_COLOURS, () => {
    const k = cam.k(BOX_FRONT);
    const w = x1 - x0;
    // Vent slats on the left, a fan on the right.
    ctx.strokeStyle = 'rgba(28, 20, 30, 0.7)';
    ctx.lineWidth = Math.max(1, k * 0.018);
    ctx.beginPath();
    for (let i = 1; i <= 4; i++) {
      const y = cam.sy((top * i) / 5, BOX_FRONT);
      ctx.moveTo(cam.sx(x0 + 0.08, BOX_FRONT), y);
      ctx.lineTo(cam.sx(x0 + w * 0.4, BOX_FRONT), y);
    }
    ctx.stroke();
    const fx = cam.sx(x0 + w * 0.7, BOX_FRONT);
    const fy = cam.sy(top * 0.5, BOX_FRONT);
    const r = top * 0.36 * k;
    ctx.fillStyle = '#2a2030';
    ctx.beginPath();
    ctx.arc(fx, fy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#5a485b';
    for (let i = 0; i < 4; i++) {
      const a = t * 6 + (i * Math.PI) / 2;
      ctx.beginPath();
      ctx.ellipse(fx + Math.cos(a) * r * 0.48, fy + Math.sin(a) * r * 0.48, r * 0.42, r * 0.16, a, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#7d6a7c';
    ctx.beginPath();
    ctx.arc(fx, fy, r * 0.14, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#7d6a7c';
    ctx.lineWidth = Math.max(1, k * 0.022);
    ctx.beginPath();
    ctx.arc(fx, fy, r, 0, Math.PI * 2);
    ctx.stroke();
  });
}

/** A perspective floor from the horizon down to the bottom of the screen. */
export function drawFloor(
  ctx: CanvasRenderingContext2D,
  cam: FightCamera,
  back: number,
  top: string,
  bottom: string,
  edge: string,
  line: string,
  t: number,
  style: 'planks' | 'seams',
  extent?: [number, number],
): void {
  const yBack = cam.sy(0, back);
  const yFront = cam.height;
  const g = ctx.createLinearGradient(0, yBack, 0, yFront);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  // The depth at which the floor meets the bottom of the screen.
  const kBottom = (cam.height - cam.horizon) / Math.max(0.01, cam.camY);
  const front = cam.focal / Math.max(1, kBottom) - cam.focal / cam.ppm;
  ctx.save();
  if (extent) {
    const [x0, x1] = extent;
    // The roof's side faces drop away under each edge.
    ctx.fillStyle = '#17111a';
    for (const x of [x0, x1]) {
      ctx.beginPath();
      ctx.moveTo(cam.sx(x, back), cam.sy(0, back));
      ctx.lineTo(cam.sx(x, front), cam.sy(0, front));
      ctx.lineTo(cam.sx(x, front), cam.sy(-0.35, front));
      ctx.lineTo(cam.sx(x, back), cam.sy(-0.35, back));
      ctx.closePath();
      ctx.fill();
    }
    ctx.beginPath();
    ctx.moveTo(cam.sx(x0, back), cam.sy(0, back));
    ctx.lineTo(cam.sx(x1, back), cam.sy(0, back));
    ctx.lineTo(cam.sx(x1, front), cam.sy(0, front));
    ctx.lineTo(cam.sx(x0, front), cam.sy(0, front));
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    ctx.clip();
  } else {
    ctx.fillStyle = g;
    ctx.fillRect(0, yBack, cam.width, yFront - yBack);
  }
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
  ctx.restore();
  if (extent) {
    // Hazard paint along each drop edge, so players can see where the roof ends.
    for (const [x, inward] of [
      [extent[0], 1],
      [extent[1], -1],
    ] as const) {
      const stripes = 9;
      for (let i = 0; i < stripes; i++) {
        const d0 = back + ((front - back) * i) / stripes;
        const d1 = back + ((front - back) * (i + 0.5)) / stripes;
        ctx.fillStyle = i % 2 === 0 ? 'rgba(242, 177, 52, 0.75)' : 'rgba(22, 16, 20, 0.75)';
        ctx.beginPath();
        ctx.moveTo(cam.sx(x, d0), cam.sy(0, d0));
        ctx.lineTo(cam.sx(x + inward * 0.16, d0), cam.sy(0, d0));
        ctx.lineTo(cam.sx(x + inward * 0.16, d1), cam.sy(0, d1));
        ctx.lineTo(cam.sx(x, d1), cam.sy(0, d1));
        ctx.closePath();
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(255, 226, 200, 0.55)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cam.sx(x, back), cam.sy(0, back));
      ctx.lineTo(cam.sx(x, front), cam.sy(0, front));
      ctx.stroke();
    }
  }
  void t;
}

let arenas: ArenaArt[] | null = null;

export function allArenas(): ArenaArt[] {
  return (arenas ??= [rooftop(), dojo()]);
}

/** Photo arenas on this phone, registered as they load (AR-4). */
const photos = new Map<string, ArenaArt>();

export function registerArena(art: ArenaArt): void {
  photos.set(art.id, art);
}

export function unregisterArena(id: string): void {
  photos.delete(id);
}

export function photoArenaArts(): ArenaArt[] {
  return [...photos.values()];
}

/** Official arenas ship with the game; any other arena is a photo arena, shared before a room uses it. */
export function isOfficialArena(id: string | null | undefined): boolean {
  return (ARENA_IDS as readonly string[]).includes(id ?? '');
}

export function arenaById(id: string | null | undefined): ArenaArt {
  const list = allArenas();
  return list.find((a) => a.id === id) ?? photos.get(id ?? '') ?? list[0];
}

export const ARENA_IDS = ['rooftop', 'dojo'] as const;
export const ARENA_NAMES: Record<string, string> = { rooftop: 'Rooftop at Dusk', dojo: 'Bamboo Dojo' };

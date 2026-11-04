/**
 * A photo arena on screen (AR-4, LS-11): the ink-washed photo stands at the far edge of the
 * floor as a backdrop, dimmed so it never competes with the fighters; the floor and ledges take
 * their colours from the photo, and ledges are solid blocks you can stand on.
 */
import type { ArenaFile } from '@sticxcape/shared';
import { ART_WIDTH, floorYOf } from '../arenas/layout.ts';
import type { Palette } from '../arenas/pipeline.ts';
import { drawBlock, drawFloor, type ArenaArt, type BlockColours } from './arenas.ts';
import type { FightCamera } from './camera.ts';
import { K } from './particles.ts';

/** The backdrop stands where the floor ends. */
const DEPTH = 3.2;

export function photoArenaArt(file: ArenaFile, image: CanvasImageSource & { width: number; height: number }, palette: Palette): ArenaArt {
  const aspect = image.width / image.height;
  const artHeight = ART_WIDTH / aspect;
  const floorY = floorYOf(file, aspect);
  const left = file.width / 2 - ART_WIDTH / 2;
  const top = floorY * artHeight;
  const drops = file.edges.left === 'drop' || file.edges.right === 'drop';
  const block: BlockColours = {
    side: palette.floorBottom,
    topBack: palette.ledge,
    topFront: palette.ledgeTop,
    frontTop: palette.ledge,
    frontBottom: palette.floorBottom,
    rim: 'rgba(255, 244, 228, 0.6)',
  };

  return {
    id: file.id,
    name: file.name,
    file,
    blurb: 'Your photo arena',
    swatch: [palette.sky, palette.ledge, palette.floorBottom],
    draw(ctx, cam, t) {
      const sky = ctx.createLinearGradient(0, 0, 0, cam.height);
      sky.addColorStop(0, palette.sky);
      sky.addColorStop(1, palette.skyLow);
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, cam.width, cam.height);
      // The photo, washed in ink and dimmed during fights.
      const x = cam.sx(left, DEPTH);
      const y = cam.sy(top, DEPTH);
      const k = cam.k(DEPTH);
      ctx.drawImage(image, x, y, ART_WIDTH * k, artHeight * k);
      ctx.fillStyle = 'rgba(26, 20, 24, 0.3)';
      ctx.fillRect(x, y, ART_WIDTH * k, artHeight * k);
      if (drops) drawDrop(ctx, cam);
      drawFloor(ctx, cam, DEPTH, palette.floorTop, palette.floorBottom, 'rgba(255, 244, 228, 0.28)', 'rgba(20, 14, 20, 0.22)', t, 'planks', drops ? [0, file.width] : undefined);
      for (const ledge of file.ledges) drawBlock(ctx, cam, ledge.x, ledge.x + ledge.width, ledge.y, block);
    },
    drawFront(ctx, cam) {
      const g = ctx.createLinearGradient(0, cam.height * 0.86, 0, cam.height);
      g.addColorStop(0, 'rgba(20, 16, 18, 0)');
      g.addColorStop(1, 'rgba(20, 16, 18, 0.3)');
      ctx.fillStyle = g;
      ctx.fillRect(0, cam.height * 0.86, cam.width, cam.height * 0.14);
    },
    ambient(ps, cam, dt) {
      if (Math.random() < dt * 2) {
        ps.spawn(K.mote, cam.x + (Math.random() - 0.5) * 10, Math.random() * 2.6, {
          vx: (Math.random() - 0.5) * 0.2,
          vy: 0.04 + Math.random() * 0.1,
          life: 3 + Math.random() * 3,
          size: 0.01 + Math.random() * 0.01,
          color: 'rgba(255, 244, 228, 0.8)',
          depth: Math.random() * 2.5,
          front: false,
        });
      }
    },
  };
}

/** Past a drop edge: a dark fall below floor level. */
function drawDrop(ctx: CanvasRenderingContext2D, cam: FightCamera): void {
  const voidTop = cam.sy(0, DEPTH);
  const g = ctx.createLinearGradient(0, voidTop, 0, cam.height);
  g.addColorStop(0, 'rgba(20, 14, 20, 0.6)');
  g.addColorStop(1, '#0d090e');
  ctx.fillStyle = g;
  ctx.fillRect(0, voidTop, cam.width, cam.height - voidTop);
}

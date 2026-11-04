import type { ArenaFile } from './arena.ts';
import { isRecord } from './validate.ts';

/**
 * Shared photo arenas (launch, AR-7). The phone makes a photo arena itself (privacy pass, ink
 * restyle, floor and ledges) and keeps it private; sharing uploads the finished arena so friends
 * can open it from a link, /a/{id}. The server stores what friends need: the arena file, the
 * backdrop and its palette.
 */
export const ARENA_LINK_PATH = '/a/';

/** A photo arena's only art layer names its own backdrop: photo:{id}. */
export function photoArenaLayer(id: string): string {
  return `photo:${id}`;
}

/**
 * Photo arenas have UUIDs, so they never clash with the built-in arenas' short names (rooftop,
 * dojo). In a room, a UUID arena id means a shared photo arena: each phone loads it from
 * GET /arenas/{id} before getting ready.
 */
const PHOTO_ARENA_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isPhotoArenaId(id: string): boolean {
  return PHOTO_ARENA_ID_PATTERN.test(id);
}

/** The backdrop is a JPEG; the phone's are 1280 px wide at quality 0.88, a few hundred KB. */
export const ARENA_IMAGE_MAX_BYTES = 1_500_000;
export const ARENA_IMAGE_MAX_SIDE = 2048;
export const ARENA_IMAGE_MIN_SIDE = 160;

/** Colours sampled from the photo, muted to sit behind the fighters. */
export const ARENA_PALETTE_KEYS = ['sky', 'skyLow', 'floorTop', 'floorBottom', 'ledge', 'ledgeTop'] as const;
export type ArenaPalette = Record<(typeof ARENA_PALETTE_KEYS)[number], string>;

const RGB = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/;
const HEX = /^#[0-9a-fA-F]{6}$/;

/** Each colour must be rgb(r, g, b) or #rrggbb, so nothing else reaches a canvas. */
export function parseArenaPalette(value: unknown): ArenaPalette | null {
  if (!isRecord(value)) return null;
  const palette = {} as ArenaPalette;
  for (const key of ARENA_PALETTE_KEYS) {
    const colour = value[key];
    if (typeof colour !== 'string' || colour.length > 32) return null;
    const rgb = RGB.exec(colour);
    if (rgb ? rgb.slice(1).some((part) => Number(part) > 255) : !HEX.test(colour)) return null;
    palette[key] = colour;
  }
  return palette;
}

/** POST /arenas (multipart: file, image, palette) */
export interface ShareArenaResponse {
  id: string;
  /** The link friends open: {origin}/a/{id}. */
  link: string;
}

/** GET /arenas/{id} */
export interface SharedArenaResponse {
  file: ArenaFile;
  /** The backdrop, GET /arenas/{id}/image. */
  imageUrl: string;
  palette: ArenaPalette;
}

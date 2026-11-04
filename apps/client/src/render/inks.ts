/** Fighter ink colours. You are always drawn in your own; the opponent gets a contrasting one. */
import { worstDifference } from './colour-vision.ts';

export interface Ink {
  id: string;
  name: string;
  /** Main stroke colour. */
  ink: string;
  /** Far limbs: a shade darker. */
  deep: string;
  /** Trails, glows and sparks. */
  glow: string;
  rgb: [number, number, number];
}

export const INKS: readonly Ink[] = [
  { id: 'vermillion', name: 'Vermillion', ink: '#e8432d', deep: '#9e2a1b', glow: '#ff8d6e', rgb: [232, 67, 45] },
  { id: 'cobalt', name: 'Cobalt', ink: '#2f62e6', deep: '#1b3a92', glow: '#86a8ff', rgb: [47, 98, 230] },
  { id: 'jade', name: 'Jade', ink: '#0f9f7c', deep: '#08624c', glow: '#5fe2bf', rgb: [15, 159, 124] },
  { id: 'violet', name: 'Violet', ink: '#7a4fe0', deep: '#4a2b96', glow: '#b9a0ff', rgb: [122, 79, 224] },
  { id: 'magenta', name: 'Magenta', ink: '#de3790', deep: '#911d5b', glow: '#ff8ac6', rgb: [222, 55, 144] },
  { id: 'amber', name: 'Amber', ink: '#ee960c', deep: '#a1600a', glow: '#ffc865', rgb: [238, 150, 12] },
  { id: 'sumi', name: 'Sumi', ink: '#1f1d1b', deep: '#000000', glow: '#8c8781', rgb: [31, 29, 27] },
];

/**
 * Each ink's opponent colour. Every pair stays well apart for normal vision and for protan,
 * deutan and tritan colour blindness (jade and magenta look alike to deutans, so neither is the
 * other's contrast).
 */
const CONTRAST: Record<string, string> = {
  vermillion: 'cobalt',
  cobalt: 'vermillion',
  jade: 'violet',
  violet: 'amber',
  magenta: 'sumi',
  amber: 'violet',
  sumi: 'vermillion',
};

/** Two fighters need at least this CIEDE2000 difference, for every kind of colour vision. */
export const MIN_INK_DIFFERENCE = 20;

export function inkById(id: string | null | undefined): Ink {
  return INKS.find((ink) => ink.id === id) ?? INKS[0];
}

/**
 * A colour that stands apart from `mine`, for the opponent: their own pick when anyone, colour
 * blind or not, can tell it from mine; otherwise my ink's designated contrast.
 */
export function contrastInk(mine: Ink, theirs?: Ink): Ink {
  if (theirs && theirs.id !== mine.id && worstDifference(mine.ink, theirs.ink) >= MIN_INK_DIFFERENCE) return theirs;
  return inkById(CONTRAST[mine.id]);
}

export function rgba(ink: Ink, alpha: number): string {
  return `rgba(${ink.rgb[0]},${ink.rgb[1]},${ink.rgb[2]},${alpha})`;
}

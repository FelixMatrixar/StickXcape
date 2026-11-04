/**
 * The colours that tell outcomes apart in a fight: hits, blocks, parries, counters and armor.
 * Chosen so each pair that must read differently stays apart for normal vision and the three
 * common colour vision deficiencies (see colour-vision.ts and test/colours.test.ts). Shape, text
 * and sound back every one of them up: colour is never the only cue.
 */
export const FX = {
  /** Sparks off a clean hit: warm white. */
  hitSpark: '#fff4d6',
  /** A parry's ring and sparks: gold, well apart from a hit's white. */
  parryRing: '#ffc832',
  parrySpark: '#ffd04d',
  /** A block's shield arc and sparks: pale blue. */
  blockArc: '#cfe0ff',
  blockSpark: '#dfe9ff',
  /** A counter-hit's ring: deep red, darker than a parry's gold for red-green colour blindness. */
  counterRing: '#b11d14',
  /** Armor soaking a hit: steel, darker than a block's pale blue. */
  armorRing: '#8c9aa6',
  armorSpark: '#e8f1ff',
} as const;

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { difference, parseHex, VISIONS, worstDifference } from '../src/render/colour-vision.ts';
import { contrastInk, INKS, MIN_INK_DIFFERENCE } from '../src/render/inks.ts';
import { FX } from '../src/render/palette.ts';
import { POP } from '../src/render/popups.ts';

/** Every pair from a set of named colours. */
function pairs(colours: Record<string, string>): [string, string, string, string][] {
  const names = Object.keys(colours);
  const out: [string, string, string, string][] = [];
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) out.push([names[i], names[j], colours[names[i]], colours[names[j]]]);
  return out;
}

/** WCAG contrast ratio between two colours. */
function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = parseHex(hex).map((c) => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('colour vision model', () => {
  it('scores the same colour 0 and black against white near 100', () => {
    for (const vision of VISIONS) {
      expect(difference('#e8432d', '#e8432d', vision)).toBeCloseTo(0, 6);
      expect(difference('#000000', '#ffffff', vision)).toBeGreaterThan(95);
    }
  });

  it('sees red and green collapse for red-green colour blindness, not for tritans', () => {
    expect(difference('#d62728', '#2ca02c', 'deutan')).toBeLessThan(difference('#d62728', '#2ca02c', 'normal') / 2);
    expect(difference('#d62728', '#2ca02c', 'tritan')).toBeGreaterThan(30);
  });
});

describe('colours that work for colour-blind players', () => {
  it('gives every ink an opponent colour that stands well apart', () => {
    for (const ink of INKS) {
      const other = contrastInk(ink);
      expect(other.id).not.toBe(ink.id);
      expect(worstDifference(ink.ink, other.ink), `${ink.id} against ${other.id}`).toBeGreaterThanOrEqual(25);
    }
  });

  it('never pairs two fighters anyone would mix up, whatever the opponent picked', () => {
    for (const mine of INKS) {
      for (const theirs of INKS) {
        const shown = contrastInk(mine, theirs);
        expect(worstDifference(mine.ink, shown.ink), `${mine.id} against ${theirs.id}`).toBeGreaterThanOrEqual(MIN_INK_DIFFERENCE);
      }
    }
    const ink = (id: string) => INKS.find((i) => i.id === id)!;
    // A pick everyone can tell apart is kept; red against amber is too close for deutans, so it's swapped.
    expect(contrastInk(ink('vermillion'), ink('violet')).id).toBe('violet');
    expect(contrastInk(ink('vermillion'), ink('amber')).id).toBe('cobalt');
  });

  it('keeps the outcome popups apart: parry, counter, blocked, armor, whiff', () => {
    const strokes = { parry: POP.parry.stroke, counter: POP.counter.stroke, blocked: POP.blocked.stroke, armor: POP.armor.stroke, whiff: POP.whiff.stroke };
    for (const [a, b, ca, cb] of pairs(strokes as Record<string, string>)) {
      expect(worstDifference(ca, cb), `${a} against ${b}`).toBeGreaterThanOrEqual(15);
    }
  });

  it('keeps a parry from looking like a hit, and armor from looking like a block', () => {
    expect(worstDifference(FX.parryRing, FX.hitSpark)).toBeGreaterThanOrEqual(15);
    expect(worstDifference(FX.parrySpark, FX.hitSpark)).toBeGreaterThanOrEqual(15);
    expect(worstDifference(FX.armorRing, FX.blockArc)).toBeGreaterThanOrEqual(15);
    expect(worstDifference(FX.counterRing, FX.parryRing)).toBeGreaterThanOrEqual(15);
  });

  it('keeps the high, mid and low tags apart and readable', () => {
    const css = readFileSync(new URL('../src/styles/main.css', import.meta.url), 'utf8');
    const tag = (height: string) => {
      const rule = new RegExp(`\\.tag-${height} \\{\\s*background: (#[0-9a-f]{6});\\s*color: (#[0-9a-f]{6});`).exec(css);
      expect(rule, `.tag-${height} rule`).not.toBeNull();
      return { bg: rule![1], text: rule![2] };
    };
    const tags = { high: tag('high'), mid: tag('mid'), low: tag('low') };
    for (const [a, b] of [
      ['high', 'mid'],
      ['high', 'low'],
      ['mid', 'low'],
    ] as const) {
      expect(worstDifference(tags[a].bg, tags[b].bg), `${a} against ${b}`).toBeGreaterThanOrEqual(10);
    }
    for (const t of Object.values(tags)) expect(contrastRatio(t.text, t.bg)).toBeGreaterThanOrEqual(4.5);
  });
});

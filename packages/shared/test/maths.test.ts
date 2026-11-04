import { describe, expect, it } from 'vitest';
import {
  ANGLE_QUARTER,
  decodeBase64,
  encodeBase64,
  fixedCos,
  fixedDiv,
  fixedLength,
  fixedMul,
  fixedSin,
  fixedSqrt,
  fromFixed,
  hashInts,
  isqrt,
  ONE,
  Rng,
  toFixed,
} from '@sticxcape/shared';

/** A seeded source of test values, so failures repeat. */
function ints(seed: number, count: number, min: number, max: number): number[] {
  const rng = new Rng(seed);
  return Array.from({ length: count }, () => min + Math.floor((rng.next() / 0x100000000) * (max - min + 1)));
}

const INT32_MIN = -0x80000000;
const INT32_MAX = 0x7fffffff;

describe('fixed-point maths', () => {
  it('converts to and from Q16.16', () => {
    expect(toFixed(1.5)).toBe(98304);
    expect(fromFixed(toFixed(-2.25))).toBe(-2.25);
    expect(ONE).toBe(65536);
  });

  it('multiplies exactly like a 64-bit product shifted down', () => {
    const as = ints(1, 5000, INT32_MIN, INT32_MAX);
    const bs = ints(2, 5000, INT32_MIN, INT32_MAX);
    for (let i = 0; i < as.length; i++) {
      const a = as[i]!;
      const b = bs[i]!;
      const expected = Number(BigInt.asIntN(32, (BigInt(a) * BigInt(b)) >> 16n));
      expect(fixedMul(a, b), `${a} × ${b}`).toBe(expected);
    }
    expect(fixedMul(toFixed(-1.5), toFixed(2))).toBe(toFixed(-3));
  });

  it('divides exactly like 64-bit division truncated toward zero', () => {
    const as = ints(3, 5000, INT32_MIN, INT32_MAX);
    const bs = ints(4, 5000, INT32_MIN, INT32_MAX);
    for (let i = 0; i < as.length; i++) {
      const a = as[i]!;
      const b = bs[i]! || 1;
      const expected = Number(BigInt.asIntN(32, (BigInt(a) << 16n) / BigInt(b)));
      expect(fixedDiv(a, b), `${a} ÷ ${b}`).toBe(expected);
    }
    expect(fixedDiv(toFixed(3), toFixed(-2))).toBe(toFixed(-1.5));
    expect(fixedDiv(5, 0)).toBe(INT32_MAX);
    expect(fixedDiv(-5, 0)).toBe(INT32_MIN);
  });

  it('takes exact integer square roots', () => {
    const cases = [0, 1, 2, 3, 4, 15, 16, 17, 2 ** 52 - 1, ...ints(5, 2000, 0, 2 ** 31), ...ints(6, 2000, 0, 2 ** 52 - 1)];
    for (const n of cases) {
      const r = isqrt(n);
      expect(r * r <= n && (r + 1) * (r + 1) > n, `isqrt(${n}) = ${r}`).toBe(true);
    }
    expect(fixedSqrt(toFixed(4))).toBe(toFixed(2));
    expect(fixedSqrt(toFixed(-1))).toBe(0);
    expect(fixedLength(toFixed(3), toFixed(4))).toBe(toFixed(5));
  });

  it('uses the exact sine table and stays within 2/65536 between its entries', () => {
    for (let i = 0; i <= 256; i++) expect(fixedSin(i * 64)).toBe(Math.round(Math.sin((i * Math.PI) / 512) * ONE));
    let worst = 0;
    for (let a = 0; a < 65536; a++) worst = Math.max(worst, Math.abs(fixedSin(a) - Math.sin((a / 65536) * 2 * Math.PI) * ONE));
    expect(worst).toBeLessThan(2);
  });

  it('keeps sine and cosine symmetric', () => {
    expect([0, ANGLE_QUARTER, 2 * ANGLE_QUARTER, 3 * ANGLE_QUARTER].map(fixedSin)).toEqual([0, ONE, 0, -ONE]);
    expect(fixedCos(0)).toBe(ONE);
    expect(Object.is(fixedSin(2 * ANGLE_QUARTER), 0)).toBe(true);
    for (const a of [...ints(7, 500, -200_000, 200_000), 32768, -32768, 65536]) {
      expect(fixedSin(-a)).toBe(-fixedSin(a) | 0);
      expect(fixedSin(a + 65536)).toBe(fixedSin(a));
    }
  });
});

describe('Rng', () => {
  it('is mulberry32, so every phone draws the same numbers', () => {
    const rng = new Rng(1);
    expect([rng.next(), rng.next(), rng.next()]).toEqual([2693262067, 11749833, 2265367787]);
  });

  it('restores from saved state, as rollback will need', () => {
    const rng = new Rng(42);
    rng.next();
    const saved = rng.state;
    const ahead = [rng.next(), rng.next()];
    rng.state = saved;
    expect([rng.next(), rng.next()]).toEqual(ahead);
  });

  it('draws integers in range', () => {
    const rng = new Rng(9);
    for (let i = 0; i < 1000; i++) {
      const n = rng.nextInt(7);
      expect(Number.isInteger(n) && n >= 0 && n < 7).toBe(true);
    }
  });
});

describe('hashInts', () => {
  /** FNV-1a over bytes, the textbook way. */
  function fnv1a(bytes: Uint8Array): number {
    let h = 0x811c9dc5;
    for (const byte of bytes) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
    return h >>> 0;
  }

  it('is FNV-1a over each int as 4 little-endian bytes', () => {
    expect(hashInts([])).toBe(0x811c9dc5);
    expect(hashInts([0])).toBe(0x4b95f515);
    const values = ints(8, 64, INT32_MIN, INT32_MAX);
    const bytes = new Uint8Array(new Int32Array(values).buffer);
    expect(hashInts(values)).toBe(fnv1a(bytes));
  });
});

describe('base64', () => {
  it('matches standard base64 for every length', () => {
    for (let length = 0; length < 64; length++) {
      const bytes = Uint8Array.from(ints(100 + length, length, 0, 255));
      const text = encodeBase64(bytes);
      expect(text).toBe(Buffer.from(bytes).toString('base64'));
      expect(decodeBase64(text)).toEqual(bytes);
    }
  });

  it('refuses bad characters, length and padding', () => {
    for (const bad of ['abc', 'ab=c', '====', 'a===', 'ab==cdef', 'ab c', 'é===', 'ab-_']) expect(decodeBase64(bad), bad).toBeNull();
  });
});

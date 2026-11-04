/**
 * Colour vision checks (accessibility: "hit, parry and trait colours that work for colour-blind
 * players"). Simulates the three common colour vision deficiencies with the Machado, Oliveira and
 * Fernandes (2009) model at full severity, and measures how far apart two colours look with
 * CIEDE2000. Used to pick an opponent ink that stands apart for everyone, and by tests that keep
 * the game's effect and tag colours apart.
 */

export type Vision = 'normal' | 'protan' | 'deutan' | 'tritan';
export const VISIONS: readonly Vision[] = ['normal', 'protan', 'deutan', 'tritan'];

/** Machado 2009, severity 1.0, applied to linear RGB. */
const MACHADO: Record<Exclude<Vision, 'normal'>, readonly number[]> = {
  protan: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deutan: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritan: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
};

type Rgb = [number, number, number];
type Lab = [number, number, number];

/** '#rrggbb' to 0..255 channels. */
export function parseHex(hex: string): Rgb {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** How a colour looks with a given kind of colour vision, as linear RGB 0..1. */
function seen(rgb: Rgb, vision: Vision): Rgb {
  const lin: Rgb = [toLinear(rgb[0]), toLinear(rgb[1]), toLinear(rgb[2])];
  if (vision === 'normal') return lin;
  const m = MACHADO[vision];
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return [
    clamp(m[0] * lin[0] + m[1] * lin[1] + m[2] * lin[2]),
    clamp(m[3] * lin[0] + m[4] * lin[1] + m[5] * lin[2]),
    clamp(m[6] * lin[0] + m[7] * lin[1] + m[8] * lin[2]),
  ];
}

/** Linear sRGB (D65) to CIELAB. */
function toLab([r, g, b]: Rgb): Lab {
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000 colour difference: about 2 is just noticeable; 20 and up reads as a different colour at a glance. */
export function deltaE2000([l1, a1, b1]: Lab, [l2, a2, b2]: Lab): number {
  const rad = Math.PI / 180;
  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cBar = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const hue = (b: number, a: number) => {
    if (a === 0 && b === 0) return 0;
    const h = Math.atan2(b, a) / rad;
    return h < 0 ? h + 360 : h;
  };
  const h1p = hue(b1, a1p);
  const h2p = hue(b2, a2p);
  const dLp = l2 - l1;
  const dCp = c2p - c1p;
  let dhp = 0;
  if (c1p * c2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin((dhp / 2) * rad);
  const lBarP = (l1 + l2) / 2;
  const cBarP = (c1p + c2p) / 2;
  let hBarP = h1p + h2p;
  if (c1p * c2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hBarP = (h1p + h2p) / 2;
    else hBarP = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }
  const t = 1 - 0.17 * Math.cos((hBarP - 30) * rad) + 0.24 * Math.cos(2 * hBarP * rad) + 0.32 * Math.cos((3 * hBarP + 6) * rad) - 0.2 * Math.cos((4 * hBarP - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hBarP - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(cBarP ** 7 / (cBarP ** 7 + 25 ** 7));
  const sl = 1 + (0.015 * (lBarP - 50) ** 2) / Math.sqrt(20 + (lBarP - 50) ** 2);
  const sc = 1 + 0.045 * cBarP;
  const sh = 1 + 0.015 * cBarP * t;
  const rt = -Math.sin(2 * dTheta * rad) * rc;
  return Math.sqrt((dLp / sl) ** 2 + (dCp / sc) ** 2 + (dHp / sh) ** 2 + rt * (dCp / sc) * (dHp / sh));
}

/** How different two colours look to someone with the given colour vision. */
export function difference(hexA: string, hexB: string, vision: Vision): number {
  return deltaE2000(toLab(seen(parseHex(hexA), vision)), toLab(seen(parseHex(hexB), vision)));
}

/** The smallest difference across normal vision and the three deficiencies. */
export function worstDifference(hexA: string, hexB: string): number {
  return Math.min(...VISIONS.map((v) => difference(hexA, hexB, v)));
}

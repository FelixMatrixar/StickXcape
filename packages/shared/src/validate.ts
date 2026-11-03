/** Small checks shared by every contract validator. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export function isNum(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

export function oneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

// Control and invisible formatting characters (zero-width joiners, bidi overrides) are never allowed.
const HIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Co}]/u;

/**
 * Normalizes player-visible text (nicknames, move names): NFC, single spaces, trimmed.
 * Returns null when it is empty, too long (in characters, not UTF-16 units) or holds hidden characters.
 */
export function cleanText(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string' || value.length > maxChars * 8) return null;
  const text = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (text.length === 0 || HIDDEN_CHARS.test(text) || [...text].length > maxChars) return null;
  return text;
}

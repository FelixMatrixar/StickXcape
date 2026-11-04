/**
 * Vibration (Android only: iPhone browsers can't vibrate). Patterns follow the product PRD's
 * hit-feedback table: a light tap, a strong buzz, a crisp double tap on a parry, a long rumble
 * on a knockout, and a tiny tick when an on-screen button is pressed.
 */
import type { HapticKind } from '../render/scene.ts';
import { settings } from './settings.ts';

const PATTERNS: Record<HapticKind | 'button' | 'ui', number | number[]> = {
  button: 6,
  ui: 8,
  light: 14,
  block: 10,
  heavy: 38,
  parry: [12, 45, 14],
  ko: [90, 40, 180],
};

export function haptic(kind: HapticKind | 'button' | 'ui'): void {
  if (!settings.vibration || typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(PATTERNS[kind]);
  } catch {
    // Some browsers throw without a recent user gesture.
  }
}

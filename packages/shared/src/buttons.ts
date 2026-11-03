/**
 * Buttons are a 9-bit field: 4 bits for the stick direction, 5 for L, H, S, D and Block.
 * Directions are absolute screen directions; the fight engine turns them into forward and back
 * from each fighter's facing on the frame the input is applied.
 */
export const Button = {
  Up: 1 << 0,
  Down: 1 << 1,
  Left: 1 << 2,
  Right: 1 << 3,
  Light: 1 << 4,
  Heavy: 1 << 5,
  Special: 1 << 6,
  Defense: 1 << 7,
  Block: 1 << 8,
} as const;

export type ButtonName = keyof typeof Button;

export const BUTTON_BITS = 9;
export const BUTTONS_MASK = (1 << BUTTON_BITS) - 1;
export const DIRECTION_MASK = Button.Up | Button.Down | Button.Left | Button.Right;

export function isButtons(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= BUTTONS_MASK;
}

export function hasButton(buttons: number, button: number): boolean {
  return (buttons & button) !== 0;
}

/** Packs pressed buttons into the 9-bit field, cleaning impossible stick states. */
export function packButtons(pressed: Partial<Record<ButtonName, boolean>>): number {
  let buttons = 0;
  for (const name of Object.keys(Button) as ButtonName[]) {
    if (pressed[name]) buttons |= Button[name];
  }
  return cleanButtons(buttons);
}

export function unpackButtons(buttons: number): Record<ButtonName, boolean> {
  const pressed = {} as Record<ButtonName, boolean>;
  for (const name of Object.keys(Button) as ButtonName[]) pressed[name] = hasButton(buttons, Button[name]);
  return pressed;
}

/** Opposite directions cancel out: left + right is neutral, up + down is neutral. */
export function cleanButtons(buttons: number): number {
  let clean = buttons & BUTTONS_MASK;
  if ((clean & (Button.Left | Button.Right)) === (Button.Left | Button.Right)) clean &= ~(Button.Left | Button.Right);
  if ((clean & (Button.Up | Button.Down)) === (Button.Up | Button.Down)) clean &= ~(Button.Up | Button.Down);
  return clean;
}

/** Swaps left and right, for mirrored playback such as the fake relay's echo opponent. */
export function mirrorButtons(buttons: number): number {
  const left = buttons & Button.Left;
  const right = buttons & Button.Right;
  return (buttons & ~(Button.Left | Button.Right)) | (left ? Button.Right : 0) | (right ? Button.Left : 0);
}

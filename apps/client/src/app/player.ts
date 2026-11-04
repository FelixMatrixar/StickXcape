/** The local player: nickname, ink colour and loadout. */
import type { MoveFile } from '@sticxcape/shared';
import { library } from '../moves/library.ts';
import { buildLoadout } from '../moves/loadout.ts';
import { inkById, type Ink } from '../render/inks.ts';
import { settings } from './settings.ts';

export function myName(): string {
  return settings.nickname ?? 'Player';
}

export function myInk(): Ink {
  return inkById(settings.ink);
}

/** The full nine-move loadout this player fights with. */
export function myLoadout(): MoveFile[] {
  return buildLoadout(settings.loadout, library.files());
}

const FIRST = ['Inky', 'Brush', 'Scribble', 'Doodle', 'Sumi', 'Quill', 'Smudge', 'Blot', 'Sketch', 'Graphite', 'Charcoal', 'Nib'];
const LAST = ['Fist', 'Kick', 'Storm', 'Flash', 'Jab', 'Fury', 'Comet', 'Viper', 'Echo', 'Ghost', 'Rocket', 'Ronin'];

export function randomNickname(): string {
  const a = FIRST[Math.floor(Math.random() * FIRST.length)];
  const b = LAST[Math.floor(Math.random() * LAST.length)];
  return `${a} ${b}`.slice(0, 16);
}

export const BOT_NAMES: Record<string, string> = { easy: 'Doodle Bot', normal: 'Sketch Bot', hard: 'Sumi Bot' };

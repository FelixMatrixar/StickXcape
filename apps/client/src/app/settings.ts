/** Player settings, kept in this browser. Storage can be blocked (private mode), so every access is guarded. */
import type { BotLevel } from '../engine/bot.ts';
import type { LoadoutSelection } from '../moves/loadout.ts';

/** Two thumbs, or one thumb on the right or left (accessibility). */
export type ControlLayout = 'two' | 'oneRight' | 'oneLeft';

export interface Settings {
  nickname: string | null;
  ink: string;
  muted: boolean;
  music: number;
  sfx: number;
  /** Comfort (GF-5): 0 turns each one off. */
  shake: number;
  flashes: number;
  vibration: boolean;
  damageNumbers: boolean;
  buttonScale: number;
  controlLayout: ControlLayout;
  /** Saved button positions per layout, as fractions of the screen (centres). */
  controlPositions: Partial<Record<ControlLayout, Record<string, { x: number; y: number }>>>;
  /** The recorded idle stance to show between moves (LS-12), or null for the standard one. */
  idleStance: string | null;
  botLevel: BotLevel;
  arena: string;
  loadout: LoadoutSelection;
  /** Finished the first-run flow (nickname, record or skip). */
  onboarded: boolean;
  /** Dismissed the add-to-home-screen hint. */
  installHint: boolean;
  coachMarks: boolean;
}

const KEY = 'sticxcape.settings.v1';

const DEFAULTS: Settings = {
  nickname: null,
  ink: 'vermillion',
  muted: false,
  music: 0.55,
  sfx: 1,
  shake: 1,
  flashes: 1,
  vibration: true,
  damageNumbers: false,
  buttonScale: 1,
  controlLayout: 'two',
  controlPositions: {},
  idleStance: null,
  botLevel: 'normal',
  arena: 'rooftop',
  loadout: {},
  onboarded: false,
  installHint: false,
  coachMarks: true,
};

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
    // The services' test page and the relay lab saved a nickname here.
    const nickname = localStorage.getItem('sticxcape.nickname');
    if (nickname) return { ...DEFAULTS, nickname };
  } catch {
    // Blocked or corrupt storage: start fresh.
  }
  return { ...DEFAULTS };
}

type Listener = (settings: Settings) => void;
const listeners = new Set<Listener>();

export const settings: Settings = load();

export function updateSettings(patch: Partial<Settings>): void {
  Object.assign(settings, patch);
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
    if (patch.nickname) localStorage.setItem('sticxcape.nickname', patch.nickname);
  } catch {
    // Settings still apply for this visit.
  }
  for (const listener of listeners) listener(settings);
}

export function onSettings(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

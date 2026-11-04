/** Navigation between screens. Screens take callbacks, so only this file knows the whole map. */
import { music } from '../audio/music.ts';
import { defaultMoves } from '../moves/defaults.ts';
import { arenaById } from '../render/arenas.ts';
import { contrastInk } from '../render/inks.ts';
import { fightScreen, type FightResult } from '../screens/fight.ts';
import { homeScreen } from '../screens/home.ts';
import { nicknameScreen } from '../screens/nickname.ts';
import { resultsScreen } from '../screens/results.ts';
import { startScreen } from '../screens/start.ts';
import { titleScreen } from '../screens/title.ts';
import { toast } from '../ui/dom.ts';
import { BOT_NAMES, myInk, myLoadout, myName } from './player.ts';
import { show } from './router.ts';
import { settings, updateSettings } from './settings.ts';

let invite: string | null = null;

export const flow = {
  boot(code: string | null): void {
    invite = code;
    void show(() => titleScreen(() => flow.afterTitle()), 'none');
  },

  afterTitle(): void {
    music.play('menu');
    if (!settings.nickname || !settings.onboarded) {
      void show(() => nicknameScreen(() => flow.onboarding(), { step: 'Step 1 of 2' }));
    } else if (invite) {
      flow.room(invite);
    } else {
      flow.home();
    }
  },

  onboarding(): void {
    void show(() =>
      startScreen((record) => {
        updateSettings({ onboarded: true });
        if (record) flow.studio();
        else if (invite) flow.room(invite);
        else flow.home();
      }),
    );
  },

  home(): void {
    void show(() =>
      homeScreen({
        practice: () => flow.practice(),
        createRoom: () => flow.createRoom(),
        joinRoom: (code) => flow.room(code),
        studio: () => flow.studio(),
        loadout: () => flow.loadout(),
        editName: () => void show(() => nicknameScreen(() => flow.home(), { step: 'Your fighter', editing: true })),
      }),
    );
  },

  practice(): void {
    const arena = arenaById(settings.arena);
    const mine = myInk();
    const level = settings.botLevel;
    void show(() =>
      fightScreen({
        mode: 'practice',
        seed: (Math.random() * 0x7fffffff) | 0,
        arena,
        loadouts: [myLoadout(), defaultMoves()],
        names: [myName(), BOT_NAMES[level] ?? 'Bot'],
        inks: [mine, contrastInk(mine)],
        localSide: 0,
        botLevel: level,
        onFinish: (result) => flow.results(result, { rematch: () => flow.practice() }),
        onQuit: () => flow.home(),
      }),
    );
  },

  results(result: FightResult, options: { rematch: () => void; rematchLabel?: string }): void {
    void show(() =>
      resultsScreen(result, {
        rematch: options.rematch,
        rematchLabel: options.rematchLabel,
        editMoves: () => flow.studio(),
        home: () => flow.home(),
      }),
    );
  },

  async createRoom(): Promise<void> {
    toast('Rooms arrive with the next step of this build.', 'info');
  },

  room(code: string): void {
    void code;
    toast('Rooms arrive with the next step of this build.', 'info');
    flow.home();
  },

  studio(): void {
    toast('Move Studio arrives with the next step of this build.', 'info');
    flow.home();
  },

  loadout(): void {
    toast('The loadout arrives with the next step of this build.', 'info');
  },
};

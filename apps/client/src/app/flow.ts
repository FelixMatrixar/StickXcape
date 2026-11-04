/** Navigation between screens. Screens take callbacks, so only this file knows the whole map. */
import type { LockstepSession } from '@sticxcape/netcode';
import type { MatchEndMessage } from '@sticxcape/shared';
import { music } from '../audio/music.ts';
import { defaultMoves } from '../moves/defaults.ts';
import { completeLoadout, type LoadoutKey } from '../moves/loadout.ts';
import { arenaById } from '../render/arenas.ts';
import { contrastInk } from '../render/inks.ts';
import { fightScreen, type FightResult } from '../screens/fight.ts';
import { homeScreen } from '../screens/home.ts';
import { loadoutScreen } from '../screens/loadout.ts';
import { nicknameScreen } from '../screens/nickname.ts';
import { resultsScreen } from '../screens/results.ts';
import { roomScreen } from '../screens/room.ts';
import { startScreen } from '../screens/start.ts';
import { studioScreen } from '../screens/studio.ts';
import { titleScreen } from '../screens/title.ts';
import { toast } from '../ui/dom.ts';
import { activeRoom, OnlineRoom, relayErrorText, services, setActiveRoom } from './online.ts';
import { BOT_NAMES, myInk, myLoadout, myName } from './player.ts';
import { show } from './router.ts';
import { settings, updateSettings } from './settings.ts';

let invite: string | null = null;

function setPath(path: string): void {
  try {
    history.replaceState(null, '', path);
  } catch {
    // Some embedded browsers block history changes.
  }
}

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
    invite = null;
    setActiveRoom(null);
    setPath('/');
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

  studio(key?: LoadoutKey): void {
    void show(() => studioScreen(() => (invite ? flow.room(invite) : flow.home()), key));
  },

  loadout(): void {
    void show(() =>
      loadoutScreen({
        back: () => flow.home(),
        record: (key) => flow.studio(key),
      }),
    );
  },

  async createRoom(): Promise<void> {
    try {
      const { code } = await services.createRoom(myName());
      flow.room(code);
    } catch (err) {
      toast(err instanceof Error && 'status' in err && (err as { status: number }).status === 429 ? 'Too many rooms from here. Try again in a few minutes.' : 'Couldn’t reach the game server. Is it running?', 'error');
    }
  },

  /** Joins (or returns to) a room. */
  async room(code: string, lastEnd: MatchEndMessage | null = null): Promise<void> {
    invite = code;
    setPath(`/r/${code}`);
    let room = activeRoom();
    if (!room || room.code !== code) {
      try {
        room = await OnlineRoom.join(code, myName(), myLoadout());
        setActiveRoom(room);
      } catch (err) {
        toast(relayErrorText(err), 'error');
        flow.home();
        return;
      }
    } else {
      // Moves may have changed since the last match.
      room.sendLoadout(myLoadout());
    }
    const current = room;
    void show(() =>
      roomScreen(
        current,
        {
          leave: () => flow.home(),
          start: (session) => flow.onlineFight(current, session),
        },
        lastEnd,
      ),
    );
  },

  onlineFight(room: OnlineRoom, session: LockstepSession): void {
    const info = room.client.room;
    const mine = myInk();
    const other = contrastInk(mine);
    const sides = session.fighters;
    const local = session.localSide;
    const loadoutOf = (player: number) => (player === room.me ? room.loadout : completeLoadout(room.client.loadouts.get(player) ?? defaultMoves()));
    const nameOf = (player: number) => info?.players.find((p) => p.player === player)?.nickname ?? `Player ${player}`;
    let ended: MatchEndMessage | null = null;
    session.onEnd((end) => (ended = end));
    void show(() =>
      fightScreen({
        mode: 'online',
        seed: session.seed,
        arena: arenaById(session.arenaId),
        loadouts: [loadoutOf(sides[0]), loadoutOf(sides[1])],
        names: [nameOf(sides[0]), nameOf(sides[1])],
        inks: local === 0 ? [mine, other] : [other, mine],
        localSide: local,
        session,
        onFinish: (result) =>
          flow.results(result, {
            rematch: () => void flow.room(room.code, ended),
            rematchLabel: 'Back to room',
          }),
        onQuit: () => flow.home(),
      }),
    );
  },
};

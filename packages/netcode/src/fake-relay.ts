import {
  cleanText,
  MIN_INPUT_DELAY,
  mirrorButtons,
  NICKNAME_MAX_LENGTH,
  type ClientMessage,
  type MoveFile,
  type RoomInfo,
  type ServerMessage,
} from '@sticxcape/shared';
import type { RelayTransport } from './transport.ts';

export interface FakeRelayOptions {
  /** The echo opponent mirrors left and right, so it walks toward you as you walk toward it. Default true. */
  mirror?: boolean;
  /** Delay before each reply, to feel like a network. Keep it under the input delay for smooth play. */
  latencyMs?: number;
  opponentName?: string;
  inputDelay?: number;
  seed?: number;
}

/**
 * A relay that runs inside the page, for building the online flow before the real relay is up
 * (Integration PRD: mocks until week 2). The opponent, Echo, fights with your loadout and plays
 * back your own inputs. Use it anywhere a RelayTransport goes: `new RelayClient(createFakeRelay())`.
 */
export function createFakeRelay(options: FakeRelayOptions = {}): RelayTransport {
  const { mirror = true, latencyMs = 0, opponentName = 'Echo', inputDelay = MIN_INPUT_DELAY } = options;
  let messageHandler: ((message: ServerMessage) => void) | null = null;
  let closeHandler: (reason: string) => void = () => {};
  const early: ServerMessage[] = [];
  let nickname = 'You';
  let moves: MoveFile[] | null = null;
  let arenaId: string | null = null;
  let ready = false;
  let inMatch = false;
  let closed = false;

  const deliver = (message: ServerMessage) => {
    setTimeout(() => {
      if (closed) return;
      if (messageHandler) messageHandler(message);
      else early.push(message);
    }, latencyMs);
  };
  const room = (): RoomInfo => ({
    code: 'local',
    players: [
      { player: 1, nickname, host: true, ready, hasLoadout: moves !== null },
      { player: 2, nickname: opponentName, host: false, ready: moves !== null, hasLoadout: moves !== null },
    ],
    arenaId,
    queue: [1, 2],
    fighters: inMatch ? [1, 2] : null,
  });

  return {
    send(message: ClientMessage) {
      if (closed) return;
      switch (message.type) {
        case 'join':
          nickname = cleanText(message.nickname, NICKNAME_MAX_LENGTH) ?? nickname;
          return deliver({ type: 'joined', player: 1, host: true, room: room() });
        case 'loadout':
          moves = message.moves;
          ready = false;
          deliver({ type: 'loadout', player: 2, moves: message.moves });
          return deliver({ type: 'room', room: room() });
        case 'arena':
          arenaId = message.arenaId;
          return deliver({ type: 'room', room: room() });
        case 'ready':
          if (!moves) return deliver({ type: 'error', code: 'no_loadout', message: 'Send a loadout before getting ready' });
          ready = true;
          inMatch = true;
          deliver({ type: 'start', seed: options.seed ?? Math.floor(Math.random() * 0x100000000), inputDelay, startFrame: 0, fighters: [1, 2], arenaId });
          return deliver({ type: 'room', room: room() });
        case 'input':
          return deliver({ type: 'input', frame: message.frame, buttons: mirror ? mirrorButtons(message.buttons) : message.buttons });
        case 'hash':
          return deliver({ type: 'hash', frame: message.frame, stateHash: message.stateHash });
        case 'end':
          if (!inMatch) return;
          inMatch = false;
          ready = false;
          deliver({ type: 'end', winner: message.winner, reason: 'finished' });
          return deliver({ type: 'room', room: room() });
        case 'ping':
          return deliver({ type: 'pong', time: message.time });
        case 'pong':
          return;
      }
    },
    onMessage(handler) {
      messageHandler = handler;
      for (const message of early.splice(0)) handler(message);
    },
    onClose(handler) {
      closeHandler = handler;
    },
    close() {
      if (closed) return;
      closed = true;
      closeHandler('closed');
    },
  };
}

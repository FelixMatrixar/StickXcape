import type { ClientMessage, StartMessage } from '@sticxcape/shared';
import { MatchSession } from '../src/session.ts';

export const START: StartMessage = { type: 'start', seed: 1234, inputDelay: 3, startFrame: 0, fighters: [1, 2], arenaId: null };

/**
 * Two sessions joined by an in-memory relay: `deliver()` passes inputs, hashes and sync reports
 * each side has sent to the other, as the relay would. Everything sent is also kept in `sent`.
 */
export function linkedSessions(start: StartMessage = START) {
  const outbox: [ClientMessage[], ClientMessage[]] = [[], []];
  const sent: [ClientMessage[], ClientMessage[]] = [[], []];
  const sessions = ([0, 1] as const).map(
    (side) =>
      new MatchSession({
        localPlayer: start.fighters[side],
        start,
        send: (message) => {
          outbox[side].push(message);
          sent[side].push(message);
        },
      }),
  ) as [MatchSession, MatchSession];

  const deliver = () => {
    for (const side of [0, 1] as const) {
      for (const message of outbox[side].splice(0)) {
        if (message.type === 'input' || message.type === 'hash' || message.type === 'sync') sessions[side === 0 ? 1 : 0].receive(message);
      }
    }
  };
  return { sessions, sent, deliver };
}

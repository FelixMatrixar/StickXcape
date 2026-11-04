/**
 * The phone's friend room: one relay connection that lives across the room, fight and results
 * screens, so a rematch is one tap. Built on the backend's netcode module.
 */
import { connectWebSocket, RelayClient, RelayError, ServicesClient } from '@sticxcape/netcode';
import { roomLink, type MoveFile } from '@sticxcape/shared';

export const services = new ServicesClient();

export class OnlineRoom {
  readonly client: RelayClient;
  readonly code: string;
  /** The loadout this phone sent, exactly as sent. */
  loadout: MoveFile[];

  private constructor(client: RelayClient, code: string, loadout: MoveFile[]) {
    this.client = client;
    this.code = code;
    this.loadout = loadout;
  }

  static async join(code: string, nickname: string, loadout: MoveFile[]): Promise<OnlineRoom> {
    const transport = await connectWebSocket(services.relayUrl);
    const client = new RelayClient(transport);
    try {
      await client.join(code, nickname);
    } catch (err) {
      client.close();
      throw err;
    }
    client.sendLoadout(loadout);
    return new OnlineRoom(client, code, loadout);
  }

  get link(): string {
    return roomLink(location.origin, this.code);
  }

  get me(): number | null {
    return this.client.player;
  }

  sendLoadout(loadout: MoveFile[]): void {
    this.loadout = loadout;
    this.client.sendLoadout(loadout);
  }

  close(): void {
    this.client.close();
  }
}

/** Plain words for the relay's errors. */
export function relayErrorText(err: unknown): string {
  if (err instanceof RelayError) {
    switch (err.code) {
      case 'room_not_found':
        return 'That room has closed or never existed. Create a new one.';
      case 'room_full':
        return 'That room is full (8 players).';
      case 'version_mismatch':
        return 'This page is out of date. Reload to update.';
      case 'bad_nickname':
        return 'That nickname can’t be used. Pick another.';
      case 'match_in_progress':
        return 'A match is running. You’ll fight when it ends.';
      default:
        return err.message;
    }
  }
  return 'Couldn’t reach the game server. Check your connection and try again.';
}

let active: OnlineRoom | null = null;

export function activeRoom(): OnlineRoom | null {
  return active && !active.client.closed ? active : null;
}

export function setActiveRoom(room: OnlineRoom | null): void {
  if (active && active !== room) active.close();
  active = room;
}

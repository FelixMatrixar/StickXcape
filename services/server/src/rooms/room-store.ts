import { MAX_ROOM_PLAYERS, type RoomSummary } from '@sticxcape/shared';
import { newRoomCode } from '../lib/random.ts';

export interface RoomMember {
  player: number;
  nickname: string;
}

/**
 * A room: who is in it, who hosts and which arena the host picked. Lives in memory only. A friend
 * room holds up to 8 by invite link; a quick match room holds the two strangers the relay paired.
 */
export class Room {
  readonly code: string;
  readonly createdBy: string;
  readonly members = new Map<number, RoomMember>();
  host: number | null = null;
  arenaId: string | null = null;
  inMatch = false;
  /** When the room last became empty (a new room starts empty); null while anyone is in it. */
  emptySince: number | null;
  /** A quick match room: two players, signed loadouts only, and rated results. */
  quick = false;
  maxPlayers = MAX_ROOM_PLAYERS;

  constructor(code: string, createdBy: string, now: number) {
    this.code = code;
    this.createdBy = createdBy;
    this.emptySince = now;
  }

  get isFull(): boolean {
    return this.members.size >= this.maxPlayers;
  }

  /** Adds a player with the lowest free number; the first one in hosts. Null when the room is full. */
  addMember(nickname: string): RoomMember | null {
    if (this.isFull) return null;
    let player = 1;
    while (this.members.has(player)) player += 1;
    const member = { player, nickname };
    this.members.set(player, member);
    this.host ??= player;
    this.emptySince = null;
    return member;
  }

  /** Removes a player. If they hosted, the lowest remaining player number takes over. */
  removeMember(player: number, now: number): void {
    if (!this.members.delete(player)) return;
    if (this.host === player) this.host = this.members.size > 0 ? Math.min(...this.members.keys()) : null;
    if (this.members.size === 0) this.emptySince = now;
  }

  summary(): RoomSummary {
    return {
      exists: true,
      players: [...this.members.values()]
        .sort((a, b) => a.player - b.player)
        .map(({ player, nickname }) => ({ player, nickname, host: player === this.host })),
      arena: this.arenaId,
      inMatch: this.inMatch,
    };
  }
}

export interface RoomStoreOptions {
  maxRooms: number;
  emptyTtlMs: number;
  now: () => number;
  newCode?: () => string;
}

/** Creates rooms, finds them by code and expires the ones that stay empty for an hour. */
export class RoomStore {
  private readonly rooms = new Map<string, Room>();
  private readonly options: RoomStoreOptions;
  private readonly removeListeners: ((room: Room) => void)[] = [];

  constructor(options: RoomStoreOptions) {
    this.options = options;
  }

  /** A new room, or null when the server already holds its maximum. */
  create(createdBy: string): Room | null {
    if (this.rooms.size >= this.options.maxRooms) {
      this.sweep();
      if (this.rooms.size >= this.options.maxRooms) return null;
    }
    const newCode = this.options.newCode ?? newRoomCode;
    let code = newCode();
    while (this.rooms.has(code)) code = newCode();
    const room = new Room(code, createdBy, this.options.now());
    this.rooms.set(code, room);
    return room;
  }

  /** The room with this code, unless it doesn't exist or has expired. */
  get(code: string): Room | undefined {
    const room = this.rooms.get(code);
    if (room && this.isExpired(room)) {
      this.delete(code);
      return undefined;
    }
    return room;
  }

  delete(code: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    this.rooms.delete(code);
    for (const listener of this.removeListeners) listener(room);
  }

  /** Removes expired rooms; returns how many went. */
  sweep(): number {
    let removed = 0;
    for (const room of [...this.rooms.values()]) {
      if (this.isExpired(room)) {
        this.delete(room.code);
        removed += 1;
      }
    }
    return removed;
  }

  onRemove(listener: (room: Room) => void): void {
    this.removeListeners.push(listener);
  }

  get size(): number {
    return this.rooms.size;
  }

  private isExpired(room: Room): boolean {
    return room.emptySince !== null && this.options.now() - room.emptySince >= this.options.emptyTtlMs;
  }
}

import {
  defaultMoveName,
  PLAYER_ID_HEADER,
  PLAYER_ID_PATTERN,
  type ApiError,
  type CreateRoomResponse,
  type MatchTipsRequest,
  type MatchTipsResponse,
  type MoveNameRequest,
  type MoveNameResponse,
  type MoveSlot,
  type RoomSummary,
  type VersionResponse,
} from '@sticxcape/shared';

/** An HTTP call to the services failed, such as 429 too_many_rooms. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly error: string;

  constructor(status: number, error: string, message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.error = error;
  }
}

export interface ServicesOptions {
  /** Origin of the services, such as https://play.example.com. Defaults to the page's own origin. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** Rooms and the version check over HTTP. */
export class ServicesClient {
  readonly baseUrl: string;
  private readonly fetch: typeof fetch;

  constructor(options: ServicesOptions = {}) {
    this.baseUrl = (options.baseUrl ?? globalThis.location?.origin ?? '').replace(/\/+$/, '');
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** The relay's WebSocket URL: wss:// for an https:// server. */
  get relayUrl(): string {
    return `${this.baseUrl.replace(/^http/, 'ws')}/ws`;
  }

  createRoom(nickname: string): Promise<CreateRoomResponse> {
    return this.request('POST', '/rooms', { nickname });
  }

  /** The room's players and arena, or null when it doesn't exist or has expired. */
  async getRoom(code: string): Promise<RoomSummary | null> {
    try {
      return await this.request<RoomSummary>('GET', `/rooms/${encodeURIComponent(code)}`);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) return null;
      throw err;
    }
  }

  /** The lowest client version the server accepts; an older page should reload. */
  getVersion(): Promise<VersionResponse> {
    return this.request('GET', '/version');
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetch(this.baseUrl + path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = data as Partial<ApiError> | null;
      throw new ApiRequestError(response.status, error?.error ?? 'http_error', error?.message ?? `HTTP ${response.status}`);
    }
    return data as T;
  }
}

export interface MoveNameSuggestion {
  name: string;
  description: string | null;
  source: 'ai' | 'default';
}

/** Meta AI as the game uses it: never more than 5 s, and a match never fails because of AI. */
export interface AiService {
  /** A Meta AI name, or the default such as "Heavy 2" when AI is unavailable, over its limit or too slow. */
  suggestMoveName(request: MoveNameRequest, slotIndex?: number): Promise<MoveNameSuggestion>;
  /** Exactly 2 tips, or none when AI is unavailable; the results screen shows either way. */
  getMatchTips(request: MatchTipsRequest): Promise<string[]>;
}

export const AI_TIMEOUT_MS = 5000;

/** Calls the AI gateway, falling back on any error or after 5 s. */
export class HttpAiService implements AiService {
  private readonly baseUrl: string;
  private readonly playerId: string;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ServicesOptions & { playerId?: string; timeoutMs?: number } = {}) {
    this.baseUrl = (options.baseUrl ?? globalThis.location?.origin ?? '').replace(/\/+$/, '');
    this.playerId = options.playerId ?? playerId();
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? AI_TIMEOUT_MS;
  }

  async suggestMoveName(request: MoveNameRequest, slotIndex = 1): Promise<MoveNameSuggestion> {
    const reply = await this.post<MoveNameResponse>('/ai/move-name', request);
    return reply && typeof reply.name === 'string'
      ? { name: reply.name, description: reply.description, source: 'ai' }
      : { name: defaultMoveName(request.slot, slotIndex), description: null, source: 'default' };
  }

  async getMatchTips(request: MatchTipsRequest): Promise<string[]> {
    const reply = await this.post<MatchTipsResponse>('/ai/match-tips', request);
    return Array.isArray(reply?.tips) && reply.tips.length === 2 ? [...reply.tips] : [];
  }

  private async post<T>(path: string, body: unknown): Promise<T | null> {
    try {
      const response = await this.fetch(this.baseUrl + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [PLAYER_ID_HEADER]: this.playerId },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return response.ok ? ((await response.json()) as T) : null;
    } catch {
      return null;
    }
  }
}

const CANNED_NAMES: Record<MoveSlot, string> = {
  light: 'Quick Jab',
  heavy: 'Thunder Fist',
  low: 'Leg Sweep',
  special: 'Flying Kick',
  defense: 'Slip Away',
  taunt: 'Come At Me',
  victory: 'Champion Pose',
};

/** Canned names and tips for working offline (Integration PRD: mocks until week 2). */
export class CannedAiService implements AiService {
  async suggestMoveName(request: MoveNameRequest, slotIndex = 1): Promise<MoveNameSuggestion> {
    const name = slotIndex > 1 ? `${CANNED_NAMES[request.slot]} ${slotIndex}` : CANNED_NAMES[request.slot];
    return { name, description: `A ${request.height} move led by the ${request.limb}.`, source: 'ai' };
  }

  async getMatchTips(request: MatchTipsRequest): Promise<string[]> {
    const parried = [...request.moves].sort((a, b) => b.parries - a.parries)[0];
    return [
      parried && parried.parries > 0 ? `${parried.name} was parried ${parried.parries} times; delay it a beat.` : 'Tap Block just before a hit lands to parry.',
      'Mix high, mid and low moves so they cannot guard everything.',
    ];
  }
}

const PLAYER_ID_KEY = 'sticxcape.playerId';

/** A random id kept in this browser, so AI limits apply per player before accounts exist. */
export function playerId(storage: Pick<Storage, 'getItem' | 'setItem'> | null = browserStorage()): string {
  try {
    const saved = storage?.getItem(PLAYER_ID_KEY);
    if (saved && PLAYER_ID_PATTERN.test(saved)) return saved;
  } catch {
    // Storage can be blocked (private mode); a fresh id per page load still works.
  }
  const id = crypto.randomUUID();
  try {
    storage?.setItem(PLAYER_ID_KEY, id);
  } catch {
    // As above.
  }
  return id;
}

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

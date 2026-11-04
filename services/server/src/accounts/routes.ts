import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ACCOUNT_ID_PATTERN,
  ACCOUNT_PATH,
  cleanText,
  moveRuleProblem,
  parseAccountName,
  parseCloudMove,
  parseLoadoutSelection,
  parseMoveFile,
  parsePasskeyAssertion,
  parsePasskeyRegistration,
  REPORT_NOTE_MAX_LENGTH,
  REPORT_REASONS,
  SIGN_MAX_MOVES,
  verifyMoveHash,
  type AccountInfo,
  type AccountResponse,
  type ApiError,
  type BlockedPlayer,
  type LibraryResponse,
  type LoadoutSelection,
  type MoveFile,
  type PasskeyCeremony,
  type PasskeyCreationOptions,
  type PasskeyRequestOptions,
  type ReportReason,
  type SaveMoveResponse,
  type SignMovesResponse,
} from '@sticxcape/shared';
import type { AiGateway } from '../ai/gateway.ts';
import type { Config } from '../config.ts';
import { WindowLimiter } from '../lib/limits.ts';
import type { Metrics } from '../metrics/metrics.ts';
import { moveSheet } from '../moderation/stick-figure.ts';
import type { MoveSigner } from './signing.ts';
import type { AccountStore } from './store.ts';
import { PASSKEY_ALGORITHMS, PasskeyError, verifyAssertion, verifyRegistration, type NewCredential, type RelyingParty } from './webauthn.ts';

export interface AccountRoutesOptions {
  config: Config;
  /** Null when accounts are off: the routes then say so, and GET /account reports no passkeys. */
  store: AccountStore | null;
  /** Signs checked moves for quick match; null when accounts are off. */
  signer: MoveSigner | null;
  /** Checks taunt and victory moves before they're signed. */
  ai: AiGateway;
  metrics: Metrics;
  now: () => number;
}

const COOKIE = 'sx_session';
const COOKIE_VALUE = /^[A-Za-z0-9_-]{20,100}$/;
/** A passkey prompt must be answered within this long. */
const CEREMONY_TTL_MS = 5 * 60 * 1000;
const PASSKEY_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_CEREMONIES = 10_000;
/** Shown in passkey managers next to the player's nickname. */
const RP_NAME = 'SticXcape';
const DAY_MS = 24 * 60 * 60 * 1000;
/** Library changes one account may make per 10 minutes: plenty for syncing a whole library. */
const LIBRARY_WRITES = 600;
/** Reports one account may file a day. */
const REPORTS_PER_DAY = 20;

interface Ceremony {
  kind: 'register' | 'login';
  challenge: string;
  origin: string;
  expiresAt: number;
  name?: string;
  userHandle?: string;
}

interface Session {
  account: AccountInfo;
  expiresAt: number;
  token: string;
}

/**
 * Accounts and the cloud move library (launch, MP-9), all under /account. Sign-up and sign-in
 * use passkeys; a sign-in is an HttpOnly, SameSite=Lax cookie that lasts 180 days and renews
 * itself when used. Returns a pruner for the server's sweep timer.
 */
export function registerAccountRoutes(app: FastifyInstance, { config, store, signer, ai, metrics, now }: AccountRoutesOptions): { prune(at: number): void } {
  const ceremonies = new Map<string, Ceremony>();
  const passkeyLimiter = new WindowLimiter(config.accounts.passkeyLimitPerIp, config.accounts.passkeyWindowMs);
  const writeLimiter = new WindowLimiter(LIBRARY_WRITES, 10 * 60 * 1000);
  const ttl = config.accounts.sessionTtlMs;

  /** The site passkeys belong to: PUBLIC_URL, or in development the address the page was opened at. */
  const relyingParty = (request: FastifyRequest): RelyingParty | null => {
    const origin = config.publicUrl ?? (config.env === 'production' ? null : `${request.protocol}://${request.host}`);
    if (!origin) return null;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return null;
    }
    // Passkeys need a domain name (an IP address can't be one) on HTTPS, or localhost.
    const id = url.hostname;
    if (isIP(id.replace(/^\[|\]$/g, '')) !== 0) return null;
    const secure = url.protocol === 'https:' || id === 'localhost' || id.endsWith('.localhost');
    return secure ? { id, name: RP_NAME, origin: url.origin } : null;
  };

  const sessionOf = (request: FastifyRequest): Session | null => {
    const token = readCookie(request.headers.cookie, COOKIE);
    const found = token && store ? store.findSession(token) : undefined;
    return found && token ? { ...found, token } : null;
  };

  const setSessionCookie = (request: FastifyRequest, reply: FastifyReply, token: string) => {
    const secure = request.protocol === 'https' ? '; Secure' : '';
    reply.header('set-cookie', `${COOKIE}=${token}; Path=/; Max-Age=${Math.floor(ttl / 1000)}; HttpOnly; SameSite=Lax${secure}`);
  };

  const clearSessionCookie = (request: FastifyRequest, reply: FastifyReply) => {
    const secure = request.protocol === 'https' ? '; Secure' : '';
    reply.header('set-cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`);
  };

  /** Changes must come from the game's own pages (the cookie is SameSite=Lax as well). Apps without an Origin header are fine. */
  const sameOrigin = async (request: FastifyRequest, reply: FastifyReply) => {
    const origin = request.headers.origin;
    if (origin === undefined) return;
    const expected = config.publicUrl ?? `${request.protocol}://${request.host}`;
    if (origin !== expected) return reply.code(403).send(apiError('wrong_origin', 'Account changes must come from the game itself'));
  };

  /** The store and the site, or a 503 saying why passkeys can't be used here. */
  const passkeysReady = (request: FastifyRequest, reply: FastifyReply): { store: AccountStore; rp: RelyingParty } | null => {
    if (!store) {
      void reply.code(503).send(apiError('accounts_off', 'Accounts are switched off on this server'));
      return null;
    }
    const rp = relyingParty(request);
    if (!rp) {
      void reply.code(503).send(apiError('passkeys_unavailable', 'Passkeys need the game on HTTPS with a domain name, or on localhost'));
      return null;
    }
    return { store, rp };
  };

  /** The signed-in session, or a 401 (503 when accounts are off). */
  const requireSession = (request: FastifyRequest, reply: FastifyReply): { store: AccountStore; session: Session } | null => {
    if (!store) {
      void reply.code(503).send(apiError('accounts_off', 'Accounts are switched off on this server'));
      return null;
    }
    const session = sessionOf(request);
    if (!session) {
      void reply.code(401).send(apiError('not_signed_in', 'Sign in with your passkey first'));
      return null;
    }
    return { store, session };
  };

  const startCeremony = (ceremony: Omit<Ceremony, 'expiresAt'>): string => {
    if (ceremonies.size >= MAX_CEREMONIES) prune(now());
    // Still full: drop the oldest; its player can simply try again.
    if (ceremonies.size >= MAX_CEREMONIES) ceremonies.delete(ceremonies.keys().next().value!);
    const id = randomBytes(18).toString('base64url');
    ceremonies.set(id, { ...ceremony, expiresAt: now() + CEREMONY_TTL_MS });
    return id;
  };

  /** Each ceremony is used once, whether the answer passes or not. */
  const takeCeremony = (id: unknown, kind: Ceremony['kind'], rp: RelyingParty): Ceremony | null => {
    if (typeof id !== 'string') return null;
    const ceremony = ceremonies.get(id);
    if (!ceremony) return null;
    ceremonies.delete(id);
    return ceremony.kind === kind && ceremony.expiresAt > now() && ceremony.origin === rp.origin ? ceremony : null;
  };

  const limited = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (passkeyLimiter.take(request.ip, now())) return false;
    void reply.code(429).send(apiError('too_many_attempts', 'Too many passkey attempts from this network; try again in a few minutes'));
    return true;
  };

  const rejected = (request: FastifyRequest, reply: FastifyReply, ceremony: Ceremony['kind'], err: unknown, status: number) => {
    if (!(err instanceof PasskeyError)) throw err;
    metrics.passkeyChecks.inc({ ceremony, outcome: 'rejected' });
    request.log.warn({ reason: err.message }, `passkey ${ceremony} refused`);
    return reply.code(status).send(apiError('passkey_rejected', 'That passkey could not be checked; try again'));
  };

  function prune(at: number): void {
    for (const [id, ceremony] of ceremonies) if (ceremony.expiresAt <= at) ceremonies.delete(id);
    passkeyLimiter.prune(at);
    writeLimiter.prune(at);
  }

  // Who is signed in.

  app.get<{ Reply: AccountResponse }>(ACCOUNT_PATH, async (request, reply) => {
    const session = sessionOf(request);
    // Renew a sign-in that is used, so active players stay signed in.
    if (session && store && session.expiresAt - now() < ttl - DAY_MS) {
      store.extendSession(session.token, ttl);
      setSessionCookie(request, reply, session.token);
    }
    return { account: session?.account ?? null, passkeys: store !== null && relyingParty(request) !== null };
  });

  // Sign up: a new account with a new passkey.

  app.post<{ Reply: PasskeyCeremony<PasskeyCreationOptions> | ApiError }>(`${ACCOUNT_PATH}/passkey/register/options`, { preHandler: sameOrigin }, async (request, reply) => {
    const ready = passkeysReady(request, reply);
    if (!ready) return reply;
    const name = parseAccountName((request.body as { name?: unknown } | undefined)?.name);
    if (name === null) return reply.code(400).send(apiError('bad_name', 'Your name must be 1 to 16 characters'));
    if (limited(request, reply)) return reply;
    const challenge = randomBytes(32).toString('base64url');
    // The passkey's user id is random, never the name or anything else about the player.
    const userHandle = randomBytes(32).toString('base64url');
    const ceremony = startCeremony({ kind: 'register', challenge, origin: ready.rp.origin, name, userHandle });
    return {
      ceremony,
      options: {
        challenge,
        rp: { id: ready.rp.id, name: ready.rp.name },
        user: { id: userHandle, name, displayName: name },
        pubKeyCredParams: PASSKEY_ALGORITHMS.map((alg) => ({ type: 'public-key' as const, alg })),
        timeout: PASSKEY_TIMEOUT_MS,
        attestation: 'none',
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        excludeCredentials: [],
      },
    };
  });

  app.post<{ Reply: { account: AccountInfo } | ApiError }>(`${ACCOUNT_PATH}/passkey/register`, { preHandler: sameOrigin }, async (request, reply) => {
    const ready = passkeysReady(request, reply);
    if (!ready) return reply;
    const body = request.body as { ceremony?: unknown; credential?: unknown } | undefined;
    const ceremony = takeCeremony(body?.ceremony, 'register', ready.rp);
    if (!ceremony || !ceremony.name || !ceremony.userHandle) return reply.code(400).send(apiError('ceremony_expired', 'That sign-up timed out; start again'));
    const registration = parsePasskeyRegistration(body?.credential);
    if (!registration) return reply.code(400).send(apiError('bad_request', 'The passkey answer is malformed'));

    let credential: NewCredential;
    try {
      credential = verifyRegistration(registration, ceremony.challenge, ready.rp);
    } catch (err) {
      return rejected(request, reply, 'register', err, 400);
    }
    if (ready.store.hasCredential(credential.id)) return reply.code(409).send(apiError('passkey_exists', 'This passkey already belongs to an account; sign in with it'));

    const account = ready.store.createAccount(ceremony.name, ceremony.userHandle, credential);
    setSessionCookie(request, reply, ready.store.createSession(account.id, ttl));
    metrics.accountsCreated.inc();
    metrics.passkeyChecks.inc({ ceremony: 'register', outcome: 'ok' });
    request.log.info({ account: account.id, backedUp: credential.backedUp }, 'account created');
    return reply.code(201).send({ account });
  });

  // Sign in with a passkey this browser or phone already has.

  app.post<{ Reply: PasskeyCeremony<PasskeyRequestOptions> | ApiError }>(`${ACCOUNT_PATH}/passkey/login/options`, { preHandler: sameOrigin }, async (request, reply) => {
    const ready = passkeysReady(request, reply);
    if (!ready) return reply;
    if (limited(request, reply)) return reply;
    const challenge = randomBytes(32).toString('base64url');
    const ceremony = startCeremony({ kind: 'login', challenge, origin: ready.rp.origin });
    // No allowCredentials: the phone offers whichever of its passkeys belong to this site.
    return { ceremony, options: { challenge, rpId: ready.rp.id, timeout: PASSKEY_TIMEOUT_MS, userVerification: 'required', allowCredentials: [] } };
  });

  app.post<{ Reply: { account: AccountInfo } | ApiError }>(`${ACCOUNT_PATH}/passkey/login`, { preHandler: sameOrigin }, async (request, reply) => {
    const ready = passkeysReady(request, reply);
    if (!ready) return reply;
    const body = request.body as { ceremony?: unknown; credential?: unknown } | undefined;
    const ceremony = takeCeremony(body?.ceremony, 'login', ready.rp);
    if (!ceremony) return reply.code(400).send(apiError('ceremony_expired', 'That sign-in timed out; start again'));
    const assertion = parsePasskeyAssertion(body?.credential);
    if (!assertion) return reply.code(400).send(apiError('bad_request', 'The passkey answer is malformed'));
    const record = ready.store.findCredential(assertion.id);
    if (!record) {
      metrics.passkeyChecks.inc({ ceremony: 'login', outcome: 'rejected' });
      return reply.code(401).send(apiError('unknown_passkey', 'This passkey is not registered here; its account may have been deleted'));
    }

    let signCount: number;
    try {
      ({ signCount } = verifyAssertion(assertion, ceremony.challenge, ready.rp, record, record.userHandle));
    } catch (err) {
      return rejected(request, reply, 'login', err, 401);
    }
    ready.store.recordSignIn(record.id, signCount);
    const account = ready.store.getAccount(record.accountId)!;
    setSessionCookie(request, reply, ready.store.createSession(account.id, ttl));
    metrics.passkeyChecks.inc({ ceremony: 'login', outcome: 'ok' });
    return { account };
  });

  app.post<{ Reply: AccountResponse }>(`${ACCOUNT_PATH}/logout`, { preHandler: sameOrigin }, async (request, reply) => {
    const session = sessionOf(request);
    if (session && store) store.deleteSession(session.token);
    clearSessionCookie(request, reply);
    return { account: null, passkeys: store !== null && relyingParty(request) !== null };
  });

  /** Deletes the account with its passkey records, sign-ins and cloud library. The passkey stays on the phone until removed there. */
  app.delete(ACCOUNT_PATH, { preHandler: sameOrigin }, async (request, reply) => {
    const ready = requireSession(request, reply);
    if (!ready) return reply;
    ready.store.deleteAccount(ready.session.account.id);
    clearSessionCookie(request, reply);
    request.log.info({ account: ready.session.account.id }, 'account deleted');
    return reply.code(204).send();
  });

  // The cloud move library.

  app.get<{ Reply: LibraryResponse | ApiError }>(`${ACCOUNT_PATH}/library`, async (request, reply) => {
    const ready = requireSession(request, reply);
    if (!ready) return reply;
    return ready.store.library(ready.session.account.id);
  });

  app.put<{ Params: { id: string }; Reply: SaveMoveResponse | ApiError }>(`${ACCOUNT_PATH}/library/moves/:id`, { preHandler: sameOrigin }, async (request, reply) => {
    const ready = requireSession(request, reply);
    if (!ready) return reply;
    const accountId = ready.session.account.id;
    if (!writeLimiter.take(accountId, now())) return reply.code(429).send(apiError('too_many_changes', 'Too many library changes; try again in a few minutes'));
    const input = parseCloudMove(request.body);
    if (!input) return reply.code(400).send(apiError('bad_move', 'The move or its details are malformed'));
    if (input.move.id !== request.params.id) return reply.code(400).send(apiError('bad_move', "The move's id doesn't match the address"));
    if (!(await verifyMoveHash(input.move))) return reply.code(400).send(apiError('bad_move', "The move's hash doesn't match its contents"));
    const updatedAt = ready.store.saveMove(accountId, input, config.accounts.maxMoves);
    if (updatedAt === null) return reply.code(409).send(apiError('library_full', `A cloud library holds at most ${config.accounts.maxMoves} moves`));
    return { updatedAt };
  });

  app.delete<{ Params: { id: string } }>(`${ACCOUNT_PATH}/library/moves/:id`, { preHandler: sameOrigin }, async (request, reply) => {
    const ready = requireSession(request, reply);
    if (!ready) return reply;
    if (!writeLimiter.take(ready.session.account.id, now())) return reply.code(429).send(apiError('too_many_changes', 'Too many library changes; try again in a few minutes'));
    if (!ready.store.deleteMove(ready.session.account.id, request.params.id)) return reply.code(404).send(apiError('not_found', 'No such move in your library'));
    return reply.code(204).send();
  });

  app.put<{ Reply: { loadout: LoadoutSelection } | ApiError }>(`${ACCOUNT_PATH}/library/loadout`, { preHandler: sameOrigin }, async (request, reply) => {
    const ready = requireSession(request, reply);
    if (!ready) return reply;
    if (!writeLimiter.take(ready.session.account.id, now())) return reply.code(429).send(apiError('too_many_changes', 'Too many library changes; try again in a few minutes'));
    const loadout = parseLoadoutSelection((request.body as { loadout?: unknown } | undefined)?.loadout);
    if (!loadout) return reply.code(400).send(apiError('bad_loadout', 'A loadout names up to 16 places, each with a move id'));
    ready.store.saveLoadout(ready.session.account.id, loadout);
    return { loadout };
  });

  // Quick match: signed loadouts, blocks and reports.

  /**
   * Re-checks moves and signs them; quick match takes only signed moves (MP-8). Taunts and
   * victory moves only show off, so they're where a rude gesture would go: Muse Spark looks at
   * the server's own drawing of each before strangers can see it.
   */
  app.post<{ Reply: SignMovesResponse | ApiError }>(`${ACCOUNT_PATH}/moves/sign`, { preHandler: sameOrigin }, async (request, reply) => {
    const ready = requireSession(request, reply);
    if (!ready) return reply;
    if (!signer) return reply.code(503).send(apiError('accounts_off', 'Move signing is switched off on this server'));
    if (!writeLimiter.take(ready.session.account.id, now())) return reply.code(429).send(apiError('too_many_changes', 'Too many requests; try again in a few minutes'));
    const raw = (request.body as { moves?: unknown } | undefined)?.moves;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > SIGN_MAX_MOVES) return reply.code(400).send(apiError('bad_move', `Send 1 to ${SIGN_MAX_MOVES} moves`));
    const moves: MoveFile[] = [];
    for (const [i, item] of raw.entries()) {
      const move = parseMoveFile(item);
      if (!move) return reply.code(400).send(apiError('bad_move', `Move ${i + 1} is malformed`));
      if (!(await verifyMoveHash(move))) return reply.code(400).send(apiError('bad_move', `Move ${i + 1} (${move.name}): its hash doesn't match its contents`));
      const problem = moveRuleProblem(move);
      if (problem) return reply.code(400).send(apiError('bad_move', `Move ${i + 1} (${move.name}): ${problem}`));
      moves.push(move);
    }

    const who = { playerKey: ready.session.account.id, ip: request.ip };
    const shown = moves.filter((move): move is MoveFile & { slot: 'taunt' | 'victory' } => move.slot === 'taunt' || move.slot === 'victory');
    const verdicts = await Promise.all(shown.map((move) => ai.checkGesture(move.slot, move.hash, () => moveSheet(move), who)));
    const blocked = shown.filter((_, i) => verdicts[i] === 'blocked');
    if (blocked.length > 0) {
      const names = blocked.map((move) => `"${move.name}"`).join(' and ');
      return reply.code(400).send(apiError('move_blocked', `${names} can't be shown to strangers; record ${blocked.length > 1 ? 'others' : 'another'} or use the default`));
    }
    // Block until checked: in production nothing unchecked is signed. Without a Meta key (development) it is.
    if (config.env === 'production' && verdicts.includes('unchecked')) {
      return reply.code(503).send(apiError('check_unavailable', "Your taunt or victory move couldn't be checked right now; try again soon"));
    }
    return { moves: moves.map((move) => signer.sign(move)) };
  });

  app.get<{ Reply: { players: BlockedPlayer[] } | ApiError }>(`${ACCOUNT_PATH}/blocks`, async (request, reply) => {
    const ready = requireSession(request, reply);
    if (!ready) return reply;
    return { players: ready.store.blockedPlayers(ready.session.account.id) };
  });

  /** A blocked player is never matched with this account again, either way round. */
  app.post(`${ACCOUNT_PATH}/blocks`, { preHandler: sameOrigin }, async (request, reply) => {
    const ready = requireSession(request, reply);
    if (!ready) return reply;
    const player = (request.body as { player?: unknown } | undefined)?.player;
    if (typeof player !== 'string' || !ACCOUNT_ID_PATTERN.test(player)) return reply.code(400).send(apiError('bad_player', 'Name the player by their id'));
    if (!ready.store.block(ready.session.account.id, player)) return reply.code(404).send(apiError('not_found', 'No such player'));
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string } }>(`${ACCOUNT_PATH}/blocks/:id`, { preHandler: sameOrigin }, async (request, reply) => {
    const ready = requireSession(request, reply);
    if (!ready) return reply;
    if (!ready.store.unblock(ready.session.account.id, request.params.id)) return reply.code(404).send(apiError('not_found', 'That player is not blocked'));
    return reply.code(204).send();
  });

  /** Reports are stored for review; nothing happens to the player automatically. */
  app.post(`${ACCOUNT_PATH}/reports`, { preHandler: sameOrigin }, async (request, reply) => {
    const ready = requireSession(request, reply);
    if (!ready) return reply;
    const body = request.body as { player?: unknown; reason?: unknown; note?: unknown } | undefined;
    const player = body?.player;
    const reason = body?.reason;
    if (typeof player !== 'string' || !ACCOUNT_ID_PATTERN.test(player)) return reply.code(400).send(apiError('bad_player', 'Name the player by their id'));
    if (typeof reason !== 'string' || !(REPORT_REASONS as readonly string[]).includes(reason)) {
      return reply.code(400).send(apiError('bad_reason', `The reason must be one of: ${REPORT_REASONS.join(', ')}`));
    }
    let note: string | null = null;
    if (body?.note !== undefined && body.note !== null && body.note !== '') {
      note = cleanText(body.note, REPORT_NOTE_MAX_LENGTH);
      if (note === null) return reply.code(400).send(apiError('bad_note', `A note is at most ${REPORT_NOTE_MAX_LENGTH} characters`));
    }
    const reporter = ready.session.account.id;
    if (ready.store.reportsSince(reporter, now() - DAY_MS) >= REPORTS_PER_DAY) return reply.code(429).send(apiError('too_many_reports', 'Too many reports today'));
    if (!ready.store.report(reporter, player, reason as ReportReason, note)) return reply.code(404).send(apiError('not_found', 'No such player'));
    request.log.info({ reporter, reported: player, reason }, 'player reported');
    return reply.code(201).send({ reported: true });
  });

  return { prune };
}

/**
 * The account behind a sign-in cookie, for the relay: its socket's opening request carries the
 * cookie like any other request from the page. Returns the token too, to check the sign-in
 * again later (it may have ended since the socket opened).
 */
export function accountFromCookie(store: AccountStore | null, cookieHeader: string | undefined): { account: AccountInfo; token: string } | null {
  const token = readCookie(cookieHeader, COOKIE);
  const session = token && store ? store.findSession(token) : undefined;
  return session && token ? { account: session.account, token } : null;
}

function apiError(error: string, message: string): ApiError {
  return { error, message };
}

/** Reads one cookie; values that couldn't be a session token are treated as missing. */
function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return COOKIE_VALUE.test(value) ? value : null;
  }
  return null;
}

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AccountInfo, BlockedPlayer, CloudMove, CloudMoveInput, LibraryResponse, LoadoutSelection, MoveFile, ReportReason } from '@sticxcape/shared';
import type { NewCredential, StoredCredential } from './webauthn.ts';

export interface CredentialRecord extends StoredCredential {
  id: string;
  accountId: string;
  userHandle: string;
}

/** Each change to the tables gets a step here; PRAGMA user_version records how many have run. */
const MIGRATIONS = [
  `CREATE TABLE accounts (
     id TEXT PRIMARY KEY,
     user_handle TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE credentials (
     id TEXT PRIMARY KEY,
     account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     public_key BLOB NOT NULL,
     algorithm INTEGER NOT NULL,
     sign_count INTEGER NOT NULL,
     transports TEXT NOT NULL,
     backed_up INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     last_used_at INTEGER
   );
   CREATE INDEX credentials_account ON credentials(account_id);
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY,
     account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE INDEX sessions_account ON sessions(account_id);
   CREATE TABLE moves (
     account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     id TEXT NOT NULL,
     move TEXT NOT NULL,
     kind TEXT NOT NULL,
     description TEXT,
     quality REAL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (account_id, id)
   );
   CREATE TABLE loadouts (
     account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
     selection TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   );`,
  // Quick match: a hidden skill rating, blocks, reports, a record of each match, and server secrets.
  `ALTER TABLE accounts ADD COLUMN rating REAL NOT NULL DEFAULT 1000;
   ALTER TABLE accounts ADD COLUMN games INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE blocks (
     account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     blocked_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (account_id, blocked_id)
   );
   CREATE INDEX blocks_blocked ON blocks(blocked_id);
   CREATE TABLE reports (
     id INTEGER PRIMARY KEY,
     reporter_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
     reported_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
     reason TEXT NOT NULL,
     note TEXT,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX reports_reporter ON reports(reporter_id, created_at);
   CREATE TABLE quick_matches (
     id INTEGER PRIMARY KEY,
     left_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
     right_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
     winner_id TEXT,
     reason TEXT NOT NULL,
     ended_at INTEGER NOT NULL
   );
   CREATE TABLE secrets (
     name TEXT PRIMARY KEY,
     value BLOB NOT NULL
   );`,
];

/** Elo from 1000: new players' ratings move fast (K 40 for their first 10 games), then settle (K 20). */
const NEW_PLAYER_GAMES = 10;

function kFactor(games: number): number {
  return games < NEW_PLAYER_GAMES ? 40 : 20;
}

export interface Rating {
  rating: number;
  games: number;
}

/**
 * Accounts, their passkeys, sign-in sessions and cloud move libraries, in one SQLite file
 * (node:sqlite). Staging runs one machine, so the file sits on its volume. Session tokens are
 * stored only as hashes, so a copy of the file can't sign anyone in.
 */
export class AccountStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  /** `file` is a path, or ':memory:' for tests. */
  constructor(file: string, now: () => number = Date.now) {
    try {
      if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
      this.db = new DatabaseSync(file);
    } catch (err) {
      throw new Error(`Can't open the account database at ${file} (${(err as Error).message}). On Fly.io, check the volume is mounted at its folder.`);
    }
    this.now = now;
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;');
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  createAccount(name: string, userHandle: string, credential: NewCredential): AccountInfo {
    const account: AccountInfo = { id: randomBytes(12).toString('base64url'), name, createdAt: this.now() };
    this.transaction(() => {
      this.db.prepare('INSERT INTO accounts (id, user_handle, name, created_at) VALUES (?, ?, ?, ?)').run(account.id, userHandle, name, account.createdAt);
      this.db
        .prepare(
          'INSERT INTO credentials (id, account_id, public_key, algorithm, sign_count, transports, backed_up, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(credential.id, account.id, credential.publicKey, credential.algorithm, credential.signCount, JSON.stringify(credential.transports), credential.backedUp ? 1 : 0, account.createdAt);
    });
    return account;
  }

  hasCredential(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM credentials WHERE id = ?').get(id) !== undefined;
  }

  findCredential(id: string): CredentialRecord | undefined {
    const row = this.db
      .prepare('SELECT c.id, c.account_id, c.public_key, c.algorithm, c.sign_count, a.user_handle FROM credentials c JOIN accounts a ON a.id = c.account_id WHERE c.id = ?')
      .get(id) as { id: string; account_id: string; public_key: Uint8Array; algorithm: number; sign_count: number; user_handle: string } | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      accountId: row.account_id,
      userHandle: row.user_handle,
      publicKey: new Uint8Array(row.public_key),
      algorithm: row.algorithm,
      signCount: row.sign_count,
    };
  }

  recordSignIn(credentialId: string, signCount: number): void {
    this.db.prepare('UPDATE credentials SET sign_count = ?, last_used_at = ? WHERE id = ?').run(signCount, this.now(), credentialId);
  }

  getAccount(id: string): AccountInfo | undefined {
    const row = this.db.prepare('SELECT id, name, created_at FROM accounts WHERE id = ?').get(id) as { id: string; name: string; created_at: number } | undefined;
    return row ? { id: row.id, name: row.name, createdAt: row.created_at } : undefined;
  }

  /** Deletes the account with its passkeys, sessions, moves and loadout. */
  deleteAccount(id: string): void {
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  }

  get accountCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n;
  }

  // Sessions.

  /** Starts a session; returns the token for the cookie. Only its hash is kept. */
  createSession(accountId: string, ttlMs: number): string {
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    this.db.prepare('INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(hashToken(token), accountId, now, now + ttlMs);
    return token;
  }

  /** The signed-in account and when its session ends, or undefined for an unknown or expired token. */
  findSession(token: string): { account: AccountInfo; expiresAt: number } | undefined {
    const row = this.db
      .prepare('SELECT a.id, a.name, a.created_at, s.expires_at FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?')
      .get(hashToken(token)) as { id: string; name: string; created_at: number; expires_at: number } | undefined;
    if (!row || row.expires_at <= this.now()) return undefined;
    return { account: { id: row.id, name: row.name, createdAt: row.created_at }, expiresAt: row.expires_at };
  }

  extendSession(token: string, ttlMs: number): void {
    this.db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(this.now() + ttlMs, hashToken(token));
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }

  pruneSessions(): number {
    return Number(this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(this.now()).changes);
  }

  // The cloud move library.

  library(accountId: string): LibraryResponse {
    const rows = this.db
      .prepare('SELECT move, kind, description, quality, created_at, updated_at FROM moves WHERE account_id = ? ORDER BY created_at DESC, id')
      .all(accountId) as { move: string; kind: CloudMove['kind']; description: string | null; quality: number | null; created_at: number; updated_at: number }[];
    const moves = rows.map(
      (row): CloudMove => ({
        move: JSON.parse(row.move) as MoveFile,
        kind: row.kind,
        description: row.description,
        quality: row.quality,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
    );
    const loadout = this.db.prepare('SELECT selection FROM loadouts WHERE account_id = ?').get(accountId) as { selection: string } | undefined;
    return { moves, loadout: loadout ? (JSON.parse(loadout.selection) as LoadoutSelection) : {} };
  }

  /** Adds or replaces a move. Returns when it was stored, or null when the library is full. */
  saveMove(accountId: string, input: CloudMoveInput, maxMoves: number): number | null {
    const updatedAt = this.now();
    let stored = true;
    this.transaction(() => {
      const exists = this.db.prepare('SELECT 1 FROM moves WHERE account_id = ? AND id = ?').get(accountId, input.move.id) !== undefined;
      const count = (this.db.prepare('SELECT COUNT(*) AS n FROM moves WHERE account_id = ?').get(accountId) as { n: number }).n;
      if (!exists && count >= maxMoves) {
        stored = false;
        return;
      }
      this.db
        .prepare(
          `INSERT INTO moves (account_id, id, move, kind, description, quality, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (account_id, id) DO UPDATE SET move = excluded.move, kind = excluded.kind, description = excluded.description,
             quality = excluded.quality, created_at = excluded.created_at, updated_at = excluded.updated_at`,
        )
        .run(accountId, input.move.id, JSON.stringify(input.move), input.kind, input.description, input.quality, input.createdAt, updatedAt);
    });
    return stored ? updatedAt : null;
  }

  /** True when the move was there. */
  deleteMove(accountId: string, moveId: string): boolean {
    return Number(this.db.prepare('DELETE FROM moves WHERE account_id = ? AND id = ?').run(accountId, moveId).changes) > 0;
  }

  saveLoadout(accountId: string, selection: LoadoutSelection): void {
    this.db
      .prepare('INSERT INTO loadouts (account_id, selection, updated_at) VALUES (?, ?, ?) ON CONFLICT (account_id) DO UPDATE SET selection = excluded.selection, updated_at = excluded.updated_at')
      .run(accountId, JSON.stringify(selection), this.now());
  }

  // Quick match.

  rating(accountId: string): Rating | undefined {
    return this.db.prepare('SELECT rating, games FROM accounts WHERE id = ?').get(accountId) as Rating | undefined;
  }

  /**
   * Records a finished quick match and moves both ratings (Elo). `winnerId` is null for a draw.
   * Returns the new ratings, left then right, or null when an account no longer exists.
   */
  recordQuickMatch(leftId: string, rightId: string, winnerId: string | null, reason: string): [Rating, Rating] | null {
    let result: [Rating, Rating] | null = null;
    this.transaction(() => {
      this.db
        .prepare('INSERT INTO quick_matches (left_id, right_id, winner_id, reason, ended_at) VALUES (?, ?, ?, ?, ?)')
        .run(leftId, rightId, winnerId, reason, this.now());
      const left = this.rating(leftId);
      const right = this.rating(rightId);
      if (!left || !right) return;
      const score = winnerId === leftId ? 1 : winnerId === rightId ? 0 : 0.5;
      const expected = 1 / (1 + 10 ** ((right.rating - left.rating) / 400));
      const next: [Rating, Rating] = [
        { rating: left.rating + kFactor(left.games) * (score - expected), games: left.games + 1 },
        { rating: right.rating + kFactor(right.games) * (expected - score), games: right.games + 1 },
      ];
      const update = this.db.prepare('UPDATE accounts SET rating = ?, games = ? WHERE id = ?');
      update.run(next[0].rating, next[0].games, leftId);
      update.run(next[1].rating, next[1].games, rightId);
      result = next;
    });
    return result;
  }

  /** False when the player doesn't exist or is the account itself. */
  block(accountId: string, blockedId: string): boolean {
    if (accountId === blockedId || !this.getAccount(blockedId)) return false;
    this.db.prepare('INSERT OR IGNORE INTO blocks (account_id, blocked_id, created_at) VALUES (?, ?, ?)').run(accountId, blockedId, this.now());
    return true;
  }

  unblock(accountId: string, blockedId: string): boolean {
    return Number(this.db.prepare('DELETE FROM blocks WHERE account_id = ? AND blocked_id = ?').run(accountId, blockedId).changes) > 0;
  }

  blockedPlayers(accountId: string): BlockedPlayer[] {
    const rows = this.db
      .prepare('SELECT a.id, a.name, b.created_at FROM blocks b JOIN accounts a ON a.id = b.blocked_id WHERE b.account_id = ? ORDER BY b.created_at DESC')
      .all(accountId) as { id: string; name: string; created_at: number }[];
    return rows.map((row) => ({ id: row.id, name: row.name, blockedAt: row.created_at }));
  }

  /** Everyone this account blocked or was blocked by: quick match never pairs them. */
  blockedEitherWay(accountId: string): Set<string> {
    const rows = this.db
      .prepare('SELECT blocked_id AS id FROM blocks WHERE account_id = ? UNION SELECT account_id AS id FROM blocks WHERE blocked_id = ?')
      .all(accountId, accountId) as { id: string }[];
    return new Set(rows.map((row) => row.id));
  }

  /** False when the reported player doesn't exist. */
  report(reporterId: string, reportedId: string, reason: ReportReason, note: string | null): boolean {
    if (reporterId === reportedId || !this.getAccount(reportedId)) return false;
    this.db.prepare('INSERT INTO reports (reporter_id, reported_id, reason, note, created_at) VALUES (?, ?, ?, ?, ?)').run(reporterId, reportedId, reason, note, this.now());
    return true;
  }

  reportsSince(reporterId: string, since: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ? AND created_at >= ?').get(reporterId, since) as { n: number }).n;
  }

  /** A server secret, made on first use and kept with the accounts (the move signing key). */
  secret(name: string, bytes = 32): Uint8Array {
    const row = this.db.prepare('SELECT value FROM secrets WHERE name = ?').get(name) as { value: Uint8Array } | undefined;
    if (row) return new Uint8Array(row.value);
    const value = new Uint8Array(randomBytes(bytes));
    this.db.prepare('INSERT OR IGNORE INTO secrets (name, value) VALUES (?, ?)').run(name, value);
    return this.secret(name, bytes);
  }

  private migrate(): void {
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > MIGRATIONS.length) throw new Error(`The account database is from a newer server (version ${version})`);
    for (let step = version; step < MIGRATIONS.length; step++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[step]!);
        this.db.exec(`PRAGMA user_version = ${step + 1}`);
      });
    }
  }

  private transaction(work: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      work();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

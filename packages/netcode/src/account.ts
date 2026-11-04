import {
  ACCOUNT_PATH,
  decodeBase64Url,
  encodeBase64Url,
  type AccountInfo,
  type AccountResponse,
  type BlockedPlayer,
  type CloudMoveInput,
  type LibraryResponse,
  type LoadoutSelection,
  type MoveFile,
  type ReportReason,
  type SignMovesResponse,
  type PasskeyAssertion,
  type PasskeyCeremony,
  type PasskeyCreationOptions,
  type PasskeyRegistration,
  type PasskeyRequestOptions,
  type SaveMoveResponse,
} from '@sticxcape/shared';
import { requestJson, type ServicesOptions } from './services.ts';

/** Makes and uses passkeys: the browser's own by default, a software one in tests. */
export interface PasskeyAuthenticator {
  create(options: PasskeyCreationOptions): Promise<PasskeyRegistration>;
  get(options: PasskeyRequestOptions): Promise<PasskeyAssertion>;
}

/** True when this page can use passkeys: WebAuthn in a secure context (HTTPS, or localhost). */
export function passkeysSupported(): boolean {
  return globalThis.isSecureContext === true && typeof globalThis.PublicKeyCredential === 'function';
}

type Credentials = Pick<CredentialsContainer, 'create' | 'get'>;

/**
 * The browser's passkeys through navigator.credentials, turning the server's JSON options into
 * WebAuthn's binary ones and the answers back into JSON. If the player cancels the prompt, the
 * promise rejects with the browser's NotAllowedError.
 */
export function browserPasskeys(container: Credentials | undefined = globalThis.navigator?.credentials): PasskeyAuthenticator {
  const credentials = (): Credentials => {
    if (!container) throw new Error('Passkeys are not available in this browser');
    return container;
  };
  return {
    async create(options) {
      const credential = (await credentials().create({
        publicKey: {
          challenge: bytes(options.challenge),
          rp: options.rp,
          user: { id: bytes(options.user.id), name: options.user.name, displayName: options.user.displayName },
          pubKeyCredParams: options.pubKeyCredParams,
          timeout: options.timeout,
          attestation: options.attestation,
          authenticatorSelection: options.authenticatorSelection,
          excludeCredentials: options.excludeCredentials.map((c) => ({ type: c.type, id: bytes(c.id) })),
        },
      })) as PublicKeyCredential | null;
      if (!credential) throw new Error('No passkey was made');
      const response = credential.response as AuthenticatorAttestationResponse;
      const registration: PasskeyRegistration = {
        id: credential.id,
        type: 'public-key',
        response: { clientDataJSON: text(response.clientDataJSON), attestationObject: text(response.attestationObject) },
      };
      const transports = typeof response.getTransports === 'function' ? response.getTransports() : [];
      if (transports.length > 0) registration.response.transports = transports;
      return registration;
    },

    async get(options) {
      const credential = (await credentials().get({
        publicKey: {
          challenge: bytes(options.challenge),
          rpId: options.rpId,
          timeout: options.timeout,
          userVerification: options.userVerification,
          allowCredentials: options.allowCredentials.map((c) => ({ type: c.type, id: bytes(c.id) })),
        },
      })) as PublicKeyCredential | null;
      if (!credential) throw new Error('No passkey was chosen');
      const response = credential.response as AuthenticatorAssertionResponse;
      return {
        id: credential.id,
        type: 'public-key',
        response: {
          clientDataJSON: text(response.clientDataJSON),
          authenticatorData: text(response.authenticatorData),
          signature: text(response.signature),
          userHandle: response.userHandle ? text(response.userHandle) : null,
        },
      };
    },
  };
}

export interface AccountClientOptions extends ServicesOptions {
  /** Defaults to the browser's passkeys. */
  passkeys?: PasskeyAuthenticator;
}

/**
 * Accounts and the cloud move library (launch, MP-9). Players make an account with a passkey
 * (Face ID, a fingerprint or the phone's PIN) and sign in with it on any device their passkeys
 * sync to. The sign-in is a cookie, so the page must call the services on its own origin.
 */
export class AccountClient {
  readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  private readonly passkeys: PasskeyAuthenticator;

  constructor(options: AccountClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? globalThis.location?.origin ?? '').replace(/\/+$/, '');
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.passkeys = options.passkeys ?? browserPasskeys();
  }

  /** Who is signed in on this browser, and whether the server can use passkeys here. */
  status(): Promise<AccountResponse> {
    return this.request('GET', '');
  }

  /** Makes a passkey and an account named `name` (the nickname), and signs in. */
  async createAccount(name: string): Promise<AccountInfo> {
    const { ceremony, options } = await this.request<PasskeyCeremony<PasskeyCreationOptions>>('POST', '/passkey/register/options', { name });
    const credential = await this.passkeys.create(options);
    return (await this.request<{ account: AccountInfo }>('POST', '/passkey/register', { ceremony, credential })).account;
  }

  /** Signs in with a passkey the phone already has; it offers the ones made for this game. */
  async signIn(): Promise<AccountInfo> {
    const { ceremony, options } = await this.request<PasskeyCeremony<PasskeyRequestOptions>>('POST', '/passkey/login/options', {});
    const credential = await this.passkeys.get(options);
    return (await this.request<{ account: AccountInfo }>('POST', '/passkey/login', { ceremony, credential })).account;
  }

  async signOut(): Promise<void> {
    await this.request('POST', '/logout');
  }

  /** Deletes the account and its cloud library. The passkey stays on the phone until removed in its settings. */
  async deleteAccount(): Promise<void> {
    await this.request('DELETE', '');
  }

  getLibrary(): Promise<LibraryResponse> {
    return this.request('GET', '/library');
  }

  /** Adds or replaces a move; returns when the server stored it. */
  async saveMove(input: CloudMoveInput): Promise<number> {
    return (await this.request<SaveMoveResponse>('PUT', `/library/moves/${encodeURIComponent(input.move.id)}`, input)).updatedAt;
  }

  async deleteMove(id: string): Promise<void> {
    await this.request('DELETE', `/library/moves/${encodeURIComponent(id)}`);
  }

  async saveLoadout(loadout: LoadoutSelection): Promise<void> {
    await this.request('PUT', '/library/loadout', { loadout });
  }

  /**
   * Has the server check and sign moves (MP-8). Quick match takes only signed moves, so sign the
   * full loadout, default moves included, before searching; any later edit needs a new signature.
   */
  async signMoves(moves: MoveFile[]): Promise<MoveFile[]> {
    return (await this.request<SignMovesResponse>('POST', '/moves/sign', { moves })).moves;
  }

  /** Never be matched with this player again (their id comes from the quick match). */
  async blockPlayer(id: string): Promise<void> {
    await this.request('POST', '/blocks', { player: id });
  }

  async unblockPlayer(id: string): Promise<void> {
    await this.request('DELETE', `/blocks/${encodeURIComponent(id)}`);
  }

  async blockedPlayers(): Promise<BlockedPlayer[]> {
    return (await this.request<{ players: BlockedPlayer[] }>('GET', '/blocks')).players;
  }

  /** Reports a player for review. A note is optional, up to 300 characters. */
  async reportPlayer(id: string, reason: ReportReason, note?: string): Promise<void> {
    await this.request('POST', '/reports', note ? { player: id, reason, note } : { player: id, reason });
  }

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return requestJson<T>(this.fetch, method, `${this.baseUrl}${ACCOUNT_PATH}${path}`, body);
  }
}

function bytes(value: string): Uint8Array<ArrayBuffer> {
  const decoded = decodeBase64Url(value);
  if (!decoded) throw new Error('The server sent a malformed passkey option');
  return new Uint8Array(decoded);
}

function text(buffer: ArrayBuffer): string {
  return encodeBase64Url(new Uint8Array(buffer));
}

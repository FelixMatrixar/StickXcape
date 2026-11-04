export { connectWebSocket, type ConnectOptions, type Latency, type RelayTransport } from './transport.ts';
export { RelayClient, RelayError, type JoinResult, type RelayClientEvents, type RelayClientOptions } from './relay-client.ts';
// LockstepSession is the session's name from before rollback; the game's existing code still uses it.
export {
  MatchSession,
  MatchSession as LockstepSession,
  type MatchSessionOptions,
  type MatchSessionOptions as LockstepOptions,
} from './session.ts';
export { LockstepDriver, type DriverHooks } from './driver.ts';
export { RollbackDriver, type RollbackHooks, type RollbackStats } from './rollback-driver.ts';
export { createFakeRelay, type FakeRelayOptions } from './fake-relay.ts';
export {
  AI_TIMEOUT_MS,
  ApiRequestError,
  CannedAiService,
  HttpAiService,
  playerId,
  ServicesClient,
  type AiService,
  type MoveNameSuggestion,
  type ServicesOptions,
} from './services.ts';
export { AccountClient, browserPasskeys, passkeysSupported, type AccountClientOptions, type PasskeyAuthenticator } from './account.ts';
export { ToySim, type ToySnapshot } from './toy-sim.ts';
export { ToyMatch, toyBotInput, toyLoadout, type ToyMatchOptions } from './toy-match.ts';

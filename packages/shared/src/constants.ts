/** The simulation runs at a fixed 60 Hz; a frame is 1/60 s. */
export const FPS = 60;
export const FRAME_MS = 1000 / FPS;

/**
 * Sent as `clientVersion` on join. Bump it whenever a change to the messages or file
 * formats breaks older clients; the server then tells older phones to reload (GET /version).
 */
export const CLIENT_VERSION = 1;

export const MOVE_FORMAT_VERSION = 1;
export const ARENA_FORMAT_VERSION = 1;

/** Rooms hold at most 8 players: two fight, the rest wait their turn (winner stays on). */
export const MAX_ROOM_PLAYERS = 8;

export const NICKNAME_MAX_LENGTH = 16;

/** Phones send a state hash every 60 frames (once a second); a mismatch ends the match as a desync. */
export const HASH_INTERVAL_FRAMES = 60;

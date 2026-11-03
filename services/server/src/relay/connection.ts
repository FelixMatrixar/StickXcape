import { WebSocket } from 'ws';
import type { ErrorCode, ServerMessage } from '@sticxcape/shared';
import type { TokenBucket } from '../lib/limits.ts';
import type { Hub } from './hub.ts';

const RTT_SAMPLES = 5;
/** A phone whose socket backs up past this is cut off rather than buffered without limit. */
const MAX_BUFFERED_BYTES = 1024 * 1024;

/** One phone's WebSocket to the relay. */
export class Connection {
  readonly ws: WebSocket;
  readonly ip: string;
  readonly bucket: TokenBucket;
  hub: Hub | null = null;
  player: number | null = null;
  nickname: string | null = null;
  lastSeen: number;
  /** Messages dropped by the rate cap since the last relay tick. */
  rateDrops = 0;
  malformed = 0;
  private readonly rtts: number[] = [];

  constructor(ws: WebSocket, ip: string, bucket: TokenBucket, now: number) {
    this.ws = ws;
    this.ip = ip;
    this.bucket = bucket;
    this.lastSeen = now;
  }

  send(message: ServerMessage): void {
    this.sendText(JSON.stringify(message));
  }

  sendText(text: string): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.ws.terminate();
      return;
    }
    this.ws.send(text);
  }

  sendError(code: ErrorCode, message: string): void {
    this.send({ type: 'error', code, message });
  }

  close(code: number, reason: string): void {
    this.ws.close(code, reason);
  }

  addRtt(ms: number): void {
    this.rtts.push(ms);
    if (this.rtts.length > RTT_SAMPLES) this.rtts.shift();
  }

  /** Median of the latest round trips to the relay, or null before the first pong. */
  rtt(): number | null {
    if (this.rtts.length === 0) return null;
    const sorted = [...this.rtts].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  }
}

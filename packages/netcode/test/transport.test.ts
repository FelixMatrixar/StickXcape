import { describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@sticxcape/shared';
import { connectWebSocket } from '../src/transport.ts';

/** Just enough of a browser WebSocket for connectWebSocket. */
class FakeSocket {
  static readonly OPEN = 1;
  static last: FakeSocket | null = null;
  readyState = FakeSocket.OPEN;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    FakeSocket.last = this;
    setTimeout(() => this.onopen?.());
  }

  send(text: string): void {
    this.sent.push(text);
  }

  close(): void {}
}

describe('connectWebSocket with simulated latency', () => {
  it('delays messages both ways but never reorders them', async () => {
    const random = () => Math.random() * 25;
    const transport = await connectWebSocket('ws://relay.test/ws', {
      WebSocket: FakeSocket as unknown as typeof WebSocket,
      latency: { sendMs: random, receiveMs: random },
    });
    const socket = FakeSocket.last!;
    const received: number[] = [];
    transport.onMessage((message) => received.push((message as Extract<ServerMessage, { type: 'input' }>).frame));

    for (let frame = 0; frame < 300; frame++) {
      transport.send({ type: 'input', frame, buttons: 0 });
      socket.onmessage!({ data: JSON.stringify({ type: 'input', frame, buttons: 0 }) });
    }
    expect(socket.sent).toHaveLength(0);

    const inOrder = Array.from({ length: 300 }, (_, i) => i);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(300), { timeout: 2000 });
    expect(socket.sent.map((text) => (JSON.parse(text) as { frame: number }).frame)).toEqual(inOrder);
    await vi.waitFor(() => expect(received).toHaveLength(300), { timeout: 2000 });
    expect(received).toEqual(inOrder);
  });
});

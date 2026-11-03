import { parseServerMessage, type ClientMessage, type ServerMessage } from '@sticxcape/shared';

/** How the netcode reaches a relay: the real one over a WebSocket, or the fake one inside the page. */
export interface RelayTransport {
  send(message: ClientMessage): void;
  /** Sets the handler for messages from the relay. Messages that arrive before it is set are kept. */
  onMessage(handler: (message: ServerMessage) => void): void;
  onClose(handler: (reason: string) => void): void;
  close(): void;
}

/** Simulated network delay, for testing bad networks. Order is always kept, as on a real socket. */
export interface Latency {
  sendMs: () => number;
  receiveMs: () => number;
}

export interface ConnectOptions {
  /** Defaults to the global WebSocket (browsers, and Node 22 or later). */
  WebSocket?: typeof WebSocket;
  latency?: Latency;
}

/** Opens a WebSocket to the relay, such as wss://play.example.com/ws, and resolves once it is open. */
export function connectWebSocket(url: string, options: ConnectOptions = {}): Promise<RelayTransport> {
  const Socket = options.WebSocket ?? globalThis.WebSocket;
  const sendQueue = options.latency ? new DelayQueue() : null;
  const receiveQueue = options.latency ? new DelayQueue() : null;

  return new Promise((resolve, reject) => {
    const ws = new Socket(url);
    const early: ServerMessage[] = [];
    let messageHandler: ((message: ServerMessage) => void) | null = null;
    let closeHandler: (reason: string) => void = () => {};

    const deliver = (message: ServerMessage) => {
      if (messageHandler) messageHandler(message);
      else early.push(message);
    };

    const transport: RelayTransport = {
      send(message) {
        const text = JSON.stringify(message);
        const write = () => {
          if (ws.readyState === Socket.OPEN) ws.send(text);
        };
        if (sendQueue && options.latency) sendQueue.push(write, options.latency.sendMs());
        else write();
      },
      onMessage(handler) {
        messageHandler = handler;
        for (const message of early.splice(0)) handler(message);
      },
      onClose(handler) {
        closeHandler = handler;
      },
      close() {
        ws.close(1000, 'bye');
      },
    };

    ws.onopen = () => resolve(transport);
    ws.onerror = () => reject(new Error(`Could not connect to ${url}`));
    ws.onclose = (event) => closeHandler(event.reason || `closed (${event.code})`);
    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      const message = parseServerMessage(event.data);
      if (!message) return;
      if (receiveQueue && options.latency) receiveQueue.push(() => deliver(message), options.latency.receiveMs());
      else deliver(message);
    };
  });
}

/** Runs callbacks after a delay without ever reordering them. */
class DelayQueue {
  private lastAt = 0;

  push(callback: () => void, delayMs: number): void {
    const at = Math.max(this.lastAt, performance.now() + Math.max(0, delayMs));
    this.lastAt = at;
    setTimeout(callback, at - performance.now());
  }
}

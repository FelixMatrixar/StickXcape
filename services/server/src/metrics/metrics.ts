import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { EndReason } from '@sticxcape/shared';
import { RollingSamples } from '../lib/limits.ts';
import { Registry } from './registry.ts';

export type AiCall = 'move_name' | 'match_tips';

/** Outcomes of an AI gateway request. `error_*` outcomes count toward the AI error alert. */
export type AiOutcome =
  | 'ok'
  | 'cache_hit'
  | 'canned'
  | 'rate_limited'
  | 'error_timeout'
  | 'error_rate_limited'
  | 'error_upstream'
  | 'error_network'
  | 'error_bad_request'
  | 'error_invalid_response';

export type Metrics = ReturnType<typeof createMetrics>;

/** Every metric the services record (Backend PRD: metrics and monitoring). */
export function createMetrics() {
  const registry = new Registry();
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();
  // The event-loop delay percentile covers the last minute, so a busy relay shows up quickly.
  const loopReset = setInterval(() => loopDelay.reset(), 60_000);
  loopReset.unref();

  registry.gauge('process_resident_memory_bytes', 'Resident memory size in bytes', () => process.memoryUsage().rss);
  registry.gauge('process_uptime_seconds', 'Seconds since the server started', () => process.uptime());
  registry.gauge('nodejs_eventloop_delay_p99_seconds', 'Event-loop delay, 99th percentile over the last minute', () =>
    loopDelay.count > 0 ? loopDelay.percentile(99) / 1e9 : 0,
  );

  return {
    registry,
    roomsCreated: registry.counter('sticxcape_rooms_created_total', 'Rooms created'),
    matchesStarted: registry.counter('sticxcape_matches_started_total', 'Matches started'),
    matchesEnded: registry.counter<'reason'>('sticxcape_matches_ended_total', 'Matches ended, by reason (finished, desync, disconnect, room_closed)', [
      'reason',
    ]),
    relayDropped: registry.counter<'reason'>('sticxcape_relay_dropped_messages_total', 'Messages the relay dropped, by reason', ['reason']),
    relayRtt: registry.histogram('sticxcape_relay_rtt_seconds', 'Round trip between a phone and the relay', [
      0.01, 0.02, 0.04, 0.06, 0.08, 0.1, 0.15, 0.2, 0.3, 0.5, 1,
    ]),
    relayForward: registry.histogram('sticxcape_relay_forward_seconds', 'Time the relay holds an input before passing it on (sampled)', [
      0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025,
    ]),
    aiRequests: registry.counter<'call' | 'outcome'>('sticxcape_ai_requests_total', 'AI gateway requests, by call and outcome', ['call', 'outcome']),
    aiLatency: registry.histogram<'call'>('sticxcape_ai_response_seconds', "Meta Model API response time, successes and failures", [
      0.25, 0.5, 1, 1.5, 2, 3, 4, 5, 7.5,
    ], ['call']),
    /** Recent samples for the dashboard's percentiles. */
    samples: {
      rttMs: new RollingSamples(1000),
      forwardMs: new RollingSamples(1000),
      aiMs: { move_name: new RollingSamples(500), match_tips: new RollingSamples(500) } satisfies Record<AiCall, RollingSamples>,
    },
    close(): void {
      clearInterval(loopReset);
      loopDelay.disable();
    },
  };
}

export const END_REASON_LABELS: readonly EndReason[] = ['finished', 'desync', 'disconnect', 'room_closed'];

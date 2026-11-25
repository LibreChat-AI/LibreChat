import type { JsonValue } from '../json';

/** Optional source-declared proof the generation is expected to produce. The
 * host evaluates this against completed tool evidence; it never trusts a model
 * assertion that work happened. */
export interface AgentTriggerExpectedAction {
  toolName: string;
  argumentSubset?: Record<string, JsonValue>;
}

/** Minimal job-store projection of the canonical Conversation suspension.
 * The signed suspension stays private in Mongo; this marker only routes a
 * paused job through the durable resume protocol during rolling deploys. */
export interface AgentEventSuspensionProjection {
  version: 1;
  suspensionId: string;
  attempt: number;
}

/** Durable host evidence for the exact external action an Event Actor applied. */
export interface AgentEventAppliedAction {
  toolName: string;
  toolCallId?: string;
}

/** Job-store outbox record for terminal detached-action evidence that has not
 * necessarily reached the authoritative delivery row yet. */
export interface AgentEventDetachedTerminalEvidence {
  version: 1;
  deliveryKey: string;
  generationCreatedAt: number;
  taskId: string;
  idempotencyKey: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  result?: string;
  error?: string;
  observedAt: number;
}

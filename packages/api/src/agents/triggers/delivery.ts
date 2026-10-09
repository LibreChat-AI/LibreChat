import { createHash } from 'node:crypto';
import type { AgentTriggerEnvelope } from './envelope';
import { getAgentTriggerIdempotencyKey, parseAgentTriggerEnvelope } from './envelope';

export const MAX_AGENT_TRIGGER_ENVELOPE_BYTES: number = 1024 * 1024;
export const AGENT_TRIGGER_COALESCE_WINDOW_MS = 750;
export const MAX_AGENT_TRIGGER_BATCH_SIZE = 8;
export const MAX_AGENT_TRIGGER_BATCH_BYTES: number = 512 * 1024;

export interface AgentTriggerCoalesceOptions {
  /** Source-defined compatibility class. The host additionally scopes this to
   *  the authenticated binding, source, principal, and ordering lane. */
  key: string;
}

export interface AgentTriggerEnqueueOptions {
  /** Trusted lane override. Matching lanes dispatch strictly in enqueue order. */
  orderingKey?: string;
  /** Delays first eligibility without changing source occurrence time. */
  availableAt?: Date;
  /** Opt-in only for observational bound-child continuations. Actionable,
   *  fenced, approval, HITL, and control deliveries must remain individual. */
  coalesce?: AgentTriggerCoalesceOptions;
  /** Server-owned capability fence. Deliveries carrying this marker remain
   * invisible to older workers during a rolling deployment. */
  requiredWorkerCapability?: string;
  /** Private liveness lease for process-owned work behind a capability fence. */
  producerLeaseUntil?: Date;
}

export interface PreparedAgentTriggerDelivery {
  deliveryKey: string;
  fingerprint: string;
  orderingKey: string;
  envelope: AgentTriggerEnvelope;
  user: string;
  tenantId?: string;
  availableAt: Date;
  envelopeBytes: number;
  coalesceKey?: string;
  coalesceFrom?: Date;
  coalesceUntil?: Date;
  /** Persisted rollout marker: keep this bound actor lane queued until the
   *  admitted child turn records an authoritative terminal outcome. */
  awaitTerminalHandling?: boolean;
  requiredWorkerCapability?: string;
  producerLeaseUntil?: Date;
}

export class AgentTriggerDeliveryError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'AgentTriggerDeliveryError';
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function requireAvailableAt(value: Date | undefined): Date {
  const availableAt = value ?? new Date();
  if (!(availableAt instanceof Date) || !Number.isFinite(availableAt.getTime())) {
    throw new AgentTriggerDeliveryError('availableAt must be a valid Date');
  }
  return new Date(availableAt);
}

function optionalDate(value: Date | undefined, field: string): Date | undefined {
  if (value == null) {
    return;
  }
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new AgentTriggerDeliveryError(`${field} must be a valid Date`);
  }
  return new Date(value);
}

function coalescingIdentity(
  envelope: AgentTriggerEnvelope,
  options: AgentTriggerCoalesceOptions | undefined,
): string | undefined {
  if (options == null) {
    return undefined;
  }
  const key = options.key.trim();
  if (key.length === 0 || key.length > 128) {
    throw new AgentTriggerDeliveryError('coalesce.key must contain between 1 and 128 characters');
  }
  if (
    envelope.mode !== 'continue' ||
    envelope.target.bindingId == null ||
    envelope.target.sourceKeyId == null
  ) {
    throw new AgentTriggerDeliveryError(
      'Coalescing is supported only for authenticated bound-child continue events',
    );
  }
  return `trigger_batch_${digest([
    envelope.principal.tenantId ?? '',
    envelope.principal.userId,
    envelope.event.source.type,
    envelope.event.source.id,
    envelope.target.agentId,
    envelope.target.conversationId,
    envelope.target.bindingId,
    envelope.target.sourceKeyId,
    key,
  ])}`;
}

function orderingIdentity(
  envelope: AgentTriggerEnvelope,
  configuredKey: string | undefined,
): string {
  let lane: unknown;
  if (configuredKey != null) {
    const trimmed = configuredKey.trim();
    if (trimmed.length === 0 || trimmed.length > 256) {
      throw new AgentTriggerDeliveryError('orderingKey must contain between 1 and 256 characters');
    }
    lane = ['explicit', trimmed];
  } else {
    lane = [
      'default',
      envelope.event.source.type,
      envelope.event.source.id,
      envelope.mode,
      envelope.target.agentId,
      envelope.mode === 'fire' ? '' : envelope.target.conversationId,
    ];
  }
  return `trigger_lane_${digest([
    envelope.principal.tenantId ?? '',
    envelope.principal.userId,
    lane,
  ])}`;
}

/** Validates, bounds, detaches, and fingerprints one durable source delivery. */
export function prepareAgentTriggerDelivery(
  value: unknown,
  options: AgentTriggerEnqueueOptions = {},
): PreparedAgentTriggerDelivery {
  const envelope = parseAgentTriggerEnvelope(value);
  const serialized = canonicalJson(envelope);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > MAX_AGENT_TRIGGER_ENVELOPE_BYTES) {
    throw new AgentTriggerDeliveryError(
      `Agent trigger envelope exceeds ${MAX_AGENT_TRIGGER_ENVELOPE_BYTES} bytes`,
    );
  }

  // requestId and receivedAt identify an ingress attempt, not the logical
  // source-event-to-target delivery. Excluding them lets a retried ingress use
  // a fresh request trace without weakening content-conflict detection.
  const { requestId: _requestId, receivedAt: _receivedAt, ...durableIdentity } = envelope;
  const requestedAvailableAt = requireAvailableAt(options.availableAt);
  const producerLeaseUntil = optionalDate(options.producerLeaseUntil, 'producerLeaseUntil');
  if (producerLeaseUntil != null && options.requiredWorkerCapability == null) {
    throw new AgentTriggerDeliveryError('producerLeaseUntil requires a capability-fenced delivery');
  }
  if (
    envelope.expectedAction != null &&
    (envelope.mode !== 'continue' ||
      envelope.target.bindingId == null ||
      envelope.target.sourceKeyId == null)
  ) {
    throw new AgentTriggerDeliveryError(
      'Expected actions require an authenticated bound-child continue event',
    );
  }
  const coalesceKey = coalescingIdentity(envelope, options.coalesce);
  if (coalesceKey != null && envelope.expectedAction != null) {
    throw new AgentTriggerDeliveryError('Expected actions cannot be coalesced');
  }
  if (coalesceKey != null && bytes > MAX_AGENT_TRIGGER_BATCH_BYTES) {
    throw new AgentTriggerDeliveryError(
      `Coalesced agent trigger envelope exceeds ${MAX_AGENT_TRIGGER_BATCH_BYTES} bytes`,
    );
  }
  const coalesceUntil =
    coalesceKey == null
      ? undefined
      : new Date(requestedAvailableAt.getTime() + AGENT_TRIGGER_COALESCE_WINDOW_MS);
  return {
    deliveryKey: getAgentTriggerIdempotencyKey(envelope),
    fingerprint: digest(durableIdentity),
    orderingKey: orderingIdentity(envelope, options.orderingKey),
    envelope,
    user: envelope.principal.userId,
    ...(envelope.principal.tenantId != null && { tenantId: envelope.principal.tenantId }),
    availableAt: coalesceUntil ?? requestedAvailableAt,
    envelopeBytes: bytes,
    ...(options.requiredWorkerCapability == null
      ? {}
      : { requiredWorkerCapability: options.requiredWorkerCapability }),
    ...(producerLeaseUntil == null ? {} : { producerLeaseUntil }),
    ...(coalesceKey != null &&
      coalesceUntil != null && {
        coalesceKey,
        coalesceFrom: requestedAvailableAt,
        coalesceUntil,
      }),
  };
}

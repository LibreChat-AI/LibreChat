import { createHash } from 'node:crypto';
import type { AgentRunPrincipal, AgentRunPrincipalInput } from '../envelope';
import type { AgentTriggerExpectedAction } from './types';
import type { JsonValue } from '../json';
import { cloneJsonValue } from '../json';

export type { AgentTriggerExpectedAction } from './types';

export const AGENT_TRIGGER_ENVELOPE_VERSION = 1 as const;
export const AGENT_TRIGGER_IDEMPOTENCY_PREFIX = 'trigger_';
const MAX_EXPECTED_ACTION_TOOL_NAME_LENGTH = 256;

export type AgentTriggerMode = 'continue' | 'fire' | 'steer';

export interface AgentTriggerSource {
  /** Stable identity of the configured source, such as a webhook or schedule id. */
  id: string;
  /** Source adapter kind. Core dispatch does not interpret this value. */
  type: string;
}

export interface AgentTriggerEvent {
  /** Stable identity assigned by the source for this event occurrence. */
  id: string;
  type: string;
  /** Unix time in milliseconds recorded by the source. */
  occurredAt: number;
  /** Sanitized source data; adapters must omit credentials and transport secrets. */
  payload?: JsonValue;
  source: AgentTriggerSource;
}

interface AgentTriggerTarget {
  agentId: string;
}

/**
 * Trusted host controls for a new fire. These values shape LibreChat's own
 * generation request; they are never sourced directly from model output.
 * `metadata` is opaque to the trigger core and lets an authenticated adapter
 * identify its delivery to host-side lifecycle hooks without widening the
 * public chat request surface.
 */
export interface AgentFireRunContext {
  conversationId?: string;
  timezone?: string;
  /** Chat project the new conversation is filed under. Host-controlled like the
   *  rest of this context — never sourced from the event payload. */
  chatProjectId?: string;
  files?: JsonValue[];
  metadata?: JsonValue;
}

/**
 * One fire delivery represents one new conversation for this agent; retries
 * reuse the delivery id instead of starting another conversation.
 */
export type AgentFireTarget = AgentTriggerTarget;

export interface AgentContinueTarget extends AgentTriggerTarget {
  /** Existing conversation that receives a new host-authored turn. */
  conversationId: string;
  /** Persisted branch leaf below which the new turn is appended. */
  parentMessageId: string;
  /** Present only after an authenticated source binding resolved the target. */
  bindingId?: string;
  /** API-key identity captured by the ingress adapter and rechecked at dispatch. */
  sourceKeyId?: string;
}

export interface AgentSteerTarget extends AgentTriggerTarget {
  /** Existing conversation whose active generation receives the input. */
  conversationId: string;
  /** Fences delivery to the generation observed by the event adapter. */
  generationCreatedAt: number;
  /** Request an interrupt when supported; otherwise delivery stays queued. */
  preempt?: boolean;
}

interface AgentTriggerEnvelopeBase {
  version: typeof AGENT_TRIGGER_ENVELOPE_VERSION;
  requestId: string;
  /** Stable across retries of one source-event-to-target delivery. */
  deliveryId: string;
  /** Unix time in milliseconds recorded by the receiving host. */
  receivedAt: number;
  principal: AgentRunPrincipal;
  event: AgentTriggerEvent;
  /** Host-rendered agent input; source payload remains available in `event.payload`. */
  input: string;
  expectedAction?: AgentTriggerExpectedAction;
}

export interface AgentFireTriggerEnvelope extends AgentTriggerEnvelopeBase {
  mode: 'fire';
  target: AgentFireTarget;
  run?: AgentFireRunContext;
}

export interface AgentContinueTriggerEnvelope extends AgentTriggerEnvelopeBase {
  mode: 'continue';
  target: AgentContinueTarget;
}

export interface AgentSteerTriggerEnvelope extends AgentTriggerEnvelopeBase {
  mode: 'steer';
  target: AgentSteerTarget;
}

export type AgentTriggerEnvelope =
  | AgentContinueTriggerEnvelope
  | AgentFireTriggerEnvelope
  | AgentSteerTriggerEnvelope;

interface CreateAgentTriggerEnvelopeBase {
  requestId: string;
  deliveryId: string;
  receivedAt: number;
  principal: AgentRunPrincipalInput | null | undefined;
  event: AgentTriggerEvent;
  input: string;
  expectedAction?: AgentTriggerExpectedAction;
}

export type CreateAgentTriggerEnvelopeInput =
  | (CreateAgentTriggerEnvelopeBase & {
      mode: 'fire';
      target: AgentFireTarget;
      run?: AgentFireRunContext;
    })
  | (CreateAgentTriggerEnvelopeBase & {
      mode: 'continue';
      target: AgentContinueTarget;
    })
  | (CreateAgentTriggerEnvelopeBase & {
      mode: 'steer';
      target: AgentSteerTarget;
    });

export class AgentTriggerEnvelopeError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'AgentTriggerEnvelopeError';
  }
}

function error(message: string): AgentTriggerEnvelopeError {
  return new AgentTriggerEnvelopeError(message);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw error(`${path} must be a non-empty string`);
  }
  return value;
}

function requireTimestamp(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw error(`${path} must be a non-negative integer timestamp`);
  }
  return value;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function createPrincipal(input: AgentRunPrincipalInput | null | undefined): AgentRunPrincipal {
  const principal: AgentRunPrincipal = {
    userId: requireString(input?.id, 'principal.id'),
  };
  if (input?.role != null) {
    principal.role = requireString(input.role, 'principal.role');
  }
  if (input?.tenantId != null) {
    principal.tenantId = requireString(input.tenantId, 'principal.tenantId');
  }
  return principal;
}

function createEvent(input: AgentTriggerEvent | null | undefined): AgentTriggerEvent {
  return {
    id: requireString(input?.id, 'event.id'),
    type: requireString(input?.type, 'event.type'),
    occurredAt: requireTimestamp(input?.occurredAt, 'event.occurredAt'),
    source: {
      id: requireString(input?.source?.id, 'event.source.id'),
      type: requireString(input?.source?.type, 'event.source.type'),
    },
    ...(input?.payload !== undefined && {
      payload: cloneJsonValue(input.payload, 'event.payload', error),
    }),
  };
}

function createExpectedAction(
  input: AgentTriggerExpectedAction | null | undefined,
): AgentTriggerExpectedAction | undefined {
  if (input == null) {
    return undefined;
  }
  const action = requireRecord(input, 'expectedAction');
  const argumentSubset =
    action.argumentSubset == null
      ? undefined
      : (cloneJsonValue(
          requireRecord(action.argumentSubset, 'expectedAction.argumentSubset'),
          'expectedAction.argumentSubset',
          error,
        ) as Record<string, JsonValue>);
  const toolName = requireString(action.toolName, 'expectedAction.toolName');
  if (toolName.length > MAX_EXPECTED_ACTION_TOOL_NAME_LENGTH) {
    throw error(
      `expectedAction.toolName must not exceed ${MAX_EXPECTED_ACTION_TOOL_NAME_LENGTH} characters`,
    );
  }
  return {
    toolName,
    ...(argumentSubset != null && { argumentSubset }),
  };
}

function createFireRunContext(
  input: AgentFireRunContext | null | undefined,
): AgentFireRunContext | undefined {
  if (input == null) {
    return undefined;
  }
  const run = requireRecord(input, 'run');
  const context: AgentFireRunContext = {};
  if (run.conversationId != null) {
    context.conversationId = requireString(run.conversationId, 'run.conversationId');
  }
  if (run.timezone != null) {
    context.timezone = requireString(run.timezone, 'run.timezone');
  }
  if (run.chatProjectId != null) {
    context.chatProjectId = requireString(run.chatProjectId, 'run.chatProjectId');
  }
  if (run.files != null) {
    if (!Array.isArray(run.files)) {
      throw error('run.files must be an array');
    }
    context.files = cloneJsonValue(run.files, 'run.files', error) as JsonValue[];
  }
  if (run.metadata !== undefined) {
    context.metadata = cloneJsonValue(run.metadata, 'run.metadata', error) as JsonValue;
  }
  return context;
}

export function createAgentTriggerEnvelope(
  input: CreateAgentTriggerEnvelopeInput,
): AgentTriggerEnvelope {
  const receivedMode: string = input.mode;
  const expectedAction = createExpectedAction(input.expectedAction);
  const base: AgentTriggerEnvelopeBase = {
    version: AGENT_TRIGGER_ENVELOPE_VERSION,
    requestId: requireString(input.requestId, 'requestId'),
    deliveryId: requireString(input.deliveryId, 'deliveryId'),
    receivedAt: requireTimestamp(input.receivedAt, 'receivedAt'),
    principal: createPrincipal(input.principal),
    event: createEvent(input.event),
    input: requireString(input.input, 'input'),
    ...(expectedAction != null && { expectedAction }),
  };

  if (input.mode === 'fire') {
    const run = createFireRunContext(input.run);
    return {
      ...base,
      mode: input.mode,
      target: { agentId: requireString(input.target?.agentId, 'target.agentId') },
      ...(run != null && { run }),
    };
  }

  if (input.mode === 'steer') {
    const target = input.target;
    if (target?.preempt != null && typeof target.preempt !== 'boolean') {
      throw error('target.preempt must be a boolean');
    }
    return {
      ...base,
      mode: input.mode,
      target: {
        agentId: requireString(target?.agentId, 'target.agentId'),
        conversationId: requireString(target?.conversationId, 'target.conversationId'),
        generationCreatedAt: requireTimestamp(
          target?.generationCreatedAt,
          'target.generationCreatedAt',
        ),
        ...(target?.preempt != null && { preempt: target.preempt }),
      },
    };
  }

  if (input.mode === 'continue') {
    const bindingId = input.target?.bindingId;
    const sourceKeyId = input.target?.sourceKeyId;
    if ((bindingId == null) !== (sourceKeyId == null)) {
      throw error('target.bindingId and target.sourceKeyId must be provided together');
    }
    return {
      ...base,
      mode: input.mode,
      target: {
        agentId: requireString(input.target?.agentId, 'target.agentId'),
        conversationId: requireString(input.target?.conversationId, 'target.conversationId'),
        parentMessageId: requireString(input.target?.parentMessageId, 'target.parentMessageId'),
        ...(bindingId == null
          ? {}
          : {
              bindingId: requireString(bindingId, 'target.bindingId'),
              sourceKeyId: requireString(sourceKeyId, 'target.sourceKeyId'),
            }),
      },
    };
  }

  throw error(`Unsupported agent trigger mode: ${receivedMode}`);
}

/**
 * Validates and detaches an envelope received from a queue or another process.
 * Unknown versions, modes, and malformed v1 fields fail closed before dispatch.
 */
export function parseAgentTriggerEnvelope(input: unknown): AgentTriggerEnvelope {
  const envelope = requireRecord(cloneJsonValue(input, 'envelope', error), 'envelope');
  if (envelope.version !== AGENT_TRIGGER_ENVELOPE_VERSION) {
    throw error(`Unsupported agent trigger envelope version: ${String(envelope.version)}`);
  }

  const mode = envelope.mode;
  if (mode !== 'continue' && mode !== 'fire' && mode !== 'steer') {
    throw error(`Unsupported agent trigger mode: ${String(mode)}`);
  }

  const principalInput = requireRecord(envelope.principal, 'principal');
  const principal: AgentRunPrincipal = {
    userId: requireString(principalInput.userId, 'principal.userId'),
  };
  if (principalInput.role != null) {
    principal.role = requireString(principalInput.role, 'principal.role');
  }
  if (principalInput.tenantId != null) {
    principal.tenantId = requireString(principalInput.tenantId, 'principal.tenantId');
  }

  const eventInput = requireRecord(envelope.event, 'event');
  const sourceInput = requireRecord(eventInput.source, 'event.source');
  const event: AgentTriggerEvent = {
    id: requireString(eventInput.id, 'event.id'),
    type: requireString(eventInput.type, 'event.type'),
    occurredAt: requireTimestamp(eventInput.occurredAt, 'event.occurredAt'),
    source: {
      id: requireString(sourceInput.id, 'event.source.id'),
      type: requireString(sourceInput.type, 'event.source.type'),
    },
    ...(eventInput.payload !== undefined && { payload: eventInput.payload as JsonValue }),
  };

  const expectedAction = createExpectedAction(
    envelope.expectedAction as AgentTriggerExpectedAction | null | undefined,
  );

  const base: AgentTriggerEnvelopeBase = {
    version: AGENT_TRIGGER_ENVELOPE_VERSION,
    requestId: requireString(envelope.requestId, 'requestId'),
    deliveryId: requireString(envelope.deliveryId, 'deliveryId'),
    receivedAt: requireTimestamp(envelope.receivedAt, 'receivedAt'),
    principal,
    event,
    input: requireString(envelope.input, 'input'),
    ...(expectedAction != null && { expectedAction }),
  };
  const target = requireRecord(envelope.target, 'target');

  if (mode === 'fire') {
    const run = createFireRunContext(
      envelope.run == null ? undefined : (envelope.run as AgentFireRunContext),
    );
    return {
      ...base,
      mode,
      target: { agentId: requireString(target.agentId, 'target.agentId') },
      ...(run != null && { run }),
    };
  }

  if (mode === 'continue') {
    if ((target.bindingId == null) !== (target.sourceKeyId == null)) {
      throw error('target.bindingId and target.sourceKeyId must be provided together');
    }
    return {
      ...base,
      mode,
      target: {
        agentId: requireString(target.agentId, 'target.agentId'),
        conversationId: requireString(target.conversationId, 'target.conversationId'),
        parentMessageId: requireString(target.parentMessageId, 'target.parentMessageId'),
        ...(target.bindingId == null
          ? {}
          : {
              bindingId: requireString(target.bindingId, 'target.bindingId'),
              sourceKeyId: requireString(target.sourceKeyId, 'target.sourceKeyId'),
            }),
      },
    };
  }

  if (target.preempt != null && typeof target.preempt !== 'boolean') {
    throw error('target.preempt must be a boolean');
  }
  return {
    ...base,
    mode,
    target: {
      agentId: requireString(target.agentId, 'target.agentId'),
      conversationId: requireString(target.conversationId, 'target.conversationId'),
      generationCreatedAt: requireTimestamp(
        target.generationCreatedAt,
        'target.generationCreatedAt',
      ),
      ...(target.preempt != null && { preempt: target.preempt }),
    },
  };
}

/**
 * Stable idempotency key for one target delivery. Its character set and length
 * are accepted by both generation `clientRequestId` and steering `clientSteerId`.
 */
export function getAgentTriggerIdempotencyKey(envelope: AgentTriggerEnvelope): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        envelope.version,
        envelope.principal.tenantId ?? '',
        envelope.principal.userId,
        envelope.event.source.type,
        envelope.event.source.id,
        envelope.event.type,
        envelope.event.id,
        envelope.deliveryId,
        envelope.mode,
        envelope.target.agentId,
        envelope.mode === 'fire' ? '' : envelope.target.conversationId,
        envelope.mode === 'continue' ? envelope.target.parentMessageId : '',
        envelope.mode === 'continue' ? (envelope.target.bindingId ?? '') : '',
        envelope.mode === 'continue' ? (envelope.target.sourceKeyId ?? '') : '',
      ]),
    )
    .digest('hex');
  return `${AGENT_TRIGGER_IDEMPOTENCY_PREFIX}${digest}`;
}

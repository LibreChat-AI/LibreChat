import type { TEphemeralAgent } from 'librechat-data-provider';
import type { JsonPrimitive, JsonValue } from './json';
import type { ChatCompletionRequest } from './openai';
import type { ResponseRequest } from './responses';
import { AGENT_ENVELOPE_MAX_NESTING_DEPTH, cloneJsonValue } from './json';

export const AGENT_RUN_ENVELOPE_VERSION = 1 as const;
export const AGENT_RUN_ENVELOPE_MAX_NESTING_DEPTH: number = AGENT_ENVELOPE_MAX_NESTING_DEPTH;

export type AgentRunProtocol = 'chat.completions' | 'responses';

export type { JsonPrimitive, JsonValue };

export interface AgentRunPrincipal {
  userId: string;
  role?: string;
  tenantId?: string;
}

export interface AgentRunPrincipalInput {
  id?: string;
  role?: string;
  tenantId?: string;
}

/** LibreChat request fields consumed by execution but not declared by the public protocols. */
export interface AgentRunPayloadExtensions {
  ephemeralAgent?: TEphemeralAgent | null;
  manualSkills?: string[];
  timezone?: string;
  isTemporary?: boolean;
}

export type ChatCompletionRunPayload = ChatCompletionRequest & AgentRunPayloadExtensions;
export type ResponsesRunPayload = ResponseRequest & AgentRunPayloadExtensions;

interface AgentRunEnvelopeBase {
  version: typeof AGENT_RUN_ENVELOPE_VERSION;
  requestId: string;
  receivedAt: number;
  principal: AgentRunPrincipal;
}

export interface ChatCompletionRunEnvelope extends AgentRunEnvelopeBase {
  protocol: 'chat.completions';
  payload: ChatCompletionRunPayload;
}

export interface ResponsesRunEnvelope extends AgentRunEnvelopeBase {
  protocol: 'responses';
  payload: ResponsesRunPayload;
}

export type AgentRunEnvelope = ChatCompletionRunEnvelope | ResponsesRunEnvelope;

export type CreateAgentRunEnvelopeInput =
  | {
      protocol: 'chat.completions';
      requestId: string;
      receivedAt: number;
      principal: AgentRunPrincipalInput | null | undefined;
      payload: ChatCompletionRunPayload;
    }
  | {
      protocol: 'responses';
      requestId: string;
      receivedAt: number;
      principal: AgentRunPrincipalInput | null | undefined;
      payload: ResponsesRunPayload;
    };

type CreateChatCompletionRunEnvelopeInput = Extract<
  CreateAgentRunEnvelopeInput,
  { protocol: 'chat.completions' }
>;
type CreateResponsesRunEnvelopeInput = Extract<
  CreateAgentRunEnvelopeInput,
  { protocol: 'responses' }
>;

export class AgentRunEnvelopeError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'AgentRunEnvelopeError';
  }
}

function assertNonEmptyString(value: string | undefined, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AgentRunEnvelopeError(`${path} must be a non-empty string`);
  }
  return value;
}

function createPrincipal(input: AgentRunPrincipalInput | null | undefined): AgentRunPrincipal {
  const userId = assertNonEmptyString(input?.id, 'principal.id');
  const principal: AgentRunPrincipal = { userId };

  if (input?.role != null) {
    principal.role = assertNonEmptyString(input.role, 'principal.role');
  }
  if (input?.tenantId != null) {
    principal.tenantId = assertNonEmptyString(input.tenantId, 'principal.tenantId');
  }

  return principal;
}

/**
 * Creates the versioned, transport-safe request that crosses the agent execution seam.
 * Runtime objects, provider clients, callbacks, credentials, and Express state belong to
 * the execution host and must never be added to this envelope.
 */
export function createAgentRunEnvelope(
  input: CreateChatCompletionRunEnvelopeInput,
): ChatCompletionRunEnvelope;
export function createAgentRunEnvelope(
  input: CreateResponsesRunEnvelopeInput,
): ResponsesRunEnvelope;
export function createAgentRunEnvelope(input: CreateAgentRunEnvelopeInput): AgentRunEnvelope {
  const receivedProtocol: string = input.protocol;
  const requestId = assertNonEmptyString(input.requestId, 'requestId');
  if (!Number.isSafeInteger(input.receivedAt) || input.receivedAt < 0) {
    throw new AgentRunEnvelopeError('receivedAt must be a non-negative integer timestamp');
  }

  const base = {
    version: AGENT_RUN_ENVELOPE_VERSION,
    requestId,
    receivedAt: input.receivedAt,
    principal: createPrincipal(input.principal),
  };

  if (input.protocol === 'chat.completions') {
    return {
      ...base,
      protocol: input.protocol,
      payload: cloneJsonValue(
        input.payload,
        'payload',
        (message) => new AgentRunEnvelopeError(message),
      ),
    };
  }

  if (input.protocol === 'responses') {
    return {
      ...base,
      protocol: input.protocol,
      payload: cloneJsonValue(
        input.payload,
        'payload',
        (message) => new AgentRunEnvelopeError(message),
      ),
    };
  }

  throw new AgentRunEnvelopeError(`Unsupported agent run protocol: ${receivedProtocol}`);
}

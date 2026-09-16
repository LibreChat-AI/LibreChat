import { logger, tenantStorage } from '@librechat/data-schemas';
import { Constants, EModelEndpoint } from 'librechat-data-provider';
import type { TFile, TReasoningOverride } from 'librechat-data-provider';
import type {
  AgentContinueTriggerEnvelope,
  AgentFireTriggerEnvelope,
  AgentSteerTriggerEnvelope,
  AgentTriggerEnvelope,
  AgentTriggerMode,
} from './envelope';
import type { AgentTriggerDispatchContext } from './dispatch';
import type { AgentRunPrincipal } from '../envelope';
import {
  EVENT_ACTOR_DETACHED_COMPLETION_SOURCE,
  EVENT_ACTOR_DETACHED_COMPLETION_TYPE,
  parseAgentEventActorDetachedCompletion,
} from './detachedAction';
import { dispatchAgentTrigger } from './dispatch';

const DEFAULT_FIRE_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BODY_BYTES = 64 * 1024;
const GENERATION_PROTOCOL_HEADER = 'x-librechat-generation-protocol';
const TRIGGER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 LibreChat-Agent-Trigger/1';

const PRE_CONNECT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

type MaybePromise<T> = T | Promise<T>;
type FireStatus = 'started' | 'resumed' | 'replaced' | 'settled';

export type AgentTriggerFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface AgentContinuationAdmissionSource {
  source: string;
  sourceId: string;
  claimId: string;
  claimBy: string;
  effectivePredecessorCreatedAt?: number;
  lineagePredecessorId?: string;
}

export type AgentTriggerContinuePreparation =
  | {
      status: 'ready';
      input: string;
      parentMessageId: string;
      expectedPredecessorCreatedAt?: number;
      /** Complete user-turn context for internal continuations that must start
       * a fresh ordinary Agent turn rather than inject into an existing run. */
      files?: Partial<TFile>[];
      quotes?: string[];
      manualSkills?: string[];
      reasoningOverride?: TReasoningOverride;
      /** Trusted source identity committed by execution enrollment before the
       * provider-start fence opens. */
      admissionSource?: AgentContinuationAdmissionSource;
      /** Compensates a durable pre-admission claim only when the host knows
       * that no generation was admitted. Ambiguous outcomes retain the claim. */
      releaseOnDefiniteFailure?: (error?: AgentTriggerExecutionError) => MaybePromise<void>;
      /** Commits the source handoff after generation admission. Failure is
       * outcome-ambiguous: the same delivery retries with the same request id. */
      settleOnAdmission?: (result: AgentTriggerContinueResult) => MaybePromise<void>;
    }
  | { status: 'settled' };

export type AgentTriggerFailureCertainty = 'definite' | 'ambiguous';

export interface AgentTriggerExecutionErrorOptions {
  mode: AgentTriggerMode;
  certainty: AgentTriggerFailureCertainty;
  retryable: boolean;
  /** Release the delivery lease without consuming its logical retry budget. */
  deferWithoutAttempt?: boolean;
  code?: string;
  status?: number;
  retryAfter?: string;
}

/**
 * A typed delivery failure. `ambiguous` means the action may already be
 * committed; callers may retry only the same envelope so its idempotency key
 * remains unchanged.
 */
export class AgentTriggerExecutionError extends Error {
  readonly mode: AgentTriggerMode;
  readonly certainty: AgentTriggerFailureCertainty;
  readonly retryable: boolean;
  readonly deferWithoutAttempt: boolean;
  readonly code?: string;
  readonly status?: number;
  readonly retryAfter?: string;

  constructor(message: string, options: AgentTriggerExecutionErrorOptions) {
    super(message);
    this.name = 'AgentTriggerExecutionError';
    this.mode = options.mode;
    this.certainty = options.certainty;
    this.retryable = options.retryable;
    this.deferWithoutAttempt = options.deferWithoutAttempt === true;
    this.code = options.code;
    this.status = options.status;
    this.retryAfter = options.retryAfter;
  }
}

export interface AgentTriggerFireResult {
  mode: 'fire';
  status: FireStatus;
  conversationId: string;
  streamId?: string;
  generationCreatedAt?: number;
}

export interface AgentTriggerSteerResult {
  mode: 'steer';
  status: 'queued';
  conversationId: string;
  steerId: string;
  position: number;
  preempt: boolean;
  preemptRevision?: number;
  replayed?: boolean;
  settled?: boolean;
  leftover?: boolean;
}

export interface AgentTriggerContinueResult {
  mode: 'continue';
  status: FireStatus;
  conversationId: string;
  streamId?: string;
  generationCreatedAt?: number;
}

export type AgentTriggerExecutionResult =
  | AgentTriggerContinueResult
  | AgentTriggerFireResult
  | AgentTriggerSteerResult;

export interface AgentTriggerExecutionHostDeps {
  /** Trusted root URL for this LibreChat server. */
  getBaseUrl: (options?: { localOnly?: boolean }) => string;
  /** Mint a short-lived token for the envelope's already-authenticated principal. */
  mintToken: (principal: AgentRunPrincipal, envelope: AgentTriggerEnvelope) => MaybePromise<string>;
  /** Optional user-timezone resolver for dynamic date variables in a new run. */
  getTimezone?: (
    principal: AgentRunPrincipal,
    envelope: AgentContinueTriggerEnvelope | AgentFireTriggerEnvelope,
  ) => MaybePromise<string | undefined>;
  /** Optional server-owned resolver for durable internal continuation inputs.
   * External/source-neutral envelopes remain unchanged when this returns undefined. */
  prepareContinue?: (
    envelope: AgentContinueTriggerEnvelope,
    context: AgentTriggerDispatchContext,
  ) => MaybePromise<AgentTriggerContinuePreparation | undefined>;
  fetch?: AgentTriggerFetch;
  /** Total bound for setup, admission, and the bounded response read. */
  timeoutMs?: number;
}

export interface AgentTriggerExecutionHost {
  dispatch: (
    envelope: unknown,
    options?: { signal?: AbortSignal; attempt?: number; maxAttempts?: number },
  ) => Promise<AgentTriggerExecutionResult>;
}

interface AbortScope {
  signal: AbortSignal;
  abort: () => void;
  cleanup: () => void;
  timedOut: () => boolean;
}

interface BoundedResponseBody {
  text: string;
  truncated: boolean;
}

function executionError(
  message: string,
  options: AgentTriggerExecutionErrorOptions,
): AgentTriggerExecutionError {
  return new AgentTriggerExecutionError(message, options);
}

function requireTimeout(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? DEFAULT_FIRE_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('Agent trigger timeout must be a positive integer');
  }
  return value;
}

function abortScope(parent: AbortSignal | undefined, timeoutMs: number): AbortScope {
  const controller = new AbortController();
  let timeoutReached = false;
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted === true) {
    onAbort();
  } else {
    parent?.addEventListener('abort', onAbort, { once: true });
  }
  const timeout = setTimeout(() => {
    timeoutReached = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    timedOut: () => timeoutReached,
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

function abortError(
  mode: AgentTriggerMode,
  scope: AbortScope,
  parent: AbortSignal | undefined,
  stage: string,
  certainty: AgentTriggerFailureCertainty,
): AgentTriggerExecutionError {
  const code = abortCode(scope, parent, 'ABORTED');
  return executionError(
    `Agent trigger ${mode} was ${code === 'TIMEOUT' ? 'timed out' : 'aborted'} ${stage}`,
    {
      mode,
      certainty,
      retryable: true,
      code,
    },
  );
}

function observeAbort<T>(
  operation: () => MaybePromise<T>,
  mode: AgentTriggerMode,
  scope: AbortScope,
  parent: AbortSignal | undefined,
  onLateValue?: (value: T) => MaybePromise<void>,
): Promise<T> {
  if (scope.signal.aborted) {
    return Promise.reject(abortError(mode, scope, parent, 'before dispatch', 'definite'));
  }
  return new Promise<T>((resolve, reject) => {
    let abandoned = false;
    const onAbort = () => {
      abandoned = true;
      scope.signal.removeEventListener('abort', onAbort);
      reject(abortError(mode, scope, parent, 'during setup', 'definite'));
    };
    scope.signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          scope.signal.removeEventListener('abort', onAbort);
          if (abandoned) {
            Promise.resolve(onLateValue?.(value)).catch((error: unknown) => {
              logger.error('[agentTriggers] Failed to compensate late setup result', error);
            });
            return;
          }
          resolve(value);
        },
        (error: unknown) => {
          scope.signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
  });
}

async function setupValue<T>(
  operation: () => MaybePromise<T>,
  mode: AgentTriggerMode,
  scope: AbortScope,
  parent: AbortSignal | undefined,
  onLateValue?: (value: T) => MaybePromise<void>,
): Promise<T> {
  try {
    return await observeAbort(operation, mode, scope, parent, onLateValue);
  } catch (error) {
    if (error instanceof AgentTriggerExecutionError) {
      throw error;
    }
    throw executionError(
      `Agent trigger ${mode} setup failed: ${error instanceof Error ? error.message : String(error)}`,
      {
        mode,
        certainty: 'definite',
        retryable: true,
        code: 'SETUP_FAILED',
      },
    );
  }
}

async function readResponseBody(response: Response): Promise<BoundedResponseBody> {
  if (response.body == null) {
    return { text: '', truncated: false };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  const parts: string[] = [];
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        parts.push(decoder.decode());
        return { text: parts.join(''), truncated: false };
      }
      const remaining = MAX_RESPONSE_BODY_BYTES - size;
      if (chunk.value.byteLength > remaining) {
        if (remaining > 0) {
          parts.push(
            decoder.decode(chunk.value.subarray(0, remaining), {
              stream: true,
            }),
          );
        }
        parts.push(decoder.decode());
        await reader.cancel().catch(() => undefined);
        return { text: parts.join(''), truncated: true };
      }
      size += chunk.value.byteLength;
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
}

function errorCode(value: unknown): string | undefined {
  if (value == null || typeof value !== 'object' || !('code' in value)) {
    return undefined;
  }
  const code = value.code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

function errorMessage(value: unknown): string | undefined {
  if (value == null || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['error', 'message', 'code']) {
    if (key in record) {
      const message = record[key];
      if (typeof message === 'string' && message.length > 0) {
        return message;
      }
    }
  }
  return undefined;
}

function parseJson(value: string): unknown {
  if (value.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function fetchErrorCode(error: unknown): string | undefined {
  const read = (value: unknown): string | undefined => {
    if (value == null || typeof value !== 'object' || !('code' in value)) {
      return undefined;
    }
    const code = value.code;
    return typeof code === 'string' ? code : undefined;
  };
  if (error == null || typeof error !== 'object') {
    return undefined;
  }
  return ('cause' in error ? read(error.cause) : undefined) ?? read(error);
}

function isDefiniteConnectFailure(error: unknown): boolean {
  const code = fetchErrorCode(error);
  return (
    code != null &&
    (PRE_CONNECT_ERROR_CODES.has(code) || code.startsWith('ERR_TLS') || code.includes('CERT'))
  );
}

function isRetryableStatus(status: number): boolean {
  return status === 401 || status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRetryableSteerRejection(status: number, code: string): boolean {
  return code === 'RUN_PAUSED' || isRetryableStatus(status);
}

function abortCode(scope: AbortScope, parent: AbortSignal | undefined, fallback: string): string {
  if (scope.timedOut()) {
    return 'TIMEOUT';
  }
  if (parent?.aborted === true) {
    return 'ABORTED';
  }
  return fallback;
}

function requireToken(value: unknown, mode: AgentTriggerMode): string {
  if (typeof value !== 'string' || value.length === 0 || /\s/.test(value)) {
    throw executionError('Agent trigger token mint returned an invalid token', {
      mode,
      certainty: 'definite',
      retryable: false,
      code: 'INVALID_TOKEN',
    });
  }
  return value;
}

function triggerUrl(baseUrl: string, path: string, mode: AgentTriggerMode): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw executionError('Agent trigger base URL is invalid', {
      mode,
      certainty: 'definite',
      retryable: false,
      code: 'INVALID_BASE_URL',
    });
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw executionError('Agent trigger base URL must be an HTTP(S) URL without credentials', {
      mode,
      certainty: 'definite',
      retryable: false,
      code: 'INVALID_BASE_URL',
    });
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function fireUrl(baseUrl: string): string {
  return triggerUrl(baseUrl, `/api/agents/chat/${EModelEndpoint.agents}`, 'fire');
}

function continueUrl(baseUrl: string): string {
  return triggerUrl(baseUrl, `/api/agents/chat/${EModelEndpoint.agents}`, 'continue');
}

function steerUrl(baseUrl: string): string {
  return triggerUrl(baseUrl, '/api/agents/chat/steer/deliver', 'steer');
}

function requireString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requireSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function fireStatus(value: unknown): FireStatus | undefined {
  return value === 'started' || value === 'resumed' || value === 'replaced' || value === 'settled'
    ? value
    : undefined;
}

function parseStartResult(
  payload: unknown,
  mode: 'continue' | 'fire',
): AgentTriggerContinueResult | AgentTriggerFireResult | undefined {
  if (payload == null || typeof payload !== 'object') {
    return undefined;
  }
  const status = fireStatus('status' in payload ? payload.status : undefined);
  const conversationId = requireString(
    'conversationId' in payload ? payload.conversationId : undefined,
  );
  if (status == null || conversationId == null) {
    return undefined;
  }
  const streamId = requireString('streamId' in payload ? payload.streamId : undefined);
  if (status !== 'settled' && streamId == null) {
    return undefined;
  }
  const generationCreatedAt = requireSafeInteger(
    'generationCreatedAt' in payload ? payload.generationCreatedAt : undefined,
  );
  return {
    mode,
    status,
    conversationId,
    ...(streamId != null && { streamId }),
    ...(generationCreatedAt != null && { generationCreatedAt }),
  };
}

function resolveParentMessageId(
  preparation: AgentTriggerContinuePreparation | undefined,
  envelope: AgentContinueTriggerEnvelope | AgentFireTriggerEnvelope,
): string {
  if (preparation?.status === 'ready') {
    return preparation.parentMessageId;
  }
  if (envelope.mode === 'continue') {
    return envelope.target.parentMessageId;
  }
  return Constants.NO_PARENT;
}

/** A response can be definite at the HTTP layer while the idempotent logical
 * generation is still outcome-ambiguous. In particular, a retry can receive a
 * 5xx while the first request owns the generation claim or is finalizing its
 * accepted run. Compensate the prepared durable result only for failures that
 * prove admission did not happen. */
function canReleasePreparedResult(error: AgentTriggerExecutionError): boolean {
  if (error.certainty !== 'definite') {
    return false;
  }
  if (error.code === 'START_ABORTED' || error.status == null) {
    return true;
  }
  if (
    error.code === 'PARENT_NOT_READY' ||
    error.code === 'PARENT_STATE_UNAVAILABLE' ||
    error.code === 'EVENT_ACTOR_NOT_READY'
  ) {
    return true;
  }
  return error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 409;
}

function startRun(
  envelope: AgentFireTriggerEnvelope,
  context: AgentTriggerDispatchContext,
  deps: AgentTriggerExecutionHostDeps,
  timeoutMs: number,
): Promise<AgentTriggerFireResult>;
function startRun(
  envelope: AgentContinueTriggerEnvelope,
  context: AgentTriggerDispatchContext,
  deps: AgentTriggerExecutionHostDeps,
  timeoutMs: number,
): Promise<AgentTriggerContinueResult>;
async function startRun(
  envelope: AgentContinueTriggerEnvelope | AgentFireTriggerEnvelope,
  context: AgentTriggerDispatchContext,
  deps: AgentTriggerExecutionHostDeps,
  timeoutMs: number,
): Promise<AgentTriggerContinueResult | AgentTriggerFireResult> {
  const mode = envelope.mode;
  const detachedCompletion =
    mode === 'continue' &&
    envelope.event.type === EVENT_ACTOR_DETACHED_COMPLETION_TYPE &&
    envelope.event.source.type === 'internal' &&
    envelope.event.source.id === EVENT_ACTOR_DETACHED_COMPLETION_SOURCE
      ? parseAgentEventActorDetachedCompletion(envelope.event.payload)
      : undefined;
  const scope = abortScope(context.signal, timeoutMs);
  let preparation: AgentTriggerContinuePreparation | undefined;
  try {
    preparation =
      mode === 'continue' && deps.prepareContinue != null
        ? await setupValue(
            () => deps.prepareContinue?.(envelope, context),
            mode,
            scope,
            context.signal,
            async (latePreparation) => {
              if (latePreparation?.status === 'ready') {
                await latePreparation.releaseOnDefiniteFailure?.();
              }
            },
          )
        : undefined;
    if (preparation?.status === 'settled' && envelope.mode === 'continue') {
      return {
        mode: 'continue',
        status: 'settled',
        conversationId: envelope.target.conversationId,
      };
    }
    const readyPreparation = preparation?.status === 'ready' ? preparation : undefined;
    const input = readyPreparation?.input ?? envelope.input;
    const parentMessageId = resolveParentMessageId(preparation, envelope);
    const [token, resolvedTimezone, baseUrl] = await Promise.all([
      setupValue(
        () => deps.mintToken(envelope.principal, envelope),
        mode,
        scope,
        context.signal,
      ).then((value) => requireToken(value, mode)),
      setupValue(
        () => deps.getTimezone?.(envelope.principal, envelope),
        mode,
        scope,
        context.signal,
      ),
      setupValue(
        () =>
          deps.getBaseUrl(
            detachedCompletion == null && readyPreparation?.admissionSource == null
              ? undefined
              : { localOnly: true },
          ),
        mode,
        scope,
        context.signal,
      ),
    ]).catch((error: unknown) => {
      scope.abort();
      throw error;
    });
    const run = envelope.mode === 'fire' ? envelope.run : undefined;
    const timezone = run?.timezone ?? resolvedTimezone;
    const url = mode === 'fire' ? fireUrl(baseUrl) : continueUrl(baseUrl);
    const fetcher: AgentTriggerFetch = deps.fetch ?? globalThis.fetch;
    let response: Response;
    try {
      response = await fetcher(url, {
        method: 'POST',
        signal: scope.signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': TRIGGER_USER_AGENT,
          'x-lc-agent-trigger': '1',
          'x-request-id': context.idempotencyKey,
          ...(envelope.mode === 'continue' && envelope.target.bindingId != null
            ? {
                'x-lc-agent-event-binding': envelope.target.bindingId,
                'x-lc-agent-event-source-key': envelope.target.sourceKeyId!,
              }
            : {}),
          [GENERATION_PROTOCOL_HEADER]: '2',
        },
        body: JSON.stringify({
          text: input,
          endpoint: EModelEndpoint.agents,
          agent_id: envelope.target.agentId,
          parentMessageId,
          ...(readyPreparation?.expectedPredecessorCreatedAt != null && {
            expectedPredecessorCreatedAt: readyPreparation.expectedPredecessorCreatedAt,
          }),
          ...(envelope.mode === 'continue' && {
            conversationId: envelope.target.conversationId,
          }),
          ...(readyPreparation?.files != null && {
            files: readyPreparation.files,
          }),
          ...(readyPreparation?.quotes != null && {
            quotes: readyPreparation.quotes,
          }),
          ...(readyPreparation?.manualSkills != null && {
            manualSkills: readyPreparation.manualSkills,
          }),
          ...(readyPreparation?.reasoningOverride != null && {
            reasoningOverride: readyPreparation.reasoningOverride,
          }),
          isContinued: false,
          isRegenerate: false,
          clientRequestId: context.idempotencyKey,
          generationProtocolVersion: 2,
          ...(readyPreparation?.admissionSource != null && {
            agentContinuationAdmission: readyPreparation.admissionSource,
          }),
          ...(envelope.mode === 'continue' &&
            envelope.target.bindingId != null && {
              agentEventDelivery: {
                deliveryKey: context.idempotencyKey,
                /** Identity only, matching the `fire` body: the actor uses this
                 * to bind an invocation, never to build the turn's prompt. The
                 * source payload is unbounded and would push large deliveries
                 * past the chat route's body limit. */
                event: {
                  id: envelope.event.id,
                  type: envelope.event.type,
                  occurredAt: envelope.event.occurredAt,
                  source: envelope.event.source,
                },
                ...(envelope.expectedAction != null && {
                  expectedAction: envelope.expectedAction,
                }),
                ...(detachedCompletion == null ? {} : { internalCompletion: detachedCompletion }),
              },
            }),
          ...(envelope.mode === 'fire' && {
            agentTrigger: {
              version: envelope.version,
              deliveryId: envelope.deliveryId,
              event: {
                id: envelope.event.id,
                type: envelope.event.type,
                occurredAt: envelope.event.occurredAt,
                source: envelope.event.source,
              },
              ...(run?.metadata !== undefined && {
                metadata: run.metadata,
              }),
            },
          }),
          ...(run?.conversationId != null && {
            newConversationId: run.conversationId,
          }),
          ...(run?.chatProjectId != null && {
            chatProjectId: run.chatProjectId,
          }),
          ...(run?.files != null && { files: run.files }),
          ...(typeof timezone === 'string' && timezone.trim().length > 0
            ? { timezone: timezone.trim() }
            : {}),
        }),
      });
    } catch (error) {
      const definite = isDefiniteConnectFailure(error);
      const message = error instanceof Error ? error.message : String(error);
      throw executionError(
        `Agent trigger ${mode} ${definite ? 'could not connect' : 'has an unknown outcome'}: ${message}`,
        {
          mode,
          certainty: definite ? 'definite' : 'ambiguous',
          retryable: true,
          code: abortCode(scope, context.signal, 'NETWORK_ERROR'),
        },
      );
    }

    let boundedBody: BoundedResponseBody = { text: '', truncated: false };
    try {
      boundedBody = await readResponseBody(response);
    } catch (error) {
      if (response.ok) {
        throw executionError(
          `Agent trigger ${mode} response has an unknown outcome: ${
            error instanceof Error ? error.message : String(error)
          }`,
          {
            mode,
            certainty: 'ambiguous',
            retryable: true,
            code: abortCode(scope, context.signal, 'INVALID_RESPONSE'),
            status: response.status,
          },
        );
      }
    }
    const payload = parseJson(boundedBody.text);
    if (!response.ok) {
      const message =
        errorMessage(payload) ?? (boundedBody.text.slice(0, 300) || 'request rejected');
      const deferredContinue =
        mode === 'continue' &&
        response.status === 409 &&
        ['PARENT_NOT_READY', 'EVENT_ACTOR_NOT_READY'].includes(errorCode(payload) ?? '');
      throw executionError(`Agent trigger ${mode} was rejected (${response.status}): ${message}`, {
        mode,
        certainty: 'definite',
        retryable: isRetryableStatus(response.status) || deferredContinue,
        deferWithoutAttempt: deferredContinue,
        code: errorCode(payload) ?? (mode === 'fire' ? 'FIRE_REJECTED' : 'CONTINUE_REJECTED'),
        status: response.status,
        ...(response.headers.get('retry-after') != null && {
          retryAfter: response.headers.get('retry-after') ?? undefined,
        }),
      });
    }
    if (boundedBody.truncated) {
      throw executionError(`Agent trigger ${mode} returned an oversized success response`, {
        mode,
        certainty: 'ambiguous',
        retryable: true,
        code: 'RESPONSE_TOO_LARGE',
        status: response.status,
      });
    }
    if (
      payload != null &&
      typeof payload === 'object' &&
      'status' in payload &&
      payload.status === 'aborted'
    ) {
      throw executionError(`Agent trigger ${mode} was aborted before generation started`, {
        mode,
        certainty: 'definite',
        retryable: false,
        code: 'START_ABORTED',
        status: response.status,
      });
    }
    const result = parseStartResult(payload, mode);
    if (result == null) {
      throw executionError(`Agent trigger ${mode} returned an invalid success response`, {
        mode,
        certainty: 'ambiguous',
        retryable: true,
        code: 'INVALID_RESPONSE',
        status: response.status,
      });
    }
    if (mode === 'continue' && result.conversationId !== envelope.target.conversationId) {
      throw executionError('Agent trigger continue returned a mismatched conversation', {
        mode,
        certainty: 'ambiguous',
        retryable: true,
        code: 'INVALID_RESPONSE',
        status: response.status,
      });
    }
    if (
      mode === 'continue' &&
      result.mode === 'continue' &&
      readyPreparation?.settleOnAdmission != null
    ) {
      try {
        await readyPreparation.settleOnAdmission(result);
      } catch (error) {
        throw executionError(
          `Agent trigger continue admitted its generation but could not settle its prepared source: ${
            error instanceof Error ? error.message : String(error)
          }`,
          {
            mode,
            certainty: 'ambiguous',
            retryable: true,
            code: 'PREPARATION_SETTLEMENT_FAILED',
            status: response.status,
          },
        );
      }
    }
    return result;
  } catch (error) {
    if (
      preparation?.status === 'ready' &&
      preparation.releaseOnDefiniteFailure != null &&
      error instanceof AgentTriggerExecutionError &&
      canReleasePreparedResult(error)
    ) {
      try {
        await preparation.releaseOnDefiniteFailure(error);
      } catch (releaseError) {
        throw executionError(
          `Agent trigger ${mode} could not release its rejected preparation: ${
            releaseError instanceof Error ? releaseError.message : String(releaseError)
          }`,
          {
            mode,
            certainty: 'definite',
            retryable: true,
            code: 'PREPARATION_RELEASE_FAILED',
            deferWithoutAttempt: true,
          },
        );
      }
    }
    throw error;
  } finally {
    scope.cleanup();
  }
}

function parseSteerResult(payload: unknown): AgentTriggerSteerResult | undefined {
  if (payload == null || typeof payload !== 'object' || !('status' in payload)) {
    return undefined;
  }
  if (payload.status !== 'queued') {
    return undefined;
  }
  const conversationId = requireString(
    'conversationId' in payload ? payload.conversationId : undefined,
  );
  const steerId = requireString('steerId' in payload ? payload.steerId : undefined);
  const position = requireSafeInteger('position' in payload ? payload.position : undefined);
  if (
    conversationId == null ||
    steerId == null ||
    position == null ||
    !('preempt' in payload) ||
    typeof payload.preempt !== 'boolean'
  ) {
    return undefined;
  }
  const preemptRevision = requireSafeInteger(
    'preemptRevision' in payload ? payload.preemptRevision : undefined,
  );
  return {
    mode: 'steer',
    status: 'queued',
    conversationId,
    steerId,
    position,
    preempt: payload.preempt,
    ...(preemptRevision != null && { preemptRevision }),
    ...('replayed' in payload &&
      typeof payload.replayed === 'boolean' && {
        replayed: payload.replayed,
      }),
    ...('settled' in payload &&
      typeof payload.settled === 'boolean' && {
        settled: payload.settled,
      }),
    ...('leftover' in payload &&
      typeof payload.leftover === 'boolean' && {
        leftover: payload.leftover,
      }),
  };
}

async function steer(
  envelope: AgentSteerTriggerEnvelope,
  context: AgentTriggerDispatchContext,
  deps: AgentTriggerExecutionHostDeps,
  timeoutMs: number,
): Promise<AgentTriggerSteerResult> {
  const scope = abortScope(context.signal, timeoutMs);
  try {
    const [token, baseUrl] = await Promise.all([
      setupValue(
        () => deps.mintToken(envelope.principal, envelope),
        'steer',
        scope,
        context.signal,
      ).then((value) => requireToken(value, 'steer')),
      setupValue(() => deps.getBaseUrl(), 'steer', scope, context.signal),
    ]).catch((error: unknown) => {
      scope.abort();
      throw error;
    });
    const url = steerUrl(baseUrl);
    const fetcher: AgentTriggerFetch = deps.fetch ?? globalThis.fetch;
    let response: Response;
    try {
      response = await fetcher(url, {
        method: 'POST',
        signal: scope.signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': TRIGGER_USER_AGENT,
          'x-lc-agent-trigger': '1',
          'x-request-id': context.idempotencyKey,
          [GENERATION_PROTOCOL_HEADER]: '2',
        },
        body: JSON.stringify({
          agentId: envelope.target.agentId,
          conversationId: envelope.target.conversationId,
          generationCreatedAt: envelope.target.generationCreatedAt,
          text: envelope.input,
          clientSteerId: context.idempotencyKey,
          preempt: envelope.target.preempt === true,
          generationProtocolVersion: 2,
        }),
      });
    } catch (error) {
      const definite = isDefiniteConnectFailure(error);
      throw executionError(
        `Agent trigger steer ${definite ? 'could not connect' : 'has an unknown outcome'}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        {
          mode: 'steer',
          certainty: definite ? 'definite' : 'ambiguous',
          retryable: true,
          code: abortCode(scope, context.signal, 'NETWORK_ERROR'),
        },
      );
    }

    let boundedBody: BoundedResponseBody = { text: '', truncated: false };
    try {
      boundedBody = await readResponseBody(response);
    } catch (error) {
      if (response.ok) {
        throw executionError(
          `Agent trigger steer response has an unknown outcome: ${
            error instanceof Error ? error.message : String(error)
          }`,
          {
            mode: 'steer',
            certainty: 'ambiguous',
            retryable: true,
            code: abortCode(scope, context.signal, 'INVALID_RESPONSE'),
            status: response.status,
          },
        );
      }
    }

    const payload = parseJson(boundedBody.text);
    if (response.status !== 202) {
      const responseCode = errorCode(payload);
      const routeUnavailable = response.status === 404 && responseCode == null;
      const code = routeUnavailable
        ? 'STEER_ADMISSION_UNAVAILABLE'
        : (responseCode ?? 'STEER_REJECTED');
      throw executionError(
        `Agent trigger steer was rejected (${response.status}): ${errorMessage(payload) ?? code}`,
        {
          mode: 'steer',
          certainty: 'definite',
          retryable: routeUnavailable || isRetryableSteerRejection(response.status, code),
          code,
          status: response.status,
          ...(response.headers.get('retry-after') != null && {
            retryAfter: response.headers.get('retry-after') ?? undefined,
          }),
        },
      );
    }
    if (boundedBody.truncated) {
      throw executionError('Agent trigger steer returned an oversized success response', {
        mode: 'steer',
        certainty: 'ambiguous',
        retryable: true,
        code: 'RESPONSE_TOO_LARGE',
        status: response.status,
      });
    }
    if (
      payload == null ||
      typeof payload !== 'object' ||
      !('generationProtocolVersion' in payload) ||
      payload.generationProtocolVersion !== 2
    ) {
      throw executionError('Agent trigger steer was accepted without a v2 receipt guarantee', {
        mode: 'steer',
        certainty: 'ambiguous',
        retryable: false,
        code: 'STEER_IDEMPOTENCY_UNAVAILABLE',
        status: response.status,
      });
    }
    const parsed = parseSteerResult(payload);
    if (parsed == null) {
      throw executionError('Agent trigger steer returned an invalid success response', {
        mode: 'steer',
        certainty: 'ambiguous',
        retryable: true,
        code: 'INVALID_RESPONSE',
        status: response.status,
      });
    }
    if (parsed.conversationId !== envelope.target.conversationId) {
      throw executionError('Agent trigger steer returned a mismatched conversation', {
        mode: 'steer',
        certainty: 'ambiguous',
        retryable: true,
        code: 'INVALID_RESPONSE',
        status: response.status,
      });
    }
    return parsed;
  } finally {
    scope.cleanup();
  }
}

function runAsPrincipal<T>(
  envelope: AgentTriggerEnvelope,
  context: AgentTriggerDispatchContext,
  fn: () => Promise<T>,
): Promise<T> {
  return tenantStorage.run(
    {
      userId: envelope.principal.userId,
      tenantId: envelope.principal.tenantId,
      requestId: context.idempotencyKey,
    },
    fn,
  );
}

/**
 * Creates the trusted, source-neutral execution host. Schedules, webhooks,
 * queues, MCP adapters, and internal events all call the same `dispatch` and
 * therefore share authorization, idempotency, tenant, and failure semantics.
 */
export function createAgentTriggerExecutionHost(
  deps: AgentTriggerExecutionHostDeps,
): AgentTriggerExecutionHost {
  const timeoutMs = requireTimeout(deps.timeoutMs);
  return {
    dispatch: (envelope, options) =>
      Promise.resolve().then(() =>
        dispatchAgentTrigger(
          envelope,
          {
            fire: (normalized, context) =>
              runAsPrincipal(normalized, context, () =>
                startRun(normalized, context, deps, timeoutMs),
              ),
            continue: (normalized, context) =>
              runAsPrincipal(normalized, context, () =>
                startRun(normalized, context, deps, timeoutMs),
              ),
            steer: (normalized, context) =>
              runAsPrincipal(normalized, context, () =>
                steer(normalized, context, deps, timeoutMs),
              ),
          },
          options,
        ),
      ),
  };
}

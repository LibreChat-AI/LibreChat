import { createHash, randomUUID } from 'node:crypto';
import type { ResponseOwner, ResponseStorage, StoredResponseRecord } from '@librechat/data-schemas';
import type { ResponsesRunEnvelope, JsonValue } from '../envelope';
import type { ResponseCompletionRecord } from './completion';
import type { Response } from './types';
import {
  createResponseContext,
  createResponseAggregator,
  buildAggregatedResponse,
} from './service';

export type BackgroundResponseResult =
  | { ok: true; response: Response }
  | { ok: false; status: 400 | 403 | 404 | 409; code: string };

/** The host supplies the existing durable queue and Responses execution runtime. */
export interface BackgroundResponseDependencies {
  storage: ResponseStorage;
  /** Recheck current credential/owner/Agent authority; possession of a response ID is not authority. */
  authorize: (owner: ResponseOwner, agentId: string, sourceKeyId?: string) => Promise<boolean>;
  resolveContinuation: (
    owner: ResponseOwner,
    previousResponseId?: string,
  ) => Promise<{
    conversationId: string;
    parentMessageId: string;
    expiredAt?: Date;
    isTemporary?: boolean;
  }>;
  /** Idempotent queue publication under record.deliveryKey; MUST NOT execute inline or mint a new identity on retry. */
  enqueue: (record: StoredResponseRecord) => Promise<void>;
  deliveryKey?: (record: StoredResponseRecord) => string;
  /** Progress-only projection. A terminal observation is a hint to reread the journal;
   * generationCreatedAt is a consistency witness, never enrollment authority. */
  observe: (record: StoredResponseRecord) => Promise<{
    response: Response;
    generationCreatedAt?: number;
  } | null>;
  /** Completion journal owns cleanup and release before any terminal view becomes public. */
  recoverTerminal: (record: StoredResponseRecord) => Promise<ResponseCompletionRecord>;
  /** Signal exact execution; the completion journal confirms its final outcome. Never claim a missing job stopped. */
  cancel: (record: StoredResponseRecord) => Promise<void>;
  now?: () => number;
}

export function canonicalResponseJSON(request: object): string {
  return JSON.stringify(request, (_key: string, value: JsonValue) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, value[key]]),
    );
  });
}

function terminal(status: StoredResponseRecord['status']) {
  return ['completed', 'failed', 'incomplete', 'cancelled'].includes(status);
}

export function buildPendingBackgroundResponse(
  record: StoredResponseRecord,
  envelope?: ResponsesRunEnvelope,
): Response {
  const request =
    envelope?.payload ?? (JSON.parse(record.requestJSON) as ResponsesRunEnvelope['payload']);
  const context = createResponseContext(request, record.responseId);
  context.createdAt = Math.floor(record.createdAt.getTime() / 1000);
  return {
    ...buildAggregatedResponse(context, createResponseAggregator()),
    // A private terminal phase is already enrolled; never expose its database status.
    status: record.status === 'materializing' ? 'in_progress' : 'queued',
    completed_at: null,
    output: [],
    usage: null,
    background: true,
    store: true,
    metadata: request.metadata ?? {},
  };
}

function view(record: StoredResponseRecord): Response {
  return record.responseJSON
    ? (JSON.parse(record.responseJSON) as Response)
    : buildPendingBackgroundResponse(record);
}

/** Provider-neutral Responses lifecycle; no channel, Slack, service-token or rendering dependency. */
export function createBackgroundResponseService(deps: BackgroundResponseDependencies) {
  if (typeof deps.recoverTerminal !== 'function')
    throw new Error('Response completion owner is unavailable');
  const now = deps.now ?? Date.now;

  async function readAuthorized(owner: ResponseOwner, responseId: string) {
    const record = await deps.storage.read(owner, responseId);
    if (!record || !(await deps.authorize(owner, record.agentId, record.sourceKeyId))) return null;
    return record;
  }

  function hasTerminalResult(record: StoredResponseRecord): boolean {
    return record.pendingTerminal != null || terminal(record.status);
  }

  function hasTerminalWork(record: StoredResponseRecord): boolean {
    return record.preparedTerminal != null || hasTerminalResult(record);
  }

  async function canonicalView(record: StoredResponseRecord): Promise<Response | null> {
    if (!hasTerminalWork(record)) return view(record);
    const recovered = await deps.recoverTerminal(record);
    return recovered.retirement ? null : view(recovered);
  }

  async function freshView(record: StoredResponseRecord): Promise<Response | null> {
    const current = await deps.storage.read(record, record.responseId);
    return current ? canonicalView(current) : null;
  }

  async function refresh(record: StoredResponseRecord): Promise<Response | null> {
    if (hasTerminalWork(record)) return canonicalView(record);
    const observed = await deps.observe(record);
    if (!observed) return view(record);
    const response = observed.response;
    if (
      response.id !== record.responseId ||
      response.model !== record.agentId ||
      !response.background ||
      !response.store
    )
      throw new Error('Background response execution identity changed');
    // An observer has no provider-drain or checkpoint proof. Only the journal may finalize it.
    // Enrollment identity likewise belongs to admission, never a progress projection.
    if (
      terminal(response.status) ||
      (observed.generationCreatedAt != null &&
        observed.generationCreatedAt !== record.generationCreatedAt)
    )
      return freshView(record);
    const result = await deps.storage.publish(record, record.responseId, record.revision, {
      status:
        response.required_action || (record.status === 'requires_action' && record.review != null)
          ? 'requires_action'
          : response.status,
      responseJSON: JSON.stringify(response),
    });
    return result.ok ? canonicalView(result.record) : freshView(record);
  }

  async function responseResult(record: StoredResponseRecord): Promise<BackgroundResponseResult> {
    const response = await refresh(record);
    return response
      ? { ok: true, response }
      : { ok: false, status: 404, code: 'response_not_found' };
  }

  /** Null is absence of a readable journal, never an authorization denial or storage failure. */
  async function lookup(
    owner: ResponseOwner,
    responseId: string,
  ): Promise<BackgroundResponseResult | null> {
    const record = await deps.storage.read(owner, responseId);
    if (!record) return null;
    if (!(await deps.authorize(owner, record.agentId, record.sourceKeyId)))
      return { ok: false, status: 404, code: 'response_not_found' };
    return responseResult(record);
  }

  return {
    lookup(owner: ResponseOwner, responseId: string): Promise<BackgroundResponseResult | null> {
      return lookup(owner, responseId);
    },
    async create(
      envelope: ResponsesRunEnvelope,
      idempotencyKey?: string,
      sourceKeyId?: string,
    ): Promise<BackgroundResponseResult> {
      const request = envelope.payload;
      if (request.background !== true || request.store === false || request.stream === true)
        return { ok: false, status: 400, code: 'invalid_background_request' };
      if (idempotencyKey != null && (!idempotencyKey.trim() || idempotencyKey.length > 256))
        return { ok: false, status: 400, code: 'invalid_idempotency_key' };
      const owner = envelope.principal;
      if (!(await deps.authorize(owner, request.model, sourceKeyId)))
        return { ok: false, status: 403, code: 'permission_denied' };
      const normalized = { ...request, store: true };
      const requestJSON = canonicalResponseJSON(normalized);
      const continuation = await deps.resolveContinuation(owner, request.previous_response_id);
      const result = await deps.storage.reserve({
        ...owner,
        ...continuation,
        agentId: request.model,
        ...(sourceKeyId == null ? {} : { sourceKeyId }),
        responseId: `resp_${randomUUID().replaceAll('-', '')}`,
        requestKey: idempotencyKey ?? randomUUID(),
        fingerprint: createHash('sha256').update(requestJSON).digest('hex'),
        requestJSON,
      });
      if (!result.ok) return { ok: false, status: 409, code: result.code };
      let record = result.record;
      if (result.replayed && !(await deps.authorize(owner, record.agentId, record.sourceKeyId)))
        return { ok: false, status: 403, code: 'permission_denied' };
      if (hasTerminalWork(record)) return responseResult(record);
      const attached = await deps.storage.attachDelivery(
        owner,
        record.responseId,
        deps.deliveryKey?.(record) ?? `response_${record.responseId}`,
      );
      if (attached.ok) {
        record = attached.record;
        if (!hasTerminalWork(record)) await deps.enqueue(record);
      }
      return hasTerminalWork(record)
        ? responseResult(record)
        : { ok: true, response: view(record) };
    },
    async retrieve(owner: ResponseOwner, responseId: string): Promise<BackgroundResponseResult> {
      return (
        (await lookup(owner, responseId)) ?? {
          ok: false,
          status: 404,
          code: 'response_not_found',
        }
      );
    },
    async cancel(owner: ResponseOwner, responseId: string): Promise<BackgroundResponseResult> {
      const authorized = await readAuthorized(owner, responseId);
      if (!authorized) return { ok: false, status: 404, code: 'response_not_found' };
      if (hasTerminalResult(authorized)) return responseResult(authorized);
      const record = await deps.storage.requestCancellation(owner, responseId, now());
      if (!record) return { ok: false, status: 404, code: 'response_not_found' };
      if (!hasTerminalResult(record)) await deps.cancel(record);
      const current = await readAuthorized(owner, responseId);
      if (!current) return { ok: false, status: 404, code: 'response_not_found' };
      return responseResult(current);
    },
  };
}

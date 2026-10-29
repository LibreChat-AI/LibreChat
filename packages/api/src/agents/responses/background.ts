import { createHash, randomUUID } from 'node:crypto';
import type { ResponseOwner, ResponseStorage, StoredResponseRecord } from '@librechat/data-schemas';
import type { ResponsesRunEnvelope, JsonValue } from '../envelope';
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
  observe: (record: StoredResponseRecord) => Promise<{
    response: Response;
    generationCreatedAt?: number;
  } | null>;
  recoverTerminal?: (record: StoredResponseRecord) => Promise<StoredResponseRecord>;
  /** Signal exact execution and wait for provider-drained confirmation in observe; never claim a missing job stopped. */
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
    status: 'queued',
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
  const now = deps.now ?? Date.now;

  async function readAuthorized(owner: ResponseOwner, responseId: string) {
    const record = await deps.storage.read(owner, responseId);
    if (!record || !(await deps.authorize(owner, record.agentId, record.sourceKeyId))) return null;
    return record;
  }

  async function refresh(record: StoredResponseRecord): Promise<Response> {
    if ((record.pendingTerminal || terminal(record.status)) && deps.recoverTerminal)
      record = await deps.recoverTerminal(record);
    if (record.pendingTerminal) return view(record);
    if (terminal(record.status)) return view(record);
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
    const result = await deps.storage.publish(record, record.responseId, record.revision, {
      status:
        response.required_action || (record.status === 'requires_action' && record.review != null)
          ? 'requires_action'
          : response.status,
      responseJSON: JSON.stringify(response),
      ...(observed.generationCreatedAt == null
        ? {}
        : { generationCreatedAt: observed.generationCreatedAt }),
    });
    if (result.ok) return response;
    const current = await deps.storage.read(record, record.responseId);
    if (!current) throw new Error('Background response disappeared during publication');
    return view(current);
  }

  return {
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
      if (!terminal(record.status)) {
        const attached = await deps.storage.attachDelivery(
          owner,
          record.responseId,
          deps.deliveryKey?.(record) ?? `response_${record.responseId}`,
        );
        if (attached.ok) {
          record = attached.record;
          await deps.enqueue(record);
        }
      }
      return { ok: true, response: terminal(record.status) ? await refresh(record) : view(record) };
    },
    async retrieve(owner: ResponseOwner, responseId: string): Promise<BackgroundResponseResult> {
      const record = await readAuthorized(owner, responseId);
      if (!record) return { ok: false, status: 404, code: 'response_not_found' };
      return { ok: true, response: await refresh(record) };
    },
    async cancel(owner: ResponseOwner, responseId: string): Promise<BackgroundResponseResult> {
      const authorized = await readAuthorized(owner, responseId);
      if (!authorized) return { ok: false, status: 404, code: 'response_not_found' };
      if (terminal(authorized.status)) return { ok: true, response: await refresh(authorized) };
      const record = await deps.storage.requestCancellation(owner, responseId, now());
      if (!record) return { ok: false, status: 404, code: 'response_not_found' };
      if (!terminal(record.status)) await deps.cancel(record);
      const current = await readAuthorized(owner, responseId);
      if (!current) return { ok: false, status: 404, code: 'response_not_found' };
      return { ok: true, response: await refresh(current) };
    },
  };
}

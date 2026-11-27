import { logger } from '@librechat/data-schemas';
import {
  Constants,
  TRACE_CURSOR_MAX_LENGTH,
  TRACE_RECORD_ID_MAX_LENGTH,
  TRACE_SOURCE_ID_MAX_LENGTH,
  resolveTraceViewerConfig,
} from 'librechat-data-provider';
import type {
  TTraceRecord,
  TTraceErrorCode,
  TTraceAvailability,
  TTraceErrorResponse,
} from 'librechat-data-provider';
import type { Request, Response } from 'express';
import type { TraceQuery, TraceReader } from './types';
import type { ServerRequest } from '~/types/http';
import { TraceReadError } from './types';

const CONVERSATION_ID_MAX_LENGTH = 256;
const CURSOR_PATTERN = /^[A-Za-z0-9+/=_-]+$/;

export type TraceRequest = ServerRequest & Request<{ conversationId?: string; recordId?: string }>;

type ConversationOwnership = {
  user?: string | null;
  tenantId?: string | null;
  subagentThread?: object | null;
} | null;

/** Resolves once the response is sent; Express route handlers return nothing. */
export type TraceRouteHandler = (req: TraceRequest, res: Response) => Promise<void>;

type RespondingHandler = (req: TraceRequest, res: Response) => Promise<Response>;

const toRouteHandler =
  (handler: RespondingHandler): TraceRouteHandler =>
  async (req, res) => {
    await handler(req, res);
  };

export interface TraceHandlers {
  availability: TraceRouteHandler;
  records: TraceRouteHandler;
  record: TraceRouteHandler;
}

export interface TraceHandlerDeps {
  reader: TraceReader;
  /** `tenantId: null` is the tenantless scope, as the subagent thread views pass it. */
  getConvoOwnership: (
    userId: string,
    conversationId: string,
    tenantId: string | null,
  ) => Promise<ConversationOwnership>;
}

const ERROR_STATUS: Record<TTraceErrorCode, number> = {
  disabled: 404,
  not_found: 404,
  invalid_request: 400,
  rate_limited: 429,
  timeout: 504,
  unauthorized: 502,
  unsupported: 501,
  upstream_error: 502,
};

const ERROR_MESSAGES: Record<TTraceErrorCode, string> = {
  disabled: 'Trace viewer is not enabled',
  not_found: 'Trace not found',
  invalid_request: 'Invalid trace request',
  rate_limited: 'Too many trace requests. Try again shortly.',
  timeout: 'The tracing service did not respond in time',
  unauthorized: 'The tracing service rejected the configured credentials',
  unsupported: 'The tracing service does not support trace reads',
  upstream_error: 'The tracing service could not return this trace',
};

function sendTraceError(res: Response, errorCode: TTraceErrorCode): Response {
  const body: TTraceErrorResponse = { error: ERROR_MESSAGES[errorCode], errorCode };
  return res.status(ERROR_STATUS[errorCode]).json(body);
}

/** Aborts once the client disconnects before the response finished. */
function abortOnDisconnect(res: Response): AbortSignal {
  const controller = new AbortController();
  res.once('close', () => {
    if (!res.writableFinished) {
      controller.abort();
    }
  });
  return controller.signal;
}

/**
 * Ids that reach a Langfuse filter keep a length cap; a message id only names a
 * stored row, which the app persists at any length, so the detail read accepts
 * whatever the list returned.
 */
function isValidId(value: unknown, maxLength = Number.POSITIVE_INFINITY): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function firstQueryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return firstQueryValue(value[0]);
  }
  return typeof value === 'string' ? value : undefined;
}

type ScopeResult = { query: TraceQuery } | { errorCode: TTraceErrorCode };

/** Costs follow `interface.contextCost`, the same switch that shows them in chat. */
function applyCostPolicy(record: TTraceRecord, includeCost: boolean): TTraceRecord {
  if (includeCost || record.cost == null) {
    return record;
  }
  const { cost: _cost, ...withoutCost } = record;
  return withoutCost;
}

/**
 * Trace routes for a user's own conversations. Every response is gated on
 * ownership of the conversation; the reader then narrows the backend's session
 * to the traces that user's responses produced.
 */
export function createTraceHandlers({
  reader,
  getConvoOwnership,
}: TraceHandlerDeps): TraceHandlers {
  function prepareScope(req: TraceRequest, res: Response): ScopeResult {
    const settings = resolveTraceViewerConfig(req.config?.interfaceConfig?.traceViewer);
    if (!settings.enabled) {
      return { errorCode: 'disabled' };
    }

    const userId = req.user?.id ?? req.user?._id?.toString();
    const tenantId = req.user?.tenantId || undefined;
    const { conversationId } = req.params;
    if (!userId) {
      return { errorCode: 'not_found' };
    }
    if (
      !isValidId(conversationId, CONVERSATION_ID_MAX_LENGTH) ||
      conversationId === Constants.NEW_CONVO
    ) {
      return { errorCode: 'invalid_request' };
    }

    return {
      query: {
        userId,
        tenantId,
        conversationId,
        appConfig: req.config,
        settings,
        signal: abortOnDisconnect(res),
      },
    };
  }

  /** Child threads share their parent's session, and reads of them already
   *  answer as missing (see message validation), so they do too here. */
  async function isOwned({ userId, tenantId, conversationId }: TraceQuery): Promise<boolean> {
    const conversation = await getConvoOwnership(userId, conversationId, tenantId ?? null);
    return (
      conversation != null &&
      conversation.user === userId &&
      (conversation.tenantId || undefined) === tenantId &&
      conversation.subagentThread == null
    );
  }

  async function resolveScope(req: TraceRequest, res: Response): Promise<ScopeResult> {
    const scope = prepareScope(req, res);
    if ('errorCode' in scope) {
      return scope;
    }
    return (await isOwned(scope.query)) ? scope : { errorCode: 'not_found' };
  }

  function handleFailure(res: Response, error: unknown, action: string): Response {
    if (res.writableEnded || res.destroyed) {
      return res;
    }
    if (error instanceof TraceReadError) {
      if (error.code !== 'not_found') {
        logger.warn(`[traces] ${action} failed (${error.code}): ${error.message}`);
      }
      return sendTraceError(res, error.code);
    }
    logger.error(
      `[traces] ${action} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return res.status(500).json({ error: 'Internal Server Error', errorCode: 'upstream_error' });
  }

  async function availability(req: TraceRequest, res: Response): Promise<Response> {
    res.set('Cache-Control', 'private, no-store');
    try {
      const scope = prepareScope(req, res);
      if ('errorCode' in scope) {
        return res.status(200).json({ available: false });
      }
      /** Both reads are scoped to the requesting user, so they start together on
       *  the conversation-load path; nothing is answered until ownership holds. */
      const availability = reader.isAvailable(scope.query).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      const [owned, result] = await Promise.all([isOwned(scope.query), availability]);
      if (!owned) {
        return res.status(200).json({ available: false });
      }
      if ('error' in result) {
        throw result.error;
      }
      const body: TTraceAvailability = result.value;
      return res.status(200).json(body);
    } catch (error) {
      return handleFailure(res, error, 'availability');
    }
  }

  async function records(req: TraceRequest, res: Response): Promise<Response> {
    res.set('Cache-Control', 'private, no-store');
    try {
      const scope = await resolveScope(req, res);
      if ('errorCode' in scope) {
        return sendTraceError(res, scope.errorCode);
      }
      const cursor = firstQueryValue(req.query.cursor);
      if (
        cursor != null &&
        (cursor.length === 0 ||
          cursor.length > TRACE_CURSOR_MAX_LENGTH ||
          !CURSOR_PATTERN.test(cursor))
      ) {
        return sendTraceError(res, 'invalid_request');
      }
      const page = await reader.listRecords({ ...scope.query, cursor });
      const includeCost = req.config?.interfaceConfig?.contextCost === true;
      return res.status(200).json({
        ...page,
        records: page.records.map((entry) => applyCostPolicy(entry, includeCost)),
      });
    } catch (error) {
      return handleFailure(res, error, 'records');
    }
  }

  async function record(req: TraceRequest, res: Response): Promise<Response> {
    res.set('Cache-Control', 'private, no-store');
    try {
      const scope = await resolveScope(req, res);
      if ('errorCode' in scope) {
        return sendTraceError(res, scope.errorCode);
      }
      const { recordId } = req.params;
      const sourceId = firstQueryValue(req.query.source);
      const messageId = firstQueryValue(req.query.message);
      if (
        !isValidId(recordId, TRACE_RECORD_ID_MAX_LENGTH) ||
        !isValidId(messageId) ||
        (sourceId != null && !isValidId(sourceId, TRACE_SOURCE_ID_MAX_LENGTH))
      ) {
        return sendTraceError(res, 'invalid_request');
      }
      const detail = await reader.getRecord({ ...scope.query, recordId, messageId, sourceId });
      if (!detail) {
        return sendTraceError(res, 'not_found');
      }
      const includeCost = req.config?.interfaceConfig?.contextCost === true;
      return res
        .status(200)
        .json({ ...detail, record: applyCostPolicy(detail.record, includeCost) });
    } catch (error) {
      return handleFailure(res, error, 'record');
    }
  }

  return {
    availability: toRouteHandler(availability),
    records: toRouteHandler(records),
    record: toRouteHandler(record),
  };
}

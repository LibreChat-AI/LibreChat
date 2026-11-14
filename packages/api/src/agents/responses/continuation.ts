import type { ResponseOwner } from '@librechat/data-schemas';
import type { Request, RequestHandler } from 'express';
import type { StoredForegroundResponseDependencies } from './stored';
import type { ServerRequest } from '~/types/http';
import { validateResponseRequest, sendResponsesErrorResponse } from './service';
import { getSafeErrorMetadata } from '~/utils/errors';
import { storedClientToolCalls } from './stored';
import { responseTenantId } from './scope';

type ContinuationReference = { conversationId: string; parentMessageId: string };
const references = new WeakMap<
  Request,
  ResponseOwner & ContinuationReference & { responseId: string }
>();

/** Reuse the request's admitted reference without sharing content or state across callers. */
export function storedToolContinuationReference(
  req: Request | undefined,
  owner: ResponseOwner,
  responseId?: string,
): ContinuationReference | undefined {
  const reference = req && references.get(req);
  if (
    !reference ||
    reference.userId !== owner.userId ||
    reference.responseId !== responseId ||
    responseTenantId(reference.tenantId) !== responseTenantId(owner.tenantId)
  )
    return undefined;
  return { conversationId: reference.conversationId, parentMessageId: reference.parentMessageId };
}

/** Normalize an owned stored caller-tool batch before either foreground or durable admission. */
export function createStoredToolContinuation(
  deps: Pick<StoredForegroundResponseDependencies, 'getMessage' | 'logger'>,
): RequestHandler {
  return async (req, res, next) => {
    const body: unknown = req.body;
    const validation = validateResponseRequest(body, { deferStoredToolOutputs: true });
    if (!validation.valid || !validation.request)
      return void sendResponsesErrorResponse(
        res,
        400,
        validation.error ?? 'Invalid response request.',
      );
    const request = validation.request;
    const input = request.input;
    if (!request.previous_response_id?.startsWith('resp_')) return next();
    const userId =
      req.user && 'id' in req.user && typeof req.user.id === 'string' ? req.user.id : undefined;
    const missing = () =>
      sendResponsesErrorResponse(
        res,
        404,
        'Response not found.',
        'not_found',
        'response_not_found',
      );
    if (!userId) return void missing();
    try {
      // Resolve the owned response in the authenticated tenant, never by call_id.
      // Conversation/project admission remains authoritative after execution
      // enrollment (or during durable producer admission). Do not duplicate it
      // here or replace its fresh read with a pre-enrollment snapshot.
      const message = await deps.getMessage({
        user: userId,
        messageId: request.previous_response_id,
      });
      if (!message?.conversationId || message.isCreatedByUser || message.isUserSubmitted)
        return void missing();
      const calls = storedClientToolCalls(message);
      const items = typeof input === 'string' ? [] : input;
      const storedCallIds = new Set(calls.map((call) => call.call_id));
      const outputs = new Set(
        items.flatMap((item) => (item.type === 'function_call_output' ? [item.call_id] : [])),
      );
      const replayed = new Map(
        items.flatMap((item) =>
          item.type === 'function_call' ? [[item.call_id, item] as const] : [],
        ),
      );
      for (const call of calls) {
        const replay = replayed.get(call.call_id);
        if (
          !outputs.has(call.call_id) ||
          (replay && (replay.name !== call.name || replay.arguments !== call.arguments))
        )
          return void sendResponsesErrorResponse(
            res,
            400,
            'Provide one result for every pending client tool call without changing the stored calls.',
            'invalid_request',
            'invalid_tool_continuation',
          );
      }
      const normalized = {
        ...request,
        input:
          calls.length === 0
            ? input
            : [
                ...calls,
                ...items.filter(
                  (item) => item.type !== 'function_call' || !storedCallIds.has(item.call_id),
                ),
              ],
      };
      const complete = validateResponseRequest(normalized);
      if (!complete.valid)
        return void sendResponsesErrorResponse(
          res,
          400,
          complete.error ?? 'Invalid tool continuation.',
        );
      req.body = normalized;
      references.set(req, {
        userId,
        tenantId: responseTenantId((req as ServerRequest).user?.tenantId),
        responseId: request.previous_response_id,
        conversationId: message.conversationId,
        parentMessageId: message.messageId,
      });
      return next();
    } catch (error) {
      deps.logger.error(
        '[Responses API] Error resolving client tools',
        getSafeErrorMetadata(error),
      );
      return void sendResponsesErrorResponse(
        res,
        503,
        'Response storage is unavailable. Please try again.',
        'server_error',
        'response_storage_unavailable',
      );
    }
  };
}

import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler, Response as HttpResponse } from 'express';
import type { ResponseOwner, ResponseStorage } from '@librechat/data-schemas';
import type { createBackgroundResponseService, BackgroundResponseResult } from './background';
import type { ServerRequest } from '~/types/http';
import { validateResponseRequest, sendResponsesErrorResponse } from './service';
import { getBackgroundResponseWorkerRecord } from './worker';
import { createAgentRunEnvelope } from '../envelope';

export interface BackgroundResponseHttpDependencies {
  storage: ResponseStorage;
  service: (req: Request) => ReturnType<typeof createBackgroundResponseService>;
  ordinary: { create: RequestHandler; retrieve: RequestHandler };
  onError: (error: unknown) => void;
}

function owner(req: Request): ResponseOwner | null {
  const user = (req as ServerRequest).user;
  return user?.id ? { userId: user.id, tenantId: user.tenantId } : null;
}

function send(res: HttpResponse, result: BackgroundResponseResult, accepted = false): void {
  if (result.ok) return void res.status(accepted ? 202 : 200).json(result.response);
  return void sendResponsesErrorResponse(
    res,
    result.status,
    result.status === 404 ? 'Response not found.' : 'The response request could not be accepted.',
    result.status === 404 ? 'not_found' : 'invalid_request',
    result.code,
  );
}

/** Install behind the existing remote auth, terms, config and feature/Agent permission checks. */
export function createBackgroundResponseHttpHandlers(deps: BackgroundResponseHttpDependencies): {
  create: RequestHandler;
  retrieve: RequestHandler;
  cancel: RequestHandler;
} {
  const unavailable = (res: HttpResponse, error: unknown) => {
    deps.onError(error);
    return void sendResponsesErrorResponse(
      res,
      503,
      'Response service is unavailable.',
      'server_error',
      'response_service_unavailable',
    );
  };
  return {
    create: async (req, res, next) => {
      if (getBackgroundResponseWorkerRecord(req) || req.body?.background !== true)
        return deps.ordinary.create(req, res, next);
      const validation = validateResponseRequest(req.body);
      if (!validation.valid || !validation.request)
        return void sendResponsesErrorResponse(
          res,
          400,
          validation.error ?? 'Invalid response request.',
          'invalid_request',
        );
      const principal = owner(req);
      const key = (req as Request & { apiKeyId?: { toString(): string } }).apiKeyId;
      if (!principal || !key)
        return void sendResponsesErrorResponse(
          res,
          400,
          'Background execution requires an Agent API key.',
          'invalid_request',
          'background_api_key_required',
        );
      const idempotency = req.headers['idempotency-key'];
      if (idempotency != null && typeof idempotency !== 'string')
        return void sendResponsesErrorResponse(
          res,
          400,
          'Invalid Idempotency-Key.',
          'invalid_request',
        );
      try {
        const envelope = createAgentRunEnvelope({
          protocol: 'responses',
          requestId: randomUUID(),
          receivedAt: Date.now(),
          principal: { id: principal.userId, tenantId: principal.tenantId },
          payload: validation.request,
        });
        return send(
          res,
          await deps.service(req).create(envelope, idempotency, key.toString()),
          true,
        );
      } catch (error) {
        return unavailable(res, error);
      }
    },
    retrieve: async (req, res, next) => {
      const principal = owner(req);
      if (!principal)
        return void sendResponsesErrorResponse(res, 401, 'Unauthorized', 'invalid_request');
      try {
        if (!(await deps.storage.read(principal, req.params.id)))
          return deps.ordinary.retrieve(req, res, next);
        return send(res, await deps.service(req).retrieve(principal, req.params.id));
      } catch (error) {
        return unavailable(res, error);
      }
    },
    cancel: async (req, res) => {
      const principal = owner(req);
      if (!principal)
        return void sendResponsesErrorResponse(res, 401, 'Unauthorized', 'invalid_request');
      try {
        return send(res, await deps.service(req).cancel(principal, req.params.id));
      } catch (error) {
        return unavailable(res, error);
      }
    },
  };
}

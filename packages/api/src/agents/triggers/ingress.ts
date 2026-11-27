import { randomUUID } from 'node:crypto';
import { logger } from '@librechat/data-schemas';
import type { Request, RequestHandler, Response } from 'express';
import type {
  AgentFireTarget,
  AgentContinueTarget,
  AgentSteerTarget,
  AgentTriggerEvent,
  AgentTriggerExpectedAction,
  AgentTriggerMode,
} from './envelope';
import type { AgentTriggerEnqueueOptions } from './delivery';
import type { AgentTriggerService } from './service';
import { AgentTriggerEnvelopeError, createAgentTriggerEnvelope } from './envelope';
import { AgentTriggerServiceUnavailableError } from './service';
import { AgentTriggerDeliveryError } from './delivery';

const IDEMPOTENCY_HEADER = 'idempotency-key';
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~:/+=-]+$/;
const DELIVERY_KEY_PATTERN = /^trigger_[a-f0-9]{64}$/;

interface AgentTriggerIngressUser {
  id: string;
  role?: string;
  tenantId?: string;
}

interface AgentTriggerIngressRequest extends Request {
  apiKeyId?: { toString(): string } | string;
  requestId?: string;
  user?: AgentTriggerIngressUser;
  _agentEventBindingResolved?: boolean;
}

interface AgentTriggerIngressBody {
  mode?: AgentTriggerMode;
  event?: AgentTriggerEvent;
  target?: AgentContinueTarget | AgentFireTarget | AgentSteerTarget;
  input?: string;
  orderingKey?: string;
  coalesce?: { key?: string };
  expectedAction?: AgentTriggerExpectedAction;
}

export interface AgentTriggerIngressDependencies {
  enqueue: AgentTriggerService['enqueue'];
  getDeliveryStatus: AgentTriggerService['getDeliveryStatus'];
  now?: () => number;
  createRequestId?: () => string;
}

class AgentTriggerIngressError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'AgentTriggerIngressError';
  }
}

class AgentTriggerAuthenticationError extends Error {
  constructor() {
    super('Authenticated user is required');
    this.name = 'AgentTriggerAuthenticationError';
  }
}

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({
    error: {
      message,
      type: status >= 500 ? 'server_error' : 'invalid_request_error',
      code,
    },
  });
}

function rawHeaderValues(req: Request, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === name) {
      values.push(req.rawHeaders[index + 1] ?? '');
    }
  }
  if (values.length > 0) {
    return values;
  }

  const fallback = req.headers[name];
  if (Array.isArray(fallback)) {
    return fallback;
  }
  return fallback == null ? [] : [fallback];
}

function requireIdempotencyKey(req: Request): string {
  const values = rawHeaderValues(req, IDEMPOTENCY_HEADER);
  if (values.length !== 1) {
    throw new AgentTriggerIngressError('Exactly one Idempotency-Key header is required');
  }
  const key = values[0].trim();
  if (
    key.length === 0 ||
    key.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    !IDEMPOTENCY_KEY_PATTERN.test(key)
  ) {
    throw new AgentTriggerIngressError(
      `Idempotency-Key must contain 1-${MAX_IDEMPOTENCY_KEY_LENGTH} visible token characters`,
    );
  }
  return key;
}

function requireUser(req: AgentTriggerIngressRequest): AgentTriggerIngressUser {
  if (typeof req.user?.id !== 'string' || req.user.id.trim() === '') {
    throw new AgentTriggerAuthenticationError();
  }
  return req.user;
}

function requireSourceKeyId(req: AgentTriggerIngressRequest): string {
  const sourceKeyId = req.apiKeyId?.toString().trim();
  if (sourceKeyId == null || sourceKeyId === '') {
    throw new AgentTriggerAuthenticationError();
  }
  return sourceKeyId;
}

function requireBody(value: object | null | undefined): AgentTriggerIngressBody {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentTriggerIngressError('Event body must be an object');
  }
  return value as AgentTriggerIngressBody;
}

function enqueueOptions(body: AgentTriggerIngressBody): AgentTriggerEnqueueOptions {
  if (body.orderingKey != null && typeof body.orderingKey !== 'string') {
    throw new AgentTriggerIngressError('orderingKey must be a string');
  }
  let coalesce: AgentTriggerEnqueueOptions['coalesce'];
  if (body.coalesce != null) {
    if (typeof body.coalesce !== 'object' || Array.isArray(body.coalesce)) {
      throw new AgentTriggerIngressError('coalesce must be an object');
    }
    if (typeof body.coalesce.key !== 'string') {
      throw new AgentTriggerIngressError('coalesce.key must be a string');
    }
    coalesce = { key: body.coalesce.key };
  }
  return {
    ...(body.orderingKey != null && { orderingKey: body.orderingKey }),
    ...(coalesce != null && { coalesce }),
  };
}

function toPublicDelivery(delivery: Awaited<ReturnType<AgentTriggerService['getDeliveryStatus']>>) {
  if (delivery == null) {
    return null;
  }
  return {
    id: delivery.deliveryKey,
    status: delivery.status,
    attempts: delivery.attempts,
    availableAt: delivery.availableAt.toISOString(),
    createdAt: delivery.createdAt.toISOString(),
    ...(delivery.settledAt != null && { settledAt: delivery.settledAt.toISOString() }),
    ...(delivery.result !== undefined && { result: delivery.result }),
    ...(delivery.lastError != null && {
      error: {
        code: delivery.lastError.code,
        message: delivery.lastError.message,
        certainty: delivery.lastError.certainty,
        retryable: delivery.lastError.retryable,
        attemptedAt: delivery.lastError.attemptedAt.toISOString(),
        ...(delivery.lastError.status != null && { status: delivery.lastError.status }),
      },
    }),
    ...(delivery.handling != null && {
      handling: {
        ...delivery.handling,
        startedAt: delivery.handling.startedAt.toISOString(),
        ...(delivery.handling.settledAt != null && {
          settledAt: delivery.handling.settledAt.toISOString(),
        }),
      },
    }),
  };
}

function handleIngressError(res: Response, error: unknown): void {
  if (error instanceof AgentTriggerAuthenticationError) {
    sendError(res, 401, 'invalid_api_key', error.message);
    return;
  }
  if (
    error instanceof AgentTriggerIngressError ||
    error instanceof AgentTriggerEnvelopeError ||
    error instanceof AgentTriggerDeliveryError
  ) {
    sendError(res, 400, 'invalid_event', error.message);
    return;
  }
  if (error instanceof Error && error.name === 'AgentTriggerDeliveryConflictError') {
    sendError(res, 409, 'idempotency_conflict', error.message);
    return;
  }
  if (error instanceof AgentTriggerServiceUnavailableError) {
    sendError(res, 503, 'trigger_delivery_unavailable', error.message);
    return;
  }
  logger.error('[agent-trigger-ingress] request failed:', error);
  sendError(res, 500, 'internal_error', 'Failed to process agent event');
}

export function createAgentTriggerIngressHandlers(deps: AgentTriggerIngressDependencies): {
  enqueueEvent: RequestHandler;
  getEvent: RequestHandler;
} {
  const now = deps.now ?? Date.now;
  const createRequestId = deps.createRequestId ?? randomUUID;

  const enqueueEvent: RequestHandler = async (baseReq, res) => {
    const req = baseReq as AgentTriggerIngressRequest;
    try {
      const user = requireUser(req);
      const sourceKeyId = requireSourceKeyId(req);
      const body = requireBody(req.body);
      const requestId = req.requestId?.trim() || createRequestId();
      const deliveryId = requireIdempotencyKey(req);
      const receivedAt = now();
      const principal = {
        id: user.id,
        ...(user.role != null && { role: user.role }),
        ...(user.tenantId != null && { tenantId: user.tenantId }),
      };
      const common = {
        requestId,
        deliveryId,
        receivedAt,
        principal,
        event: {
          ...(body.event as AgentTriggerEvent),
          source: { id: sourceKeyId, type: 'remote_api_key' },
        },
        input: body.input as string,
        ...(body.expectedAction != null && { expectedAction: body.expectedAction }),
      };
      if (body.mode === 'continue' && req._agentEventBindingResolved !== true) {
        throw new AgentTriggerIngressError(
          'Continue events require an authenticated agent-event binding',
        );
      }
      let envelope;
      if (body.mode === 'fire') {
        envelope = createAgentTriggerEnvelope({
          ...common,
          mode: 'fire',
          target: body.target as AgentFireTarget,
        });
      } else if (body.mode === 'continue') {
        envelope = createAgentTriggerEnvelope({
          ...common,
          mode: 'continue',
          target: body.target as AgentContinueTarget,
        });
      } else {
        envelope = createAgentTriggerEnvelope({
          ...common,
          mode: 'steer',
          target: body.target as AgentSteerTarget,
        });
      }
      const receipt = await deps.enqueue(envelope, enqueueOptions(body));

      logger.info('[agent-trigger-ingress] delivery accepted', {
        delivery_key: receipt.deliveryKey,
        mode: envelope.mode,
        agent_id: envelope.target.agentId,
        user_id: user.id,
        tenant_id: user.tenantId,
        replayed: receipt.replayed,
      });
      const collectionPath = req.originalUrl.split('?')[0].replace(/\/+$/, '');
      res.setHeader('Location', `${collectionPath}/${encodeURIComponent(receipt.deliveryKey)}`);
      res.status(202).json({
        id: receipt.deliveryKey,
        status: receipt.status,
        availableAt: receipt.availableAt.toISOString(),
        replayed: receipt.replayed,
      });
    } catch (error) {
      handleIngressError(res, error);
    }
  };

  const getEvent: RequestHandler = async (baseReq, res) => {
    const req = baseReq as AgentTriggerIngressRequest;
    try {
      const user = requireUser(req);
      const sourceKeyId = requireSourceKeyId(req);
      const deliveryKey = req.params.id;
      if (!DELIVERY_KEY_PATTERN.test(deliveryKey)) {
        throw new AgentTriggerIngressError('Event delivery id is invalid');
      }
      const delivery = await deps.getDeliveryStatus(
        deliveryKey,
        user.id,
        sourceKeyId,
        user.tenantId,
      );
      if (delivery == null) {
        sendError(res, 404, 'event_not_found', 'Agent event delivery not found');
        return;
      }
      res.status(200).json(toPublicDelivery(delivery));
    } catch (error) {
      handleIngressError(res, error);
    }
  };

  return { enqueueEvent, getEvent };
}

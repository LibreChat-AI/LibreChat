import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Span, Attributes } from '@opentelemetry/api';
import type { NextFunction, Response } from 'express';
import type { ServerRequest } from '~/types';
import {
  createRedisRequestTelemetry,
  finishRedisRequestTelemetry,
  runWithRedisRequestTelemetry,
} from '~/cache/redisTelemetry';
import { getErrorType, getSafeSpanException } from './safeException';
import { getTelemetryRequestSpan } from './sdk';
import { DEFAULT_HEALTH_PATH } from './config';

const CLIENT_CLOSED_REQUEST_STATUS_CODE = 499;

type ExpressErrorValue =
  | Error
  | string
  | number
  | boolean
  | bigint
  | symbol
  | object
  | null
  | undefined;

function getUserId(req: ServerRequest): string | undefined {
  return req.user?.id;
}

function getTenantId(req: ServerRequest): string | undefined {
  return req.user?.tenantId;
}

function isHealthPath(req: ServerRequest): boolean {
  return req.path === DEFAULT_HEALTH_PATH;
}

function isApiPath(req: ServerRequest): boolean {
  return req.path === '/api' || req.path.startsWith('/api/');
}

function getRoutePath(req: ServerRequest): string {
  const routePath = req.route?.path;
  if (typeof routePath === 'string') {
    return `${req.baseUrl}${routePath}`;
  }

  if (isHealthPath(req)) {
    return '/health';
  }

  if (isApiPath(req)) {
    return '/api/*';
  }

  return 'spa_fallback';
}

function setIdentityAttributes(span: Span, req: ServerRequest): void {
  const userId = getUserId(req);
  const tenantId = getTenantId(req);

  if (!userId && !tenantId) {
    return;
  }

  const attributes: Attributes = {};

  if (userId) {
    attributes['enduser.id'] = userId;
  }

  if (tenantId) {
    attributes['librechat.tenant.id'] = tenantId;
  }

  span.setAttributes(attributes);
}

function setCompletionAttributes(
  span: Span,
  req: ServerRequest,
  res: Response,
  aborted = false,
): void {
  const statusCode = aborted ? CLIENT_CLOSED_REQUEST_STATUS_CODE : res.statusCode;
  const routePath = getRoutePath(req);
  const attributes: Attributes = {
    'http.route': routePath,
    'http.response.status_code': statusCode,
  };

  if (aborted) {
    attributes['librechat.request.aborted'] = true;
  }

  setIdentityAttributes(span, req);
  span.setAttributes(attributes);

  if (aborted || statusCode >= 500) {
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
}

export function telemetryMiddleware(req: ServerRequest, res: Response, next: NextFunction): void {
  if (isHealthPath(req)) {
    next();
    return;
  }

  const span = getTelemetryRequestSpan(req) ?? trace.getActiveSpan();
  if (!span) {
    next();
    return;
  }

  span.setAttributes({
    'http.request.method': req.method,
  });
  const redisTelemetry = createRedisRequestTelemetry(span);

  let completed = false;
  const complete = () => {
    if (completed) {
      return;
    }
    completed = true;
    finishRedisRequestTelemetry(redisTelemetry);
    setCompletionAttributes(span, req, res);
  };

  const close = () => {
    if (completed) {
      return;
    }
    completed = true;
    finishRedisRequestTelemetry(redisTelemetry);
    setCompletionAttributes(span, req, res, !res.writableEnded);
  };

  res.once('finish', complete);
  res.once('close', close);
  runWithRedisRequestTelemetry(redisTelemetry, next);
}

export function telemetryErrorMiddleware(
  err: ExpressErrorValue,
  req: ServerRequest,
  _res: Response,
  next: NextFunction,
): void {
  const span = getTelemetryRequestSpan(req) ?? trace.getActiveSpan();
  if (span) {
    const routePath = getRoutePath(req);
    if (err) {
      span.recordException(getSafeSpanException(err));
    }
    span.setStatus({ code: SpanStatusCode.ERROR });
    setIdentityAttributes(span, req);
    span.setAttributes({
      'error.type': getErrorType(err),
      'http.route': routePath,
    });
  }

  next(err);
}

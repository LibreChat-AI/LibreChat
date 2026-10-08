import { ErrorTypes } from 'librechat-data-provider';
import { logger, tenantStorage } from '@librechat/data-schemas';
import type { NextFunction, Request, Response } from 'express';
import type { MongoServerError, ValidationError, CustomError } from '~/types';
import { MCPAuthenticationRefreshError, MCPAuthenticationRejectedError } from '~/mcp/errors';
import { buildTenantIsolationErrorLogContext } from './auth';
import { OpenIDReauthRequiredError } from '~/utils/oidc';

const handleDuplicateKeyError = (err: MongoServerError, res: Response) => {
  logger.warn('Duplicate key error: ' + (err.errmsg || err.message));
  const field = err.keyValue ? `${JSON.stringify(Object.keys(err.keyValue))}` : 'unknown';
  const code = 409;
  res
    .status(code)
    .send({ messages: `An document with that ${field} already exists.`, fields: field });
};

const handleValidationError = (err: ValidationError, res: Response) => {
  logger.error('Validation error:', err.errors);
  const errorMessages = Object.values(err.errors).map((el) => el.message);
  const fields = `${JSON.stringify(Object.values(err.errors).map((el) => el.path))}`;
  const code = 400;
  const messages =
    errorMessages.length > 1
      ? `${JSON.stringify(errorMessages.join(' '))}`
      : `${JSON.stringify(errorMessages)}`;

  res.status(code).send({ messages, fields });
};

/** Type guard for ValidationError */
function isValidationError(err: unknown): err is ValidationError {
  return err !== null && typeof err === 'object' && 'name' in err && err.name === 'ValidationError';
}

/** Type guard for MongoServerError (duplicate key) */
function isMongoServerError(err: unknown): err is MongoServerError {
  return err !== null && typeof err === 'object' && 'code' in err && err.code === 11000;
}

/** Type guard for CustomError with statusCode and body */
function isCustomError(err: unknown): err is CustomError {
  return err !== null && typeof err === 'object' && 'statusCode' in err && 'body' in err;
}

/**
 * Builds an error that `ErrorController` relays to the client verbatim. `isCustomError` matches only
 * when both `statusCode` and `body` are present, so a plain `Error` falls through to a bare 500 and
 * its message never leaves the server log. Use this wherever the caller needs to see the reason.
 */
export const createCustomError = (statusCode: number, message: string): CustomError => {
  const error = new Error(message) as CustomError;
  error.statusCode = statusCode;
  error.body = { message };
  return error;
};

export const ErrorController = (
  err: Error | CustomError,
  req: Request,
  res: Response,
  next: NextFunction,
): Response | void => {
  try {
    if (!err) {
      return next();
    }
    const error = err as CustomError;

    if (
      (error.message === ErrorTypes.AUTH_FAILED || error.code === ErrorTypes.AUTH_FAILED) &&
      req.originalUrl &&
      req.originalUrl.includes('/oauth/') &&
      req.originalUrl.includes('/callback')
    ) {
      const domain = process.env.DOMAIN_CLIENT || 'http://localhost:3080';
      return res.redirect(`${domain}/login?redirect=false&error=${ErrorTypes.AUTH_FAILED}`);
    }

    if (isValidationError(error)) {
      return handleValidationError(error, res);
    }

    if (isMongoServerError(error)) {
      return handleDuplicateKeyError(error, res);
    }

    if (err instanceof OpenIDReauthRequiredError) {
      logger.warn('OpenID re-authentication required: ' + err.message);
      return res.status(401).send({ error: 'invalid_token', message: err.message });
    }

    if (err instanceof MCPAuthenticationRejectedError) {
      logger.warn('MCP bearer authentication rejected: ' + err.message);
      /** A remote credential rejection must not trigger the client's app-JWT retry interceptor. */
      return res.status(err.statusCode).send({
        error: 'invalid_token',
        code: err.code,
        message: err.message,
        retryable: err.retryable,
        connectionRefreshed: err.connectionRefreshed,
      });
    }

    if (err instanceof MCPAuthenticationRefreshError) {
      logger.warn('MCP bearer refresh temporarily unavailable: ' + err.message);
      return res.status(err.statusCode).send({
        code: err.code,
        message: err.message,
        retryable: err.retryable,
      });
    }

    if (isCustomError(error) && error.statusCode && error.body) {
      return res.status(error.statusCode).send(error.body);
    }

    const tenantIsolationContext = buildTenantIsolationErrorLogContext(req, err);
    if (tenantIsolationContext) {
      const { requestId, requestMethod, requestPath } = tenantStorage.getStore() ?? {};
      logger.error({
        message: 'Tenant-isolation request failed',
        ...tenantIsolationContext,
        ...(requestId && { request_id: requestId }),
        ...(requestMethod && { request_method: requestMethod }),
        ...(requestPath && { request_path: requestPath }),
      });
    } else {
      logger.error('ErrorController => error', err);
    }
    return res.status(500).send('An unknown error occurred.');
  } catch (processingError) {
    logger.error('ErrorController => processing error', processingError);
    return res.status(500).send('Processing error in ErrorController.');
  }
};

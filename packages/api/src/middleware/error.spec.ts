import { logger, tenantStorage } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { ValidationError, MongoServerError, CustomError } from '~/types';
import { MCPAuthenticationRefreshError, MCPAuthenticationRejectedError } from '~/mcp/errors';
import { ErrorController, createCustomError } from './error';
import { OpenIDReauthRequiredError } from '~/utils/oidc';

// Mock the logger
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

describe('ErrorController', () => {
  let mockReq: Request;
  let mockRes: Response;
  let mockNext: jest.Mock;

  beforeEach(() => {
    mockReq = {
      originalUrl: '',
    } as Request;
    mockRes = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn(),
    } as unknown as Response;
    (logger.error as jest.Mock).mockClear();
    mockNext = jest.fn();
  });

  describe('ValidationError handling', () => {
    it('should handle ValidationError with single error', () => {
      const validationError = {
        name: 'ValidationError',
        message: 'Validation error',
        errors: {
          email: { message: 'Email is required', path: 'email' },
        },
      } as ValidationError;

      ErrorController(validationError, mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.send).toHaveBeenCalledWith({
        messages: '["Email is required"]',
        fields: '["email"]',
      });
      expect(logger.error).toHaveBeenCalledWith('Validation error:', validationError.errors);
    });

    it('should handle ValidationError with multiple errors', () => {
      const validationError = {
        name: 'ValidationError',
        message: 'Validation error',
        errors: {
          email: { message: 'Email is required', path: 'email' },
          password: { message: 'Password is required', path: 'password' },
        },
      } as ValidationError;

      ErrorController(validationError, mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.send).toHaveBeenCalledWith({
        messages: '"Email is required Password is required"',
        fields: '["email","password"]',
      });
      expect(logger.error).toHaveBeenCalledWith('Validation error:', validationError.errors);
    });

    it('should handle ValidationError with empty errors object', () => {
      const validationError = {
        name: 'ValidationError',
        errors: {},
      } as ValidationError;

      ErrorController(validationError, mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.send).toHaveBeenCalledWith({
        messages: '[]',
        fields: '[]',
      });
    });
  });

  describe('Duplicate key error handling', () => {
    it('should handle duplicate key error (code 11000)', () => {
      const duplicateKeyError = {
        name: 'MongoServerError',
        message: 'Duplicate key error',
        code: 11000,
        keyValue: { email: 'test@example.com' },
        errmsg:
          'E11000 duplicate key error collection: test.users index: email_1 dup key: { email: "test@example.com" }',
      } as MongoServerError;

      ErrorController(duplicateKeyError, mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(409);
      expect(mockRes.send).toHaveBeenCalledWith({
        messages: 'An document with that ["email"] already exists.',
        fields: '["email"]',
      });
      expect(logger.warn).toHaveBeenCalledWith(
        'Duplicate key error: E11000 duplicate key error collection: test.users index: email_1 dup key: { email: "test@example.com" }',
      );
    });

    it('should handle duplicate key error with multiple fields', () => {
      const duplicateKeyError = {
        name: 'MongoServerError',
        message: 'Duplicate key error',
        code: 11000,
        keyValue: { email: 'test@example.com', username: 'testuser' },
        errmsg:
          'E11000 duplicate key error collection: test.users index: email_1 dup key: { email: "test@example.com" }',
      } as MongoServerError;

      ErrorController(duplicateKeyError, mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(409);
      expect(mockRes.send).toHaveBeenCalledWith({
        messages: 'An document with that ["email","username"] already exists.',
        fields: '["email","username"]',
      });
      expect(logger.warn).toHaveBeenCalledWith(
        'Duplicate key error: E11000 duplicate key error collection: test.users index: email_1 dup key: { email: "test@example.com" }',
      );
    });

    it('should handle error with code 11000 as string', () => {
      const duplicateKeyError = {
        name: 'MongoServerError',
        message: 'Duplicate key error',
        code: 11000,
        keyValue: { email: 'test@example.com' },
        errmsg:
          'E11000 duplicate key error collection: test.users index: email_1 dup key: { email: "test@example.com" }',
      } as MongoServerError;

      ErrorController(duplicateKeyError, mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(409);
      expect(mockRes.send).toHaveBeenCalledWith({
        messages: 'An document with that ["email"] already exists.',
        fields: '["email"]',
      });
    });
  });

  describe('SyntaxError handling', () => {
    it('should handle errors with statusCode and body', () => {
      const syntaxError = {
        statusCode: 400,
        body: 'Invalid JSON syntax',
      } as CustomError;

      ErrorController(syntaxError, mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.send).toHaveBeenCalledWith('Invalid JSON syntax');
    });

    it('should handle errors with different statusCode and body', () => {
      const customError = {
        statusCode: 422,
        body: { error: 'Unprocessable entity' },
      } as CustomError;

      ErrorController(customError, mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(422);
      expect(mockRes.send).toHaveBeenCalledWith({ error: 'Unprocessable entity' });
    });

    it('should handle error with statusCode but no body', () => {
      const partialError = {
        statusCode: 400,
      } as CustomError;

      ErrorController(partialError, mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.send).toHaveBeenCalledWith('An unknown error occurred.');
    });

    it('should handle error with body but no statusCode', () => {
      const partialError = {
        body: 'Some error message',
      } as CustomError;

      ErrorController(partialError, mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.send).toHaveBeenCalledWith('An unknown error occurred.');
    });
  });

  describe('createCustomError', () => {
    it('should build an Error carrying the status and a message body', () => {
      const error = createCustomError(415, 'Unsupported file type: application/x-shellscript');

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('Unsupported file type: application/x-shellscript');
      expect(error.statusCode).toBe(415);
      expect(error.body).toEqual({ message: 'Unsupported file type: application/x-shellscript' });
    });

    it('should reach the client through ErrorController instead of a bare 500', () => {
      ErrorController(createCustomError(415, 'Unsupported file type'), mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(415);
      expect(mockRes.send).toHaveBeenCalledWith({ message: 'Unsupported file type' });
    });

    it('should be the piece a plain Error lacks, which falls through to 500', () => {
      ErrorController(new Error('Unsupported file type'), mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.send).toHaveBeenCalledWith('An unknown error occurred.');
    });
  });

  describe('OpenIDReauthRequiredError handling', () => {
    it('should map a re-auth error to a 401 carrying the actionable message', () => {
      const error = new OpenIDReauthRequiredError(
        'OpenID token is expired or unavailable; re-authentication is required to resolve {{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
      );

      ErrorController(error, mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.send).toHaveBeenCalledWith({
        error: 'invalid_token',
        message:
          'OpenID token is expired or unavailable; re-authentication is required to resolve {{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
      });
    });

    it('should carry a 401 statusCode for callers that read the status directly', () => {
      expect(new OpenIDReauthRequiredError('re-auth').statusCode).toBe(401);
    });

    it('should not fall through to the bare 500 path', () => {
      ErrorController(new OpenIDReauthRequiredError('re-auth'), mockReq, mockRes, mockNext);

      expect(mockRes.status).not.toHaveBeenCalledWith(500);
      expect(mockRes.send).not.toHaveBeenCalledWith('An unknown error occurred.');
    });
  });

  describe('MCPAuthenticationRejectedError handling', () => {
    it('projects rejection without triggering the app-auth 401 retry interceptor', () => {
      const error = new MCPAuthenticationRejectedError('private-mcp', true);

      ErrorController(error, mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(error.statusCode).toBe(403);
      expect(mockRes.send).toHaveBeenCalledWith({
        error: 'invalid_token',
        code: 'MCP_AUTHENTICATION_REJECTED',
        message: error.message,
        retryable: true,
        connectionRefreshed: true,
      });
    });
  });

  describe('MCPAuthenticationRefreshError handling', () => {
    it('returns a retryable service-unavailable response', () => {
      const error = new MCPAuthenticationRefreshError(new Error('identity provider unavailable'));

      ErrorController(error, mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(503);
      expect(mockRes.send).toHaveBeenCalledWith({
        code: 'MCP_AUTHENTICATION_REFRESH_FAILED',
        message: error.message,
        retryable: true,
      });
    });
  });

  describe('Unknown error handling', () => {
    it('should handle unknown errors', () => {
      const unknownError = new Error('Some unknown error');

      ErrorController(unknownError, mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.send).toHaveBeenCalledWith('An unknown error occurred.');
      expect(logger.error).toHaveBeenCalledWith('ErrorController => error', unknownError);
    });

    it('should handle errors with code other than 11000', () => {
      const mongoError = {
        code: 11100,
        message: 'Some MongoDB error',
      } as MongoServerError;

      ErrorController(mongoError, mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.send).toHaveBeenCalledWith('An unknown error occurred.');
      expect(logger.error).toHaveBeenCalledWith('ErrorController => error', mongoError);
    });

    it('should handle generic errors', () => {
      const genericError = new Error('Test error');

      ErrorController(genericError, mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.send).toHaveBeenCalledWith('An unknown error occurred.');
      expect(logger.error).toHaveBeenCalledWith('ErrorController => error', genericError);
    });

    it('emits a structured, joinable event for tenant-isolation errors', () => {
      Object.assign(mockReq, {
        id: 'request-123',
        method: 'GET',
        originalUrl: '/api/banner?access_token=secret-token',
      });
      const tenantError = new Error(
        '[TenantIsolation] Query attempted without tenant context in strict mode',
      );

      ErrorController(tenantError, mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(logger.error).toHaveBeenCalledWith({
        message: 'Tenant-isolation request failed',
        event_name: 'tenant_isolation_error',
        error_category: 'tenant_isolation',
        error_signature: 'missing_query_context',
        response_status: 500,
        request_id: 'request-123',
        request_method: 'GET',
        request_path: '/api/banner',
      });
      expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('secret-token');
    });

    it('preserves the captured router mount for tenant-isolation errors', () => {
      Object.assign(mockReq, {
        id: 'request-123',
        method: 'GET',
        baseUrl: '/api',
        route: { path: '/:id' },
        originalUrl: '/api/convos/conversation-123?access_token=secret-token',
      });
      const tenantError = new Error(
        '[TenantIsolation] Query attempted without tenant context in strict mode',
      );

      tenantStorage.run(
        {
          requestId: 'request-123',
          requestMethod: 'GET',
          requestPath: '/api/convos',
        },
        () => ErrorController(tenantError, mockReq, mockRes, mockNext),
      );

      expect(logger.error).toHaveBeenCalledWith({
        message: 'Tenant-isolation request failed',
        event_name: 'tenant_isolation_error',
        error_category: 'tenant_isolation',
        error_signature: 'missing_query_context',
        response_status: 500,
        request_id: 'request-123',
        request_method: 'GET',
        request_path: '/api/convos',
      });
      expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain(
        'conversation-123',
      );
      expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('secret-token');
    });
  });

  describe('Catch block handling', () => {
    beforeEach(() => {
      // Restore logger mock to normal behavior for these tests
      (logger.error as jest.Mock).mockRestore();
      (logger.error as jest.Mock) = jest.fn();
    });

    it('should handle errors when logger.error throws', () => {
      // Create fresh mocks for this test
      const freshMockRes = {
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
      } as unknown as Response;

      // Mock logger to throw on the first call, succeed on the second
      (logger.error as jest.Mock)
        .mockImplementationOnce(() => {
          throw new Error('Logger error');
        })
        .mockImplementation(() => {});

      const testError = new Error('Test error');

      ErrorController(testError, mockReq, freshMockRes, mockNext);

      expect(freshMockRes.status).toHaveBeenCalledWith(500);
      expect(freshMockRes.send).toHaveBeenCalledWith('Processing error in ErrorController.');
      expect(logger.error).toHaveBeenCalledTimes(2);
    });
  });
});

import { logger } from '@librechat/data-schemas';
import { SystemRoles } from 'librechat-data-provider';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { requireAdmin } from './admin';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('requireAdmin middleware', () => {
  let mockReq: Partial<ServerRequest>;
  let mockRes: Partial<Response>;
  let mockNext: jest.Mock;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;

  beforeEach(() => {
    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnValue({ json: jsonMock });

    mockReq = {};
    mockRes = {
      status: statusMock,
    };
    mockNext = jest.fn();

    (logger.warn as jest.Mock).mockClear();
    (logger.debug as jest.Mock).mockClear();
  });

  describe('when no user is present', () => {
    it('should return 401 with AUTHENTICATION_REQUIRED error', () => {
      requireAdmin(mockReq as ServerRequest, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith({
        error: 'Authentication required',
        error_code: 'AUTHENTICATION_REQUIRED',
      });
      expect(mockNext).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith('[requireAdmin] No user found in request');
    });

    it('should return 401 when user is undefined', () => {
      mockReq.user = undefined;

      requireAdmin(mockReq as ServerRequest, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith({
        error: 'Authentication required',
        error_code: 'AUTHENTICATION_REQUIRED',
      });
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe('when user does not have admin role', () => {
    it('should return 403 when user has no role property', () => {
      mockReq.user = { id: 'user-123', email: 'user@test.com' } as ServerRequest['user'];

      requireAdmin(mockReq as ServerRequest, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(403);
      expect(jsonMock).toHaveBeenCalledWith({
        error: 'Access denied: Admin privileges required',
        error_code: 'ADMIN_REQUIRED',
      });
      expect(mockNext).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        '[requireAdmin] Access denied for non-admin user: user-123',
      );
      expect(JSON.stringify((logger.debug as jest.Mock).mock.calls)).not.toContain('user@test.com');
    });

    it('should return 403 when user has USER role', () => {
      mockReq.user = {
        email: 'user@test.com',
        role: SystemRoles.USER,
      } as ServerRequest['user'];

      requireAdmin(mockReq as ServerRequest, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(403);
      expect(jsonMock).toHaveBeenCalledWith({
        error: 'Access denied: Admin privileges required',
        error_code: 'ADMIN_REQUIRED',
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 403 when user has empty string role', () => {
      mockReq.user = {
        email: 'user@test.com',
        role: '',
      } as ServerRequest['user'];

      requireAdmin(mockReq as ServerRequest, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(403);
      expect(jsonMock).toHaveBeenCalledWith({
        error: 'Access denied: Admin privileges required',
        error_code: 'ADMIN_REQUIRED',
      });
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe('when user has admin role', () => {
    it('should call next() and not send response', () => {
      mockReq.user = {
        email: 'admin@test.com',
        role: SystemRoles.ADMIN,
      } as ServerRequest['user'];

      requireAdmin(mockReq as ServerRequest, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledTimes(1);
      expect(mockNext).toHaveBeenCalledWith();
      expect(statusMock).not.toHaveBeenCalled();
      expect(jsonMock).not.toHaveBeenCalled();
    });

    it('should not log any warnings or debug messages for admin users', () => {
      mockReq.user = {
        email: 'admin@test.com',
        role: SystemRoles.ADMIN,
      } as ServerRequest['user'];

      requireAdmin(mockReq as ServerRequest, mockRes as Response, mockNext);

      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.debug).not.toHaveBeenCalled();
    });
  });
});

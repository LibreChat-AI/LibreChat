import { Types } from 'mongoose';
import { TWO_FACTOR_ENROLLMENT_REQUIRED_CODE } from 'librechat-data-provider';
import type { NextFunction, Response } from 'express';
import type { ApiKeyAuthDependencies } from './middleware';
import type { ApiKeyAuthRequest } from './middleware';
import { createRequireApiKeyAuth } from './middleware';

function createResponse(): {
  res: Response;
  status: jest.Mock;
  json: jest.Mock;
} {
  const status = jest.fn();
  const json = jest.fn();
  const res = { status, json } as unknown as Response;
  status.mockReturnValue(res);
  return { res, status, json };
}

function createRequest(): ApiKeyAuthRequest {
  return {
    headers: { authorization: 'Bearer lc-key' },
  } as ApiKeyAuthRequest;
}

describe('remote Agent API key authentication', () => {
  describe('bound grants', () => {
    const binding = { kind: 'test-grant', id: 'grant-1' };
    function fixture(authorizeBinding?: ApiKeyAuthDependencies['authorizeBinding']) {
      const userId = new Types.ObjectId();
      const keyId = new Types.ObjectId();
      const user = { _id: userId, provider: 'openid' };
      const deps: ApiKeyAuthDependencies = {
        validateAgentApiKey: jest.fn().mockResolvedValue({ userId, keyId, binding }),
        findUser: jest.fn().mockResolvedValue(user),
        isPrincipalActive: jest.fn().mockResolvedValue(true),
        authorizeBinding,
      };
      return { deps, user, userId, keyId };
    }

    it.each(['missing', 'unknown'] as const)('denies a %s grant handler', async (handler) => {
      const authorize = handler === 'unknown' ? jest.fn().mockResolvedValue(false) : undefined;
      const { deps } = fixture(authorize);
      const req = createRequest();
      const { res, status, json } = createResponse();
      const next = jest.fn();

      await createRequireApiKeyAuth(deps)(req, res, next);

      expect(status).toHaveBeenCalledWith(403);
      expect(json).toHaveBeenCalledWith({
        error: {
          message: 'API key authority is unavailable',
          type: 'permission_error',
          code: 'api_key_authority_changed',
        },
      });
      expect(req.user).toBeUndefined();
      expect(req.apiKeyId).toBeUndefined();
      expect(next).not.toHaveBeenCalled();
    });

    it('admits only after the handler authorizes the exact key, grant, user and request', async () => {
      const authorize = jest.fn().mockResolvedValue(true);
      const { deps, user, userId, keyId } = fixture(authorize);
      const req = createRequest();
      const { res, status } = createResponse();
      const next = jest.fn();

      await createRequireApiKeyAuth(deps)(req, res, next);

      expect(authorize).toHaveBeenCalledTimes(1);
      expect(authorize).toHaveBeenCalledWith({ keyId: String(keyId), binding, user, request: req });
      expect(req.user?.id).toBe(String(userId));
      expect(req.apiKeyId).toEqual(keyId);
      expect(next).toHaveBeenCalledTimes(1);
      expect(status).not.toHaveBeenCalled();
    });

    it('does not apply the grant handler to ordinary personal keys', async () => {
      const authorize = jest.fn().mockResolvedValue(false);
      const { deps, userId, keyId } = fixture(authorize);
      deps.validateAgentApiKey = jest.fn().mockResolvedValue({ userId, keyId });
      const { res } = createResponse();
      const next = jest.fn();

      await createRequireApiKeyAuth(deps)(createRequest(), res, next);

      expect(authorize).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('maps a grant lookup outage to a sanitized server error without authenticating', async () => {
      const { deps } = fixture(jest.fn().mockRejectedValue(new Error('private database details')));
      const req = createRequest();
      const { res, status, json } = createResponse();
      const next = jest.fn();

      await createRequireApiKeyAuth(deps)(req, res, next);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({
        error: {
          message: 'Internal server error during authentication',
          type: 'server_error',
          code: 'internal_error',
        },
      });
      expect(req.user).toBeUndefined();
      expect(req.apiKeyId).toBeUndefined();
      expect(next).not.toHaveBeenCalled();
    });
  });

  it('rejects a valid key while account deletion is fenced', async () => {
    const userId = new Types.ObjectId();
    const middleware = createRequireApiKeyAuth({
      validateAgentApiKey: jest.fn().mockResolvedValue({
        userId,
        keyId: new Types.ObjectId(),
      }),
      findUser: jest.fn().mockResolvedValue({ _id: userId }),
      isPrincipalActive: jest.fn().mockResolvedValue(false),
    });
    const { res, status, json } = createResponse();
    const next = jest.fn() as NextFunction;

    await middleware(createRequest(), res, next);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({
      error: {
        message: 'Account deletion is in progress',
        type: 'invalid_request_error',
        code: 'account_deletion_in_progress',
      },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('admits an active principal', async () => {
    const userId = new Types.ObjectId();
    const middleware = createRequireApiKeyAuth({
      validateAgentApiKey: jest.fn().mockResolvedValue({
        userId,
        keyId: new Types.ObjectId(),
      }),
      findUser: jest.fn().mockResolvedValue({ _id: userId }),
      isPrincipalActive: jest.fn().mockResolvedValue(true),
    });
    const req = createRequest();
    const { res } = createResponse();
    const next = jest.fn() as NextFunction;

    await middleware(req, res, next);

    expect(req.user?.id).toBe(userId.toString());
    expect(next).toHaveBeenCalledWith();
  });

  describe('under required two-factor enforcement', () => {
    const original = process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;
    beforeEach(() => {
      process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'true';
    });
    afterEach(() => {
      if (original === undefined) {
        delete process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;
      } else {
        process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = original;
      }
    });

    const authenticate = async (owner: Record<string, unknown>) => {
      const userId = new Types.ObjectId();
      const middleware = createRequireApiKeyAuth({
        validateAgentApiKey: jest.fn().mockResolvedValue({ userId, keyId: new Types.ObjectId() }),
        findUser: jest.fn().mockResolvedValue({ _id: userId, ...owner }),
        isPrincipalActive: jest.fn().mockResolvedValue(true),
      });
      const req = createRequest();
      const response = createResponse();
      const next = jest.fn() as NextFunction;
      await middleware(req, response.res, next);
      return { req, next, ...response };
    };

    it('refuses a key whose local owner has not enrolled', async () => {
      const { req, next, status, json } = await authenticate({ provider: 'local' });

      expect(status).toHaveBeenCalledWith(403);
      expect(json).toHaveBeenCalledWith({
        error: expect.objectContaining({ code: TWO_FACTOR_ENROLLMENT_REQUIRED_CODE }),
      });
      expect(req.user).toBeUndefined();
      expect(next).not.toHaveBeenCalled();
    });

    it('admits a key whose owner has enrolled', async () => {
      const { next } = await authenticate({ provider: 'local', twoFactorEnabled: true });

      expect(next).toHaveBeenCalledWith();
    });

    it('admits a key whose owner signs in through a federated provider', async () => {
      const { next } = await authenticate({ provider: 'openid' });

      expect(next).toHaveBeenCalledWith();
    });
  });

  it('starts the user and deletion-fence reads together', async () => {
    const userId = new Types.ObjectId();
    let resolveUser!: (user: { _id: Types.ObjectId }) => void;
    const user = new Promise<{ _id: Types.ObjectId }>((resolve) => {
      resolveUser = resolve;
    });
    const findUser = jest.fn().mockReturnValue(user);
    const isPrincipalActive = jest.fn().mockResolvedValue(true);
    const middleware = createRequireApiKeyAuth({
      validateAgentApiKey: jest.fn().mockResolvedValue({
        userId,
        keyId: new Types.ObjectId(),
      }),
      findUser,
      isPrincipalActive,
    });
    const { res } = createResponse();
    const next = jest.fn() as NextFunction;

    const authentication = middleware(createRequest(), res, next);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(findUser).toHaveBeenCalledTimes(1);
    expect(isPrincipalActive).toHaveBeenCalledWith(userId.toString());
    expect(next).not.toHaveBeenCalled();

    resolveUser({ _id: userId });
    await authentication;
    expect(next).toHaveBeenCalledWith();
  });

  it('answers a failed key lookup with a server error, not an invalid key', async () => {
    const middleware = createRequireApiKeyAuth({
      validateAgentApiKey: jest.fn().mockRejectedValue(new Error('connection reset')),
      findUser: jest.fn(),
      isPrincipalActive: jest.fn(),
    });
    const { res, status, json } = createResponse();
    const next = jest.fn() as NextFunction;

    await middleware(createRequest(), res, next);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'internal_error' }) }),
    );
    expect(next).not.toHaveBeenCalled();
  });
});

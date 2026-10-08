const jwt = require('jsonwebtoken');
const { createHash } = require('node:crypto');
const createValidateImageRequest = require('~/server/middleware/validateImageRequest');

// Mock only isEnabled, keep getBasePath real so it reads process.env.DOMAIN_CLIENT
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  isEnabled: jest.fn(),
}));
jest.mock('~/models', () => ({
  findSession: jest.fn(),
  getAgent: jest.fn(),
  getAssistant: jest.fn(),
  getUserById: jest.fn(),
  getUserPrincipals: jest.fn(),
  hasCapabilityForPrincipals: jest.fn(),
  hasPermission: jest.fn(),
}));
jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn(),
}));

const { isEnabled } = require('@librechat/api');
const {
  findSession,
  getAgent,
  getAssistant,
  getUserById,
  getUserPrincipals,
  hasCapabilityForPrincipals,
  hasPermission,
} = require('~/models');
const { getAppConfig } = require('~/server/services/Config');

describe('validateImageRequest middleware', () => {
  let req, res, next, validateImageRequest;
  const validObjectId = '65cfb246f7ecadb8b1e8036b';

  beforeEach(() => {
    jest.clearAllMocks();
    req = {
      headers: {},
      originalUrl: '',
    };
    res = {
      locals: {},
      status: jest.fn().mockReturnThis(),
      send: jest.fn(),
    };
    next = jest.fn();
    process.env.JWT_REFRESH_SECRET = 'test-secret';
    process.env.OPENID_REUSE_TOKENS = 'false';
    delete process.env.DOMAIN_CLIENT; // Clear for tests without basePath

    // Default: OpenID token reuse disabled
    isEnabled.mockReturnValue(false);
    getAgent.mockResolvedValue(null);
    getAssistant.mockResolvedValue(null);
    getAppConfig.mockResolvedValue({ endpoints: {} });
    getUserById.mockResolvedValue({ role: 'USER', tenantId: 'tenant-a', idOnTheSource: null });
    findSession.mockResolvedValue({ _id: 'session' });
    getUserPrincipals.mockResolvedValue([{ principalType: 'user', principalId: validObjectId }]);
    hasCapabilityForPrincipals.mockResolvedValue(false);
    hasPermission.mockResolvedValue(false);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Factory function', () => {
    test('should return a pass-through middleware if secureImageLinks is false', async () => {
      const middleware = createValidateImageRequest(false);
      await middleware(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    test('should protect images when secureImageLinks is omitted', async () => {
      validateImageRequest = createValidateImageRequest();
      await validateImageRequest(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.send).toHaveBeenCalledWith('Unauthorized');
    });

    test('should honor an owner-scoped setting that disables image protection', async () => {
      getAppConfig.mockResolvedValue({ secureImageLinks: false, endpoints: {} });
      req.originalUrl = '/images/65cfb246f7ecadb8b1e8036c/example.jpg';
      const middleware = createValidateImageRequest({ secureImageLinks: true });

      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.locals.privateImageCache).toBeUndefined();
    });

    test('should honor an owner-scoped setting that enables image protection', async () => {
      getAppConfig.mockResolvedValue({ secureImageLinks: true, endpoints: {} });
      req.originalUrl = '/images/65cfb246f7ecadb8b1e8036c/example.jpg';
      const middleware = createValidateImageRequest({ secureImageLinks: false });

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.locals.privateImageCache).toBe(true);
    });

    test('should use the disabled fallback for an image without an owner layout', async () => {
      req.originalUrl = '/images/logo.png';
      const middleware = createValidateImageRequest({ secureImageLinks: false });

      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(getAppConfig).not.toHaveBeenCalled();
    });

    test('should use the disabled fallback when the path owner no longer exists', async () => {
      getUserById.mockResolvedValue(null);
      req.originalUrl = '/images/65cfb246f7ecadb8b1e8036c/orphaned.png';
      const middleware = createValidateImageRequest({ secureImageLinks: false });

      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(getAppConfig).not.toHaveBeenCalled();
    });

    test('should normalize repeated separators before applying a disabled fallback', async () => {
      getAppConfig.mockResolvedValue({ secureImageLinks: true, endpoints: {} });
      req.originalUrl = '/images//65cfb246f7ecadb8b1e8036c/private.png';
      const middleware = createValidateImageRequest({ secureImageLinks: false });

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(getAppConfig).toHaveBeenCalledTimes(1);
    });
  });

  describe('Standard LibreChat token flow', () => {
    beforeEach(() => {
      validateImageRequest = createValidateImageRequest(true);
    });

    test('should return 401 if refresh token is not provided', async () => {
      await validateImageRequest(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.send).toHaveBeenCalledWith('Unauthorized');
    });

    test('should return 403 if refresh token is invalid', async () => {
      req.headers.cookie = 'refreshToken=invalid-token';
      await validateImageRequest(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.send).toHaveBeenCalledWith('Access Denied');
    });

    test('should return 403 if refresh token is expired', async () => {
      const expiredToken = jwt.sign(
        { id: validObjectId, exp: Math.floor(Date.now() / 1000) - 3600 },
        process.env.JWT_REFRESH_SECRET,
      );
      req.headers.cookie = `refreshToken=${expiredToken}`;
      await validateImageRequest(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.send).toHaveBeenCalledWith('Access Denied');
    });

    test('should call next() for valid image path', async () => {
      const validToken = jwt.sign(
        { id: validObjectId, exp: Math.floor(Date.now() / 1000) + 3600 },
        process.env.JWT_REFRESH_SECRET,
      );
      req.headers.cookie = `refreshToken=${validToken}`;
      req.originalUrl = `/images/${validObjectId}/example.jpg`;
      await validateImageRequest(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('should reject a valid refresh token after its session is revoked', async () => {
      const validToken = jwt.sign(
        { id: validObjectId, exp: Math.floor(Date.now() / 1000) + 3600 },
        process.env.JWT_REFRESH_SECRET,
      );
      findSession.mockResolvedValue(null);
      req.headers.cookie = `refreshToken=${validToken}`;
      req.originalUrl = `/images/${validObjectId}/example.jpg`;

      await validateImageRequest(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    test('should return 403 for invalid image path', async () => {
      const validToken = jwt.sign(
        { id: validObjectId, exp: Math.floor(Date.now() / 1000) + 3600 },
        process.env.JWT_REFRESH_SECRET,
      );
      req.headers.cookie = `refreshToken=${validToken}`;
      req.originalUrl = '/images/65cfb246f7ecadb8b1e8036c/example.jpg'; // Different ObjectId
      await validateImageRequest(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.send).toHaveBeenCalledWith('Access Denied');
    });

    test('should allow an agent avatar when the user has VIEW access', async () => {
      const validToken = jwt.sign(
        { id: validObjectId, exp: Math.floor(Date.now() / 1000) + 3600 },
        process.env.JWT_REFRESH_SECRET,
      );
      req.headers.cookie = `refreshToken=${validToken}`;
      req.originalUrl = '/images/65cfb246f7ecadb8b1e8036c/agent-agent_abc123-avatar-12345.png';
      getAgent.mockResolvedValue({ _id: '65cfb246f7ecadb8b1e8036c' });
      hasPermission.mockResolvedValue(true);
      await validateImageRequest(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(getUserPrincipals).toHaveBeenCalledTimes(1);
      expect(hasPermission).toHaveBeenLastCalledWith(
        [{ principalType: 'user', principalId: validObjectId }],
        'agent',
        '65cfb246f7ecadb8b1e8036c',
        1,
      );
      expect(getAgent).toHaveBeenCalledWith(
        {
          id: 'agent_abc123',
          'avatar.filepath': {
            $in: [
              '/images/65cfb246f7ecadb8b1e8036c/agent-agent_abc123-avatar-12345.png',
              '/images/65cfb246f7ecadb8b1e8036c/agent-agent_abc123-avatar-12345.png?manual=false',
              '/images/65cfb246f7ecadb8b1e8036c/agent-agent_abc123-avatar-12345.png?manual=true',
            ],
          },
        },
        { _id: 1 },
      );
    });

    test('should deny an agent avatar when the user lacks VIEW access', async () => {
      const validToken = jwt.sign(
        { id: validObjectId, exp: Math.floor(Date.now() / 1000) + 3600 },
        process.env.JWT_REFRESH_SECRET,
      );
      req.headers.cookie = `refreshToken=${validToken}`;
      req.originalUrl = '/images/65cfb246f7ecadb8b1e8036c/agent-agent_abc123-avatar-12345.png';
      getAgent.mockResolvedValue({ _id: '65cfb246f7ecadb8b1e8036c' });
      await validateImageRequest(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    test('should allow an agent avatar for a user who manages agents', async () => {
      const validToken = jwt.sign(
        { id: validObjectId, exp: Math.floor(Date.now() / 1000) + 3600 },
        process.env.JWT_REFRESH_SECRET,
      );
      req.headers.cookie = `refreshToken=${validToken}`;
      req.originalUrl = '/images/65cfb246f7ecadb8b1e8036c/agent-agent_abc123-avatar-12345.png';
      getAgent.mockResolvedValue({ _id: '65cfb246f7ecadb8b1e8036c' });
      hasCapabilityForPrincipals.mockResolvedValue(true);
      await validateImageRequest(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(hasCapabilityForPrincipals).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-a' }),
      );
      expect(hasPermission).not.toHaveBeenCalled();
    });

    test('should allow an anonymous viewer to load a publicly viewable agent avatar', async () => {
      req.originalUrl = '/images/65cfb246f7ecadb8b1e8036c/agent-agent_abc123-avatar-12345.png';
      getAgent.mockResolvedValue({ _id: '65cfb246f7ecadb8b1e8036c' });
      hasPermission.mockResolvedValue(true);

      await validateImageRequest(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(getUserPrincipals).not.toHaveBeenCalled();
      expect(hasPermission).toHaveBeenCalledWith(
        [{ principalType: 'public' }],
        'agent',
        '65cfb246f7ecadb8b1e8036c',
        1,
      );
    });

    test('should allow a shared assistant avatar for a different authenticated user', async () => {
      validateImageRequest = createValidateImageRequest({
        secureImageLinks: true,
      });
      getAppConfig.mockResolvedValue({
        endpoints: { assistants: { privateAssistants: false } },
      });
      const validToken = jwt.sign(
        { id: validObjectId, exp: Math.floor(Date.now() / 1000) + 3600 },
        process.env.JWT_REFRESH_SECRET,
      );
      req.headers.cookie = `refreshToken=${validToken}`;
      req.originalUrl = '/images/65cfb246f7ecadb8b1e8036c/assistant-avatar.png';
      getAssistant.mockResolvedValue({
        _id: '65cfb246f7ecadb8b1e8036d',
        assistant_id: 'asst_shared',
        endpoint: 'assistants',
      });

      await validateImageRequest(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(getAssistant).toHaveBeenCalledWith(
        {
          avatarFilepath: [
            '/images/65cfb246f7ecadb8b1e8036c/assistant-avatar.png',
            '/images/65cfb246f7ecadb8b1e8036c/assistant-avatar.png?manual=false',
            '/images/65cfb246f7ecadb8b1e8036c/assistant-avatar.png?manual=true',
          ],
        },
        { _id: 1, assistant_id: 1, endpoint: 1 },
      );
    });

    test('should prevent file traversal attempts', async () => {
      const validToken = jwt.sign(
        { id: validObjectId, exp: Math.floor(Date.now() / 1000) + 3600 },
        process.env.JWT_REFRESH_SECRET,
      );
      req.headers.cookie = `refreshToken=${validToken}`;

      const traversalAttempts = [
        `/images/${validObjectId}/../../../etc/passwd`,
        `/images/${validObjectId}/..%2F..%2F..%2Fetc%2Fpasswd`,
        `/images/${validObjectId}/image.jpg/../../../etc/passwd`,
        `/images/${validObjectId}/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd`,
      ];

      for (const attempt of traversalAttempts) {
        req.originalUrl = attempt;
        await validateImageRequest(req, res, next);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.send).toHaveBeenCalledWith('Access Denied');
        jest.clearAllMocks();
        // Reset mocks for next iteration
        res.status = jest.fn().mockReturnThis();
        res.send = jest.fn();
      }
    });

    test('should handle URL encoded characters in valid paths', async () => {
      const validToken = jwt.sign(
        { id: validObjectId, exp: Math.floor(Date.now() / 1000) + 3600 },
        process.env.JWT_REFRESH_SECRET,
      );
      req.headers.cookie = `refreshToken=${validToken}`;
      req.originalUrl = `/images/${validObjectId}/image%20with%20spaces.jpg`;
      await validateImageRequest(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('OpenID token flow', () => {
    beforeEach(() => {
      validateImageRequest = createValidateImageRequest(true);
      // Enable OpenID token reuse
      isEnabled.mockReturnValue(true);
      process.env.OPENID_REUSE_TOKENS = 'true';
      req.session = { openidTokens: { refreshToken: 'dummy-token' } };
    });

    test('should return 403 if no OpenID user ID cookie when token_provider is openid', async () => {
      req.headers.cookie = 'refreshToken=dummy-token; token_provider=openid';
      await validateImageRequest(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.send).toHaveBeenCalledWith('Access Denied');
    });

    test('should validate JWT-signed user ID for OpenID flow', async () => {
      const signedUserId = jwt.sign(
        { id: validObjectId, exp: Math.floor(Date.now() / 1000) + 3600 },
        process.env.JWT_REFRESH_SECRET,
      );
      req.headers.cookie = `refreshToken=dummy-token; token_provider=openid; openid_user_id=${signedUserId}`;
      req.originalUrl = `/images/${validObjectId}/example.jpg`;
      await validateImageRequest(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('should validate a refresh-bound user ID after the OpenID session expires', async () => {
      const refreshToken = 'dummy-token';
      const signedUserId = jwt.sign(
        {
          id: validObjectId,
          refreshTokenHash: createHash('sha256').update(refreshToken).digest('base64url'),
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
        process.env.JWT_REFRESH_SECRET,
      );
      req.session = undefined;
      req.headers.cookie = `refreshToken=${refreshToken}; token_provider=openid; openid_user_id=${signedUserId}`;
      req.originalUrl = `/images/${validObjectId}/example.jpg`;

      await validateImageRequest(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(findSession).toHaveBeenCalledWith({
        userId: validObjectId,
        refreshToken,
      });
    });

    test('should return 403 for invalid JWT-signed user ID', async () => {
      req.headers.cookie =
        'refreshToken=dummy-token; token_provider=openid; openid_user_id=invalid-jwt';
      await validateImageRequest(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.send).toHaveBeenCalledWith('Access Denied');
    });

    test('should return 403 for expired JWT-signed user ID', async () => {
      const expiredSignedUserId = jwt.sign(
        { id: validObjectId, exp: Math.floor(Date.now() / 1000) - 3600 },
        process.env.JWT_REFRESH_SECRET,
      );
      req.headers.cookie = `refreshToken=dummy-token; token_provider=openid; openid_user_id=${expiredSignedUserId}`;
      await validateImageRequest(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.send).toHaveBeenCalledWith('Access Denied');
    });

    test('should validate image path against JWT-signed user ID', async () => {
      const signedUserId = jwt.sign(
        { id: validObjectId, exp: Math.floor(Date.now() / 1000) + 3600 },
        process.env.JWT_REFRESH_SECRET,
      );
      const differentObjectId = '65cfb246f7ecadb8b1e8036c';
      req.headers.cookie = `refreshToken=dummy-token; token_provider=openid; openid_user_id=${signedUserId}`;
      req.originalUrl = `/images/${differentObjectId}/example.jpg`;
      await validateImageRequest(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.send).toHaveBeenCalledWith('Access Denied');
    });

    test('should allow agent avatars in OpenID flow', async () => {
      const signedUserId = jwt.sign(
        { id: validObjectId, exp: Math.floor(Date.now() / 1000) + 3600 },
        process.env.JWT_REFRESH_SECRET,
      );
      req.headers.cookie = `refreshToken=dummy-token; token_provider=openid; openid_user_id=${signedUserId}`;
      req.originalUrl = '/images/65cfb246f7ecadb8b1e8036c/agent-agent_abc123-avatar-12345.png';
      getAgent.mockResolvedValue({ _id: '65cfb246f7ecadb8b1e8036c' });
      hasPermission.mockResolvedValue(true);
      await validateImageRequest(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('Security edge cases', () => {
    let validToken;

    beforeEach(() => {
      validateImageRequest = createValidateImageRequest(true);
      validToken = jwt.sign(
        { id: validObjectId, exp: Math.floor(Date.now() / 1000) + 3600 },
        process.env.JWT_REFRESH_SECRET,
      );
    });

    test('should handle very long image filenames', async () => {
      const longFilename = 'a'.repeat(1000) + '.jpg';
      req.headers.cookie = `refreshToken=${validToken}`;
      req.originalUrl = `/images/${validObjectId}/${longFilename}`;
      await validateImageRequest(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('should handle URLs with maximum practical length', async () => {
      // Most browsers support URLs up to ~2000 characters
      const longFilename = 'x'.repeat(1900) + '.jpg';
      req.headers.cookie = `refreshToken=${validToken}`;
      req.originalUrl = `/images/${validObjectId}/${longFilename}`;
      await validateImageRequest(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('should accept URLs just under the 2048 limit', async () => {
      // Create a URL exactly 2047 characters long
      const baseLength = `/images/${validObjectId}/`.length + '.jpg'.length;
      const filenameLength = 2047 - baseLength;
      const filename = 'a'.repeat(filenameLength) + '.jpg';
      req.headers.cookie = `refreshToken=${validToken}`;
      req.originalUrl = `/images/${validObjectId}/${filename}`;
      await validateImageRequest(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('should handle malformed URL encoding gracefully', async () => {
      req.headers.cookie = `refreshToken=${validToken}`;
      req.originalUrl = `/images/${validObjectId}/test%ZZinvalid.jpg`;
      await validateImageRequest(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.send).toHaveBeenCalledWith('Access Denied');
    });

    test('should reject URLs with null bytes', async () => {
      req.headers.cookie = `refreshToken=${validToken}`;
      req.originalUrl = `/images/${validObjectId}/test\x00.jpg`;
      await validateImageRequest(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.send).toHaveBeenCalledWith('Access Denied');
    });

    test('should handle URLs with repeated slashes', async () => {
      req.headers.cookie = `refreshToken=${validToken}`;
      req.originalUrl = `/images/${validObjectId}//test.jpg`;
      await validateImageRequest(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.send).toHaveBeenCalledWith('Access Denied');
    });

    test('should reject extremely long URLs as potential DoS', async () => {
      // Create a URL longer than 2048 characters
      const baseLength = `/images/${validObjectId}/`.length + '.jpg'.length;
      const filenameLength = 2049 - baseLength; // Ensure total length exceeds 2048
      const extremelyLongFilename = 'x'.repeat(filenameLength) + '.jpg';
      req.headers.cookie = `refreshToken=${validToken}`;
      req.originalUrl = `/images/${validObjectId}/${extremelyLongFilename}`;
      // Verify our test URL is actually too long
      expect(req.originalUrl.length).toBeGreaterThan(2048);
      await validateImageRequest(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.send).toHaveBeenCalledWith('Access Denied');
    });
  });

  describe('basePath functionality', () => {
    let originalDomainClient;

    beforeEach(() => {
      originalDomainClient = process.env.DOMAIN_CLIENT;
    });

    afterEach(() => {
      process.env.DOMAIN_CLIENT = originalDomainClient;
    });

    test('should validate image paths with base path', async () => {
      process.env.DOMAIN_CLIENT = 'http://localhost:3080/librechat';
      const validToken = jwt.sign(
        { id: validObjectId, exp: Math.floor(Date.now() / 1000) + 3600 },
        process.env.JWT_REFRESH_SECRET,
      );
      req.headers.cookie = `refreshToken=${validToken}`;
      req.originalUrl = `/librechat/images/${validObjectId}/test.jpg`;

      await validateImageRequest(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('should validate agent avatar paths with base path', async () => {
      process.env.DOMAIN_CLIENT = 'http://localhost:3080/librechat';
      const validToken = jwt.sign(
        { id: validObjectId, exp: Math.floor(Date.now() / 1000) + 3600 },
        process.env.JWT_REFRESH_SECRET,
      );
      req.headers.cookie = `refreshToken=${validToken}`;
      req.originalUrl =
        '/librechat/images/65cfb246f7ecadb8b1e8036c/agent-agent_abc123-avatar-12345.png';
      getAgent.mockResolvedValue({ _id: '65cfb246f7ecadb8b1e8036c' });
      hasPermission.mockResolvedValue(true);

      await validateImageRequest(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('should reject image paths without base path when DOMAIN_CLIENT is set', async () => {
      process.env.DOMAIN_CLIENT = 'http://localhost:3080/librechat';
      const validToken = jwt.sign(
        { id: validObjectId, exp: Math.floor(Date.now() / 1000) + 3600 },
        process.env.JWT_REFRESH_SECRET,
      );
      req.headers.cookie = `refreshToken=${validToken}`;
      req.originalUrl = `/images/${validObjectId}/test.jpg`;

      await validateImageRequest(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.send).toHaveBeenCalledWith('Access Denied');
    });

    test('should handle empty base path (root deployment)', async () => {
      process.env.DOMAIN_CLIENT = 'http://localhost:3080/';
      const validToken = jwt.sign(
        { id: validObjectId, exp: Math.floor(Date.now() / 1000) + 3600 },
        process.env.JWT_REFRESH_SECRET,
      );
      req.headers.cookie = `refreshToken=${validToken}`;
      req.originalUrl = `/images/${validObjectId}/test.jpg`;

      await validateImageRequest(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('should handle missing DOMAIN_CLIENT', async () => {
      delete process.env.DOMAIN_CLIENT;
      const validToken = jwt.sign(
        { id: validObjectId, exp: Math.floor(Date.now() / 1000) + 3600 },
        process.env.JWT_REFRESH_SECRET,
      );
      req.headers.cookie = `refreshToken=${validToken}`;
      req.originalUrl = `/images/${validObjectId}/test.jpg`;

      await validateImageRequest(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('should handle nested subdirectories in base path', async () => {
      process.env.DOMAIN_CLIENT = 'http://localhost:3080/apps/librechat';
      const validToken = jwt.sign(
        { id: validObjectId, exp: Math.floor(Date.now() / 1000) + 3600 },
        process.env.JWT_REFRESH_SECRET,
      );
      req.headers.cookie = `refreshToken=${validToken}`;
      req.originalUrl = `/apps/librechat/images/${validObjectId}/test.jpg`;

      await validateImageRequest(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('should prevent path traversal with base path', async () => {
      process.env.DOMAIN_CLIENT = 'http://localhost:3080/librechat';
      const validToken = jwt.sign(
        { id: validObjectId, exp: Math.floor(Date.now() / 1000) + 3600 },
        process.env.JWT_REFRESH_SECRET,
      );
      req.headers.cookie = `refreshToken=${validToken}`;
      req.originalUrl = `/librechat/images/${validObjectId}/../../../etc/passwd`;

      await validateImageRequest(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.send).toHaveBeenCalledWith('Access Denied');
    });

    test('should handle URLs with query parameters and base path', async () => {
      process.env.DOMAIN_CLIENT = 'http://localhost:3080/librechat';
      const validToken = jwt.sign(
        { id: validObjectId, exp: Math.floor(Date.now() / 1000) + 3600 },
        process.env.JWT_REFRESH_SECRET,
      );
      req.headers.cookie = `refreshToken=${validToken}`;
      req.originalUrl = `/librechat/images/${validObjectId}/test.jpg?version=1`;

      await validateImageRequest(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('should handle URLs with fragments and base path', async () => {
      process.env.DOMAIN_CLIENT = 'http://localhost:3080/librechat';
      const validToken = jwt.sign(
        { id: validObjectId, exp: Math.floor(Date.now() / 1000) + 3600 },
        process.env.JWT_REFRESH_SECRET,
      );
      req.headers.cookie = `refreshToken=${validToken}`;
      req.originalUrl = `/librechat/images/${validObjectId}/test.jpg#section`;

      await validateImageRequest(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('should handle HTTPS URLs with base path', async () => {
      process.env.DOMAIN_CLIENT = 'https://example.com/librechat';
      const validToken = jwt.sign(
        { id: validObjectId, exp: Math.floor(Date.now() / 1000) + 3600 },
        process.env.JWT_REFRESH_SECRET,
      );
      req.headers.cookie = `refreshToken=${validToken}`;
      req.originalUrl = `/librechat/images/${validObjectId}/test.jpg`;

      await validateImageRequest(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('should handle invalid DOMAIN_CLIENT gracefully', async () => {
      process.env.DOMAIN_CLIENT = 'not-a-valid-url';
      const validToken = jwt.sign(
        { id: validObjectId, exp: Math.floor(Date.now() / 1000) + 3600 },
        process.env.JWT_REFRESH_SECRET,
      );
      req.headers.cookie = `refreshToken=${validToken}`;
      req.originalUrl = `/images/${validObjectId}/test.jpg`;

      await validateImageRequest(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('should handle OpenID flow with base path', async () => {
      process.env.DOMAIN_CLIENT = 'http://localhost:3080/librechat';
      process.env.OPENID_REUSE_TOKENS = 'true';
      const validToken = jwt.sign(
        { id: validObjectId, exp: Math.floor(Date.now() / 1000) + 3600 },
        process.env.JWT_REFRESH_SECRET,
      );
      req.headers.cookie = `refreshToken=${validToken}; token_provider=openid; openid_user_id=${validToken}`;
      req.session = { openidTokens: { refreshToken: validToken } };
      req.originalUrl = `/librechat/images/${validObjectId}/test.jpg`;

      await validateImageRequest(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });
});

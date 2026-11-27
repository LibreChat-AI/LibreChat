process.env.TENANT_ISOLATION_STRICT = 'true';

const express = require('express');
const request = require('supertest');
const fs = require('fs/promises');
const { getTenantId, tenantStorage: mockTenantStorage } = require('@librechat/data-schemas');

const TEST_TENANT = 'tenant-files-strict';

let mockCurrentUser;

jest.mock('fs/promises', () => ({
  unlink: jest.fn().mockResolvedValue(undefined),
}));

const mockTenantResponse = (route) => (req, res) =>
  res.status(200).json({ route, tenantId: getTenantId() });

jest.mock('~/server/middleware', () => ({
  createFileLimiters: jest.fn(() => ({
    fileUploadIpLimiter: (req, res, next) => next(),
    fileUploadUserLimiter: (req, res, next) => next(),
  })),
  createFileUsageLimiter: jest.fn(() => (req, res, next) => next()),
  configMiddleware: (req, res, next) => {
    req.config = {
      fileStrategy: 'local',
      paths: { uploads: '/tmp/uploads', images: '/tmp/images' },
    };
    next();
  },
  requireJwtAuth: (req, res, next) => {
    req.user = mockCurrentUser;
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      next();
      return;
    }
    mockTenantStorage.run({ tenantId }, async () => next());
  },
  uaParser: (req, res, next) => next(),
  checkBan: (req, res, next) => next(),
}));

jest.mock('./multer', () => ({
  createMulterInstance: jest.fn(async () => ({
    single: jest.fn(() => (req, res, next) => {
      req.file = {
        path: '/tmp/uploaded-file',
        originalname: 'uploaded.txt',
        filename: 'uploaded.txt',
        mimetype: 'text/plain',
        size: 8,
      };
      req.file_id = 'file-upload-id';
      mockTenantStorage.enterWith({});
      next();
    }),
  })),
}));

jest.mock('./files', () => {
  const express = require('express');
  const router = express.Router();
  router.post('/', mockTenantResponse('files'));
  return router;
});

jest.mock('./images', () => {
  const express = require('express');
  const router = express.Router();
  router.post('/', mockTenantResponse('images'));
  return router;
});

jest.mock('./avatar', () => {
  const express = require('express');
  const router = express.Router();
  router.post('/', mockTenantResponse('avatar'));
  return router;
});

jest.mock('./speech', () => {
  const express = require('express');
  const router = express.Router();
  router.post('/stt', mockTenantResponse('speech-stt'));
  return router;
});

jest.mock('~/server/routes/agents/v1', () => {
  const express = require('express');
  const avatar = express.Router();
  avatar.post('/:agent_id/avatar/', mockTenantResponse('agent-avatar'));
  return { avatar };
});

jest.mock('~/server/routes/assistants/v1', () => {
  const express = require('express');
  const avatar = express.Router();
  avatar.post('/:assistant_id/avatar/', mockTenantResponse('assistant-avatar'));
  return { avatar };
});

describe('file upload routes restore strict isolation context after multer', () => {
  let app;

  beforeAll(async () => {
    const { initialize } = require('./index');
    app = express();
    app.use('/api/files', await initialize());
  });

  beforeEach(() => {
    fs.unlink.mockClear();
    mockCurrentUser = {
      id: 'user-files-strict',
      role: 'USER',
      tenantId: TEST_TENANT,
    };
  });

  afterAll(() => {
    delete process.env.TENANT_ISOLATION_STRICT;
  });

  it.each([
    ['files', '/api/files'],
    ['images', '/api/files/images'],
    ['avatar', '/api/files/images/avatar'],
    ['agent-avatar', '/api/files/images/agents/agent-1/avatar'],
    ['assistant-avatar', '/api/files/images/assistants/asst-1/avatar'],
    ['speech-stt', '/api/files/speech/stt'],
  ])('restores context for %s upload', async (route, url) => {
    const res = await request(app).post(url);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ route, tenantId: TEST_TENANT });
  });

  it('rejects strict upload continuations when no tenant can be resolved', async () => {
    mockCurrentUser = {
      id: 'user-without-tenant',
      role: 'USER',
    };

    const res = await request(app).post('/api/files');

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Tenant context required/);
    expect(fs.unlink).toHaveBeenCalledWith('/tmp/uploaded-file');
  });
});

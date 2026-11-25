const express = require('express');
const request = require('supertest');

const mockSendRemoteAgentFile = jest.fn(({ res }) => res.status(200).send('image-bytes'));
const mockRequireRemoteAgentAuth = jest.fn((req, res, next) => {
  if (req.get('authorization') !== 'Bearer remote-key') {
    return res.sendStatus(401);
  }
  req.user = { id: 'user-1', tenantId: 'tenant-1' };
  next();
});
const mockFileAccess = jest.fn((req, _res, next) => {
  req.fileAccess = {
    file: {
      file_id: req.params.file_id,
      filepath: '/images/user-1/generated.webp',
      source: 'local',
      type: 'image/webp',
    },
  };
  next();
});
const mockGetStrategyFunctions = jest.fn();

jest.mock('@librechat/api', () => ({
  sendRemoteAgentFile: mockSendRemoteAgentFile,
}));

jest.mock('~/server/middleware', () => ({
  configMiddleware: (_req, _res, next) => next(),
  requireTermsAcceptance: (_req, _res, next) => next(),
}));

jest.mock('~/server/middleware/accessResources/fileAccess', () => ({
  fileAccess: mockFileAccess,
}));

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: mockGetStrategyFunctions,
}));

jest.mock('../middleware', () => ({
  preAuthTenantMiddleware: (_req, _res, next) => next(),
  requireRemoteAgentAuth: mockRequireRemoteAgentAuth,
  checkRemoteAgentsFeature: (_req, _res, next) => next(),
}));

const router = require('../files');

describe('Remote Agent file content route', () => {
  const app = express();
  app.use('/api/agents/v1/files', router);

  beforeEach(() => jest.clearAllMocks());

  it('rejects requests without Remote Agent credentials before file access', async () => {
    const response = await request(app).get('/api/agents/v1/files/image-1/content');

    expect(response.status).toBe(401);
    expect(mockFileAccess).not.toHaveBeenCalled();
    expect(mockSendRemoteAgentFile).not.toHaveBeenCalled();
  });

  it('streams a file already authorized by the shared file ACL', async () => {
    const response = await request(app)
      .get('/api/agents/v1/files/image-1/content')
      .set('Authorization', 'Bearer remote-key');

    expect(response.status).toBe(200);
    expect(response.text).toBe('image-bytes');
    expect(mockFileAccess).toHaveBeenCalledTimes(1);
    expect(mockSendRemoteAgentFile).toHaveBeenCalledWith({
      req: expect.objectContaining({ user: { id: 'user-1', tenantId: 'tenant-1' } }),
      res: expect.anything(),
      file: expect.objectContaining({ file_id: 'image-1', type: 'image/webp' }),
      getStrategyFunctions: mockGetStrategyFunctions,
    });
  });
});

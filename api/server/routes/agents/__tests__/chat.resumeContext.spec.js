const express = require('express');
const request = require('supertest');
const mockGetJob = jest.fn();
const mockFollowingMiddleware = jest.fn((_req, _res, next) => next());
const mockResume = jest.fn(async (req, res) => res.json(req.body));
const mockPass = (_req, _res, next) => next();
jest.mock('@librechat/api', () => ({
  createChatResumeContext: (...args) =>
    jest.requireActual('@librechat/api').createChatResumeContext(...args),
  getSafeErrorMetadata: (...args) =>
    jest.requireActual('@librechat/api').getSafeErrorMetadata(...args),
  GenerationJobManager: { getJob: (...args) => mockGetJob(...args) },
  validateChatMessageIds: (...args) => mockPass(...args),
  generateCheckAccess: () => mockPass,
  createMessageFilterPii: () => mockFollowingMiddleware,
}));
jest.mock('~/server/middleware', () => ({
  moderateText: (...args) => mockPass(...args),
  validateConvoAccess: (...args) => mockPass(...args),
  buildEndpointOption: (...args) => mockPass(...args),
  canAccessAgentFromBody: () => mockPass,
}));
jest.mock(
  '~/server/middleware/validate/subagentThreadTurn',
  () =>
    (...args) =>
      mockPass(...args),
);
jest.mock('~/server/services/Endpoints/agents', () => ({ initializeClient: jest.fn() }));
jest.mock('~/server/services/Endpoints/agents/title', () => jest.fn());
jest.mock('~/models', () => ({ getFiles: jest.fn(), getRoleByName: jest.fn() }));
jest.mock('~/server/controllers/agents/request', () => jest.fn());
jest.mock(
  '~/server/controllers/agents/resume',
  () =>
    (...args) =>
      mockResume(...args),
);
const router = require('../chat');
function fixture() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}
beforeEach(() => {
  jest.clearAllMocks();
});
it('rejects Responses resume before endpoint reconstruction in the production router', async () => {
  mockGetJob.mockResolvedValue({ metadata: { endpoint: 'responses' } });
  await request(fixture())
    .post('/resume')
    .send({ conversationId: 'response' })
    .expect(404, { error: 'No paused generation for this conversation' });
  expect(mockFollowingMiddleware).not.toHaveBeenCalled();
  expect(mockResume).not.toHaveBeenCalled();
});
it('fails closed and redacts storage failures in the production router', async () => {
  mockGetJob.mockRejectedValue(new Error('private credential and query'));
  await request(fixture())
    .post('/resume')
    .send({ conversationId: 'conversation' })
    .expect(503, { error: 'resume_context_unavailable' });
  expect(mockFollowingMiddleware).not.toHaveBeenCalled();
  expect(mockResume).not.toHaveBeenCalled();
});
it('restores the pinned chat context before following middleware and the controller', async () => {
  mockGetJob.mockResolvedValue({
    metadata: {
      endpoint: 'agents',
      pendingAction: {
        resumeContext: { endpoint: 'agents', model_parameters: { temperature: 0.3 } },
      },
    },
  });
  await request(fixture())
    .post('/resume')
    .send({ conversationId: 'conversation', actionId: 'action', temperature: 1 })
    .expect(200, {
      conversationId: 'conversation',
      actionId: 'action',
      endpoint: 'agents',
      temperature: 0.3,
    });
  expect(mockFollowingMiddleware).toHaveBeenCalledTimes(1);
  expect(mockResume).toHaveBeenCalledTimes(1);
});

const express = require('express');
const request = require('supertest');

const mockEnqueueAgentTrigger = jest.fn();
const mockGetAgentTriggerDeliveryStatus = jest.fn();
const mockEnqueueEvent = jest.fn((_req, res) => res.status(202).json({ id: 'trigger-1' }));
const mockGetEvent = jest.fn((_req, res) => res.status(200).json({ status: 'succeeded' }));
const mockRegisterBinding = jest.fn((_req, res) => res.status(201).json({ id: 'evtbind-1' }));
const mockResolveBinding = jest.fn((_req, _res, next) => next());
let mockIngressDependencies;
const mockCreateAgentTriggerIngressHandlers = jest.fn((dependencies) => {
  mockIngressDependencies = dependencies;
  return {
    enqueueEvent: mockEnqueueEvent,
    getEvent: mockGetEvent,
  };
});

jest.mock('@librechat/api', () => ({
  createAgentEventBindingHandlers: () => ({
    register: mockRegisterBinding,
    resolve: mockResolveBinding,
  }),
  createAgentTriggerIngressHandlers: mockCreateAgentTriggerIngressHandlers,
  createMessageFilterPii: () => (_req, _res, next) => next(),
}));

jest.mock('~/models', () => ({
  getAgent: jest.fn(),
  getConvo: jest.fn(),
  getAgentEventBinding: jest.fn(),
  reserveSubagentThread: jest.fn(),
}));

jest.mock('~/server/controllers/agents/openai', () => ({
  OpenAIChatCompletionController: jest.fn(),
  ListModelsController: jest.fn(),
  GetModelController: jest.fn(),
}));

jest.mock('~/server/services/Agents/triggers', () => ({
  enqueueAgentTrigger: mockEnqueueAgentTrigger,
  getAgentTriggerDeliveryStatus: mockGetAgentTriggerDeliveryStatus,
}));

jest.mock('~/server/middleware', () => ({
  agentEventUserLimiter: (_req, _res, next) => next(),
  configMiddleware: (_req, _res, next) => next(),
}));

jest.mock('../middleware', () => ({
  preAuthTenantMiddleware: (_req, _res, next) => next(),
  requireRemoteAgentAuth: (req, _res, next) => {
    req.user = { id: 'user-1' };
    next();
  },
  checkRemoteAgentsFeature: (_req, _res, next) => next(),
  checkAgentPermission: (_req, _res, next) => next(),
  checkAgentTriggerPermission: (_req, _res, next) => next(),
}));

const router = require('../openai');

describe('Remote Agents event routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/agents/v1', router);

  beforeEach(() => {
    mockEnqueueEvent.mockClear();
    mockGetEvent.mockClear();
    mockRegisterBinding.mockClear();
    mockResolveBinding.mockClear();
  });

  it('registers a source-bound child actor thread', async () => {
    const response = await request(app)
      .post('/api/agents/v1/events/bindings')
      .send({ target: { agentId: 'agent-1' } });

    expect(response.status).toBe(201);
    expect(mockRegisterBinding).toHaveBeenCalledTimes(1);
  });

  it('wires durable event admission to the trigger service', async () => {
    const response = await request(app)
      .post('/api/agents/v1/events')
      .send({
        target: { agentId: 'agent-1' },
      });

    expect(response.status).toBe(202);
    expect(mockIngressDependencies).toEqual({
      enqueue: mockEnqueueAgentTrigger,
      getDeliveryStatus: mockGetAgentTriggerDeliveryStatus,
    });
    expect(mockEnqueueEvent).toHaveBeenCalledTimes(1);
  });

  it('wires owner-scoped event status reads to the ingress handler', async () => {
    const response = await request(app).get('/api/agents/v1/events/trigger-1');

    expect(response.status).toBe(200);
    expect(mockGetEvent).toHaveBeenCalledTimes(1);
  });
});

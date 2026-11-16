const mongoose = require('mongoose');
const express = require('express');
const request = require('supertest');
const { nanoid } = require('nanoid');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createModels, SystemCapabilities } = require('@librechat/data-schemas');
const { PrincipalType, SystemRoles } = require('librechat-data-provider');

let mockConfig;

jest.mock('~/server/middleware', () => ({
  ...jest.requireActual('~/server/middleware'),
  configMiddleware: (req, _res, next) => {
    req.config = mockConfig;
    next();
  },
}));

const enabledConfig = { interfaceConfig: { agentCertification: { enabled: true } } };

describe('PUT /agents/:id/certification', () => {
  let mongoServer;
  let db;
  let Agent;
  let currentUser;
  let app;

  const createAgent = (overrides = {}) =>
    Agent.create({
      id: `agent_${nanoid(12)}`,
      name: 'Support agent',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      ...overrides,
    });

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    createModels(mongoose);
    db = require('~/models');
    await db.initializeRoles();
    Agent = mongoose.models.Agent;

    const { v1 } = require('../v1');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = currentUser;
      next();
    });
    app.use('/agents', v1);
    /** Loading the full agents router (actions, tools, controllers) is slow on a cold run. */
  }, 120000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    mockConfig = enabledConfig;
    currentUser = {
      id: new mongoose.Types.ObjectId().toString(),
      role: SystemRoles.USER,
      idOnTheSource: null,
    };
    await Agent.deleteMany({});
  });

  const grantManageAgents = () =>
    db.grantCapability({
      principalType: PrincipalType.USER,
      principalId: currentUser.id,
      capability: SystemCapabilities.MANAGE_AGENTS,
    });

  it('refuses a user without manage:agents and leaves the agent unchanged', async () => {
    const agent = await createAgent();

    const response = await request(app)
      .put(`/agents/${agent.id}/certification`)
      .send({ is_certified: true });

    expect(response.status).toBe(403);
    expect((await Agent.findOne({ id: agent.id }).lean()).is_certified).toBe(false);
  });

  it('lets a manage:agents holder certify and uncertify without writing a version', async () => {
    await grantManageAgents();
    const agent = await createAgent();

    const certified = await request(app)
      .put(`/agents/${agent.id}/certification`)
      .send({ is_certified: true });
    expect(certified.status).toBe(200);
    expect(certified.body).toEqual({ id: agent.id, is_certified: true });

    const uncertified = await request(app)
      .put(`/agents/${agent.id}/certification`)
      .send({ is_certified: false });
    expect(uncertified.body).toEqual({ id: agent.id, is_certified: false });

    /** Seeded with `Agent.create`, so it starts with no history; certifying must add none. */
    const stored = await Agent.findOne({ id: agent.id }).lean();
    expect(stored.is_certified).toBe(false);
    expect(stored.versions ?? []).toHaveLength(0);
  });

  it('is unavailable while certification is disabled, even to a manager', async () => {
    await grantManageAgents();
    mockConfig = { interfaceConfig: {} };
    const agent = await createAgent();

    const response = await request(app)
      .put(`/agents/${agent.id}/certification`)
      .send({ is_certified: true });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'agent_certification_disabled' });
    expect((await Agent.findOne({ id: agent.id }).lean()).is_certified).toBe(false);
  });

  it('reports an unknown agent as not found', async () => {
    await grantManageAgents();

    const response = await request(app)
      .put('/agents/agent_missing/certification')
      .send({ is_certified: true });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'agent_not_found' });
  });
});

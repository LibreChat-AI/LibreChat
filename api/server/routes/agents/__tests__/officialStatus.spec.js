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

const enabledConfig = { interfaceConfig: { agentOfficialStatus: { enabled: true } } };

describe('PUT /agents/:id/official-status', () => {
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
      .put(`/agents/${agent.id}/official-status`)
      .send({ is_official: true });

    expect(response.status).toBe(403);
    expect((await Agent.findOne({ id: agent.id }).lean()).is_official).toBe(false);
  });

  it('lets a manage:agents holder mark official and unmark official without writing a version', async () => {
    await grantManageAgents();
    const agent = await createAgent();

    const official = await request(app)
      .put(`/agents/${agent.id}/official-status`)
      .send({ is_official: true });
    expect(official.status).toBe(200);
    expect(official.body).toEqual({ id: agent.id, is_official: true });

    const notOfficial = await request(app)
      .put(`/agents/${agent.id}/official-status`)
      .send({ is_official: false });
    expect(notOfficial.body).toEqual({ id: agent.id, is_official: false });

    /** Seeded with `Agent.create`, so it starts with no history; markingOfficial must add none. */
    const stored = await Agent.findOne({ id: agent.id }).lean();
    expect(stored.is_official).toBe(false);
    expect(stored.versions ?? []).toHaveLength(0);
  });

  it('is unavailable while official status is disabled, even to a manager', async () => {
    await grantManageAgents();
    mockConfig = { interfaceConfig: {} };
    const agent = await createAgent();

    const response = await request(app)
      .put(`/agents/${agent.id}/official-status`)
      .send({ is_official: true });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'agent_official_status_disabled' });
    expect((await Agent.findOne({ id: agent.id }).lean()).is_official).toBe(false);
  });

  it('reports an unknown agent as not found', async () => {
    await grantManageAgents();

    const response = await request(app)
      .put('/agents/agent_missing/official-status')
      .send({ is_official: true });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'agent_not_found' });
  });
});

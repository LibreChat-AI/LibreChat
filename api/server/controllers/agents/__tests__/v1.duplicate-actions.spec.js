jest.mock('~/server/services/PermissionService', () => ({
  findPubliclyAccessibleResources: jest.fn(),
  findAccessibleResources: jest.fn(),
  hasPublicPermission: jest.fn(),
  grantPermission: jest.fn().mockResolvedValue({}),
}));

jest.mock('~/server/services/Config', () => ({
  getCachedTools: jest.fn(),
  getMCPServerTools: jest.fn(),
}));

const mongoose = require('mongoose');
const { actionDelimiter } = require('librechat-data-provider');
const { agentSchema, actionSchema } = require('@librechat/data-schemas');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { duplicateAgent } = require('../v1');

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  if (!mongoose.models.Agent) {
    mongoose.model('Agent', agentSchema);
  }
  if (!mongoose.models.Action) {
    mongoose.model('Action', actionSchema);
  }
  await mongoose.connect(mongoUri);
}, 20000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.models.Agent.deleteMany({});
  await mongoose.models.Action.deleteMany({});
});

describe('duplicateAgentHandler — action domain extraction', () => {
  it('builds duplicated action entries using metadata.domain, not action_id', async () => {
    const userId = new mongoose.Types.ObjectId();
    const originalAgentId = `agent_original`;

    const agent = await mongoose.models.Agent.create({
      id: originalAgentId,
      name: 'Test Agent',
      author: userId.toString(),
      provider: 'openai',
      model: 'gpt-4',
      tools: [],
      actions: [`api.example.com${actionDelimiter}act_original`],
      versions: [{ name: 'Test Agent', createdAt: new Date(), updatedAt: new Date() }],
    });

    await mongoose.models.Action.create({
      user: userId,
      action_id: 'act_original',
      agent_id: originalAgentId,
      metadata: { domain: 'api.example.com' },
    });

    const req = {
      params: { id: agent.id },
      user: { id: userId.toString() },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await duplicateAgent(req, res);

    expect(res.status).toHaveBeenCalledWith(201);

    const { agent: newAgent, actions: newActions } = res.json.mock.calls[0][0];

    expect(newAgent.id).not.toBe(originalAgentId);
    expect(String(newAgent.author)).toBe(userId.toString());
    expect(newActions).toHaveLength(1);
    expect(newActions[0].metadata.domain).toBe('api.example.com');
    expect(newActions[0].agent_id).toBe(newAgent.id);

    for (const actionEntry of newAgent.actions) {
      const [domain, actionId] = actionEntry.split(actionDelimiter);
      expect(domain).toBe('api.example.com');
      expect(actionId).toBeTruthy();
      expect(actionId).not.toBe('act_original');
    }

    const allActions = await mongoose.models.Action.find({}).lean();
    expect(allActions).toHaveLength(2);

    const originalAction = allActions.find((a) => a.action_id === 'act_original');
    expect(originalAction.agent_id).toBe(originalAgentId);

    const duplicatedAction = allActions.find((a) => a.action_id !== 'act_original');
    expect(duplicatedAction.agent_id).toBe(newAgent.id);
    expect(duplicatedAction.metadata.domain).toBe('api.example.com');
  });

  it('removes cloned actions when Agent creation is rejected', async () => {
    const userId = new mongoose.Types.ObjectId();
    const originalAgentId = 'agent_conflicted_clone_source';
    const agent = await mongoose.models.Agent.create({
      id: originalAgentId,
      name: 'Conflicted clone source',
      author: userId.toString(),
      provider: 'openai',
      model: 'gpt-4',
      tools: [],
      actions: [`api.example.com${actionDelimiter}act_original`],
      versions: [{ name: 'Conflicted clone source', createdAt: new Date(), updatedAt: new Date() }],
    });
    await mongoose.models.Action.create({
      user: userId,
      action_id: 'act_original',
      agent_id: originalAgentId,
      metadata: { domain: 'api.example.com' },
    });
    const createAgent = jest
      .spyOn(mongoose.models.Agent, 'create')
      .mockRejectedValueOnce(
        Object.assign(new Error('Code environment is being removed'), { statusCode: 409 }),
      );
    const req = {
      params: { id: agent.id },
      user: { id: userId.toString() },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await duplicateAgent(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    await expect(mongoose.models.Action.countDocuments()).resolves.toBe(1);
    await expect(
      mongoose.models.Action.findOne({ action_id: 'act_original', agent_id: originalAgentId }),
    ).resolves.not.toBeNull();
    createAgent.mockRestore();
  });

  it('strips sensitive metadata fields from duplicated actions', async () => {
    const userId = new mongoose.Types.ObjectId();
    const originalAgentId = 'agent_sensitive';

    await mongoose.models.Agent.create({
      id: originalAgentId,
      name: 'Sensitive Agent',
      author: userId.toString(),
      provider: 'openai',
      model: 'gpt-4',
      tools: [],
      actions: [`secure.api.com${actionDelimiter}act_secret`],
      versions: [{ name: 'Sensitive Agent', createdAt: new Date(), updatedAt: new Date() }],
    });

    await mongoose.models.Action.create({
      user: userId,
      action_id: 'act_secret',
      agent_id: originalAgentId,
      metadata: {
        domain: 'secure.api.com',
        api_key: 'sk-secret-key-12345',
        oauth_client_id: 'client_id_xyz',
        oauth_client_secret: 'client_secret_xyz',
      },
    });

    const req = {
      params: { id: originalAgentId },
      user: { id: userId.toString() },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await duplicateAgent(req, res);

    expect(res.status).toHaveBeenCalledWith(201);

    const duplicatedAction = await mongoose.models.Action.findOne({
      agent_id: { $ne: originalAgentId },
    }).lean();

    expect(duplicatedAction.metadata.domain).toBe('secure.api.com');
    expect(duplicatedAction.metadata.api_key).toBeUndefined();
    expect(duplicatedAction.metadata.oauth_client_id).toBeUndefined();
    expect(duplicatedAction.metadata.oauth_client_secret).toBeUndefined();

    const originalAction = await mongoose.models.Action.findOne({
      action_id: 'act_secret',
    }).lean();
    expect(originalAction.metadata.api_key).toBe('sk-secret-key-12345');
  });
});

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
const { fileSchema } = require('@librechat/data-schemas');
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
  if (!mongoose.models.File) {
    mongoose.model('File', fileSchema);
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
  if (mongoose.models.File) {
    await mongoose.models.File.deleteMany({});
  }
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

describe('duplicateAgentHandler — tool_resources preservation', () => {
  it('preserves execute_code file_ids when duplicating an agent', async () => {
    const userId = new mongoose.Types.ObjectId();
    const originalAgentId = 'agent_code_files';

    await mongoose.models.Agent.create({
      id: originalAgentId,
      name: 'Code Agent',
      author: userId.toString(),
      provider: 'openai',
      model: 'gpt-4',
      tools: [],
      tool_resources: {
        context: { file_ids: ['ctx-file-1'] },
        execute_code: { file_ids: ['code-file-1', 'code-file-2'] },
      },
      versions: [{ name: 'Code Agent', createdAt: new Date(), updatedAt: new Date() }],
    });

    // Create File documents so pruneToolResourceFileIdsForAgent finds them
    for (const fileId of ['ctx-file-1', 'code-file-1', 'code-file-2']) {
      await mongoose.models.File.create({
        file_id: fileId,
        user: userId,
        filename: fileId + '.txt',
        filepath: '/tmp/' + fileId,
        type: 'text/plain',
        bytes: 100,
      });
    }

    const req = {
      params: { id: originalAgentId },
      user: { id: userId.toString(), role: 'user' },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await duplicateAgent(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const { agent: newAgent } = res.json.mock.calls[0][0];

    expect(newAgent.id).not.toBe(originalAgentId);
    expect(newAgent.tool_resources).toBeDefined();
    expect(newAgent.tool_resources.context).toBeDefined();
    expect(newAgent.tool_resources.context.file_ids).toEqual(['ctx-file-1']);
    expect(newAgent.tool_resources.execute_code).toBeDefined();
    expect(newAgent.tool_resources.execute_code.file_ids).toEqual(['code-file-1', 'code-file-2']);
  });

  it('preserves execute_code even when no context files exist', async () => {
    const userId = new mongoose.Types.ObjectId();
    const originalAgentId = 'agent_code_only';

    await mongoose.models.Agent.create({
      id: originalAgentId,
      name: 'Code Only Agent',
      author: userId.toString(),
      provider: 'openai',
      model: 'gpt-4',
      tools: [],
      tool_resources: {
        execute_code: { file_ids: ['code-file-x'] },
      },
      versions: [{ name: 'Code Only Agent', createdAt: new Date(), updatedAt: new Date() }],
    });

    await mongoose.models.File.create({
      file_id: 'code-file-x',
      user: userId,
      filename: 'code-file-x.txt',
      filepath: '/tmp/code-file-x',
      type: 'text/plain',
      bytes: 100,
    });

    const req = {
      params: { id: originalAgentId },
      user: { id: userId.toString(), role: 'user' },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await duplicateAgent(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const { agent: newAgent } = res.json.mock.calls[0][0];

    expect(newAgent.tool_resources).toBeDefined();
    expect(newAgent.tool_resources.execute_code).toBeDefined();
    expect(newAgent.tool_resources.execute_code.file_ids).toEqual(['code-file-x']);
  });

  it('does not set execute_code when the original has none', async () => {
    const userId = new mongoose.Types.ObjectId();
    const originalAgentId = 'agent_no_code';

    await mongoose.models.Agent.create({
      id: originalAgentId,
      name: 'No Code Agent',
      author: userId.toString(),
      provider: 'openai',
      model: 'gpt-4',
      tools: [],
      tool_resources: {
        context: { file_ids: ['ctx-file-1'] },
      },
      versions: [{ name: 'No Code Agent', createdAt: new Date(), updatedAt: new Date() }],
    });

    await mongoose.models.File.create({
      file_id: 'ctx-file-1',
      user: userId,
      filename: 'ctx-file-1.txt',
      filepath: '/tmp/ctx-file-1',
      type: 'text/plain',
      bytes: 100,
    });

    const req = {
      params: { id: originalAgentId },
      user: { id: userId.toString(), role: 'user' },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await duplicateAgent(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const { agent: newAgent } = res.json.mock.calls[0][0];

    expect(newAgent.tool_resources).toBeDefined();
    expect(newAgent.tool_resources.context.file_ids).toEqual(['ctx-file-1']);
    expect(newAgent.tool_resources.execute_code).toBeUndefined();
  });

  it('preserves file_search file_ids when duplicating an agent', async () => {
    const userId = new mongoose.Types.ObjectId();
    const originalAgentId = 'agent_search_files';

    await mongoose.models.Agent.create({
      id: originalAgentId,
      name: 'Search Agent',
      author: userId.toString(),
      provider: 'openai',
      model: 'gpt-4',
      tools: [],
      tool_resources: {
        file_search: { file_ids: ['search-file-1'] },
      },
      versions: [{ name: 'Search Agent', createdAt: new Date(), updatedAt: new Date() }],
    });

    await mongoose.models.File.create({
      file_id: 'search-file-1',
      user: userId,
      filename: 'search-file-1.txt',
      filepath: '/tmp/search-file-1',
      type: 'text/plain',
      bytes: 100,
    });

    const req = {
      params: { id: originalAgentId },
      user: { id: userId.toString(), role: 'user' },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await duplicateAgent(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const { agent: newAgent } = res.json.mock.calls[0][0];

    expect(newAgent.tool_resources).toBeDefined();
    expect(newAgent.tool_resources.file_search).toBeDefined();
    expect(newAgent.tool_resources.file_search.file_ids).toEqual(['search-file-1']);
  });

  it('preserves image_edit file_ids when duplicating an agent', async () => {
    const userId = new mongoose.Types.ObjectId();
    const originalAgentId = 'agent_image_edits';

    await mongoose.models.Agent.create({
      id: originalAgentId,
      name: 'Image Agent',
      author: userId.toString(),
      provider: 'openai',
      model: 'gpt-4',
      tools: [],
      tool_resources: {
        image_edit: { file_ids: ['image-file-1'] },
      },
      versions: [{ name: 'Image Agent', createdAt: new Date(), updatedAt: new Date() }],
    });

    await mongoose.models.File.create({
      file_id: 'image-file-1',
      user: userId,
      filename: 'image-file-1.png',
      filepath: '/tmp/image-file-1',
      type: 'image/png',
      bytes: 100,
    });

    const req = {
      params: { id: originalAgentId },
      user: { id: userId.toString(), role: 'user' },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await duplicateAgent(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const { agent: newAgent } = res.json.mock.calls[0][0];

    expect(newAgent.tool_resources).toBeDefined();
    expect(newAgent.tool_resources.image_edit).toBeDefined();
    expect(newAgent.tool_resources.image_edit.file_ids).toEqual(['image-file-1']);
  });

  it('folds legacy ocr file_ids into context on the duplicate', async () => {
    const userId = new mongoose.Types.ObjectId();
    const originalAgentId = 'agent_legacy_ocr';

    await mongoose.models.Agent.create({
      id: originalAgentId,
      name: 'Legacy OCR Agent',
      author: userId.toString(),
      provider: 'openai',
      model: 'gpt-4',
      tools: [],
      tool_resources: {
        ocr: { file_ids: ['ocr-file-1'] },
      },
      versions: [{ name: 'Legacy OCR Agent', createdAt: new Date(), updatedAt: new Date() }],
    });

    await mongoose.models.File.create({
      file_id: 'ocr-file-1',
      user: userId,
      filename: 'ocr-file-1.pdf',
      filepath: '/tmp/ocr-file-1',
      type: 'application/pdf',
      bytes: 100,
    });

    const req = {
      params: { id: originalAgentId },
      user: { id: userId.toString(), role: 'user' },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await duplicateAgent(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const { agent: newAgent } = res.json.mock.calls[0][0];

    expect(newAgent.tool_resources.context).toBeDefined();
    expect(newAgent.tool_resources.context.file_ids).toEqual(['ocr-file-1']);
    expect(newAgent.tool_resources.ocr).toBeUndefined();
  });
});

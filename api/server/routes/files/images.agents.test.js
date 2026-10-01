const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const { createMethods, logger } = require('@librechat/data-schemas');
const { MongoMemoryServer } = require('mongodb-memory-server');
const {
  SystemRoles,
  AccessRoleIds,
  ResourceType,
  PrincipalType,
} = require('librechat-data-provider');
const { createAgent } = require('~/models');

jest.mock('~/server/services/Files/process', () => ({
  processAgentFileUpload: jest.fn().mockImplementation(async ({ res }) => {
    return res.status(200).json({ message: 'Agent file uploaded', file_id: 'test-file-id' });
  }),
  processImageFile: jest.fn().mockImplementation(async ({ res }) => {
    return res.status(200).json({ message: 'Image processed' });
  }),
  filterFile: jest.fn(),
}));

jest.mock('~/server/services/Files/routing', () => {
  const actual = jest.requireActual('~/server/services/Files/routing');
  return {
    ...actual,
    /* Real by default so the dispatch is exercised end to end; individual tests override
     * it for a single call to stand in for a routing configuration. */
    resolveEffectiveToolResource: jest.fn((...args) =>
      actual.resolveEffectiveToolResource(...args),
    ),
  };
});

jest.mock('fs', () => {
  const actualFs = jest.requireActual('fs');
  return {
    ...actualFs,
    promises: {
      ...actualFs.promises,
      unlink: jest.fn().mockResolvedValue(undefined),
    },
  };
});

const fs = require('fs');
const { processAgentFileUpload, processImageFile } = require('~/server/services/Files/process');
const { resolveEffectiveToolResource } = require('~/server/services/Files/routing');
const { filterFile } = require('~/server/services/Files/process');
const { UninspectableFileError } = require('@librechat/api');

const router = require('~/server/routes/files/images');

describe('POST /images - Agent Upload Permission Check (Integration)', () => {
  let mongoServer;
  let authorId;
  let otherUserId;
  let agentCustomId;
  let User;
  let Agent;
  let AclEntry;
  let methods;
  let modelsToCleanup = [];

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);

    const { createModels } = require('@librechat/data-schemas');
    const models = createModels(mongoose);
    modelsToCleanup = Object.keys(models);
    Object.assign(mongoose.models, models);
    methods = createMethods(mongoose);

    User = models.User;
    Agent = models.Agent;
    AclEntry = models.AclEntry;

    await methods.seedDefaultRoles();
  });

  afterAll(async () => {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }
    for (const modelName of modelsToCleanup) {
      if (mongoose.models[modelName]) {
        delete mongoose.models[modelName];
      }
    }
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Agent.deleteMany({});
    await User.deleteMany({});
    await AclEntry.deleteMany({});

    authorId = new mongoose.Types.ObjectId();
    otherUserId = new mongoose.Types.ObjectId();
    agentCustomId = `agent_${uuidv4().replace(/-/g, '').substring(0, 21)}`;

    await User.create({ _id: authorId, username: 'author', email: 'author@test.com' });
    await User.create({ _id: otherUserId, username: 'other', email: 'other@test.com' });

    jest.clearAllMocks();
  });

  const createAppWithUser = (
    userId,
    userRole = SystemRoles.USER,
    config = {},
    fileOverrides = {},
  ) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.method === 'POST') {
        req.file = {
          originalname: 'test.png',
          mimetype: 'image/png',
          size: 100,
          path: '/tmp/t.png',
          filename: 'test.png',
          ...fileOverrides,
        };
        req.file_id = uuidv4();
      }
      next();
    });
    app.use((req, _res, next) => {
      req.user = { id: userId.toString(), role: userRole };
      req.app = { locals: {} };
      req.config = {
        fileStrategy: 'local',
        paths: { imageOutput: '/tmp/images' },
        ...config,
      };
      next();
    });
    app.use('/images', router);
    return app;
  };

  it('inspects the canonical sanitized image filename used by upload processing', async () => {
    await createAgent({
      id: agentCustomId,
      name: 'Test Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: authorId,
    });
    const app = createAppWithUser(
      authorId,
      SystemRoles.USER,
      {
        filters: {
          files: {
            pii: {
              fields: ['name'],
              starterPatterns: [],
              customPatterns: [
                { id: 'canonical-name', label: 'canonical name', regex: 'PRIVATE_IMAGE' },
              ],
            },
          },
        },
      },
      { originalname: 'PRIVATE IMAGE.png' },
    );

    const response = await request(app).post('/images').send({
      endpoint: 'agents',
      agent_id: agentCustomId,
      tool_resource: 'context',
      file_id: uuidv4(),
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: 'content_filter_block',
      source: 'file',
      field: 'name',
    });
    expect(processAgentFileUpload).not.toHaveBeenCalled();
    expect(processImageFile).not.toHaveBeenCalled();
  });

  it('should return 403 when user has no permission on agent', async () => {
    await createAgent({
      id: agentCustomId,
      name: 'Test Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: authorId,
    });

    const app = createAppWithUser(otherUserId);
    const response = await request(app).post('/images').send({
      endpoint: 'agents',
      agent_id: agentCustomId,
      tool_resource: 'context',
      file_id: uuidv4(),
    });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Forbidden');
    expect(processAgentFileUpload).not.toHaveBeenCalled();
    expect(fs.promises.unlink).toHaveBeenCalledWith('/tmp/t.png');
  });

  it('denies an unauthorized caller before validating against the agent', async () => {
    /* Image validation applies the target agent's provider policy, so reaching it first
     * answers an unauthorized caller with that agent's configuration instead of a 403. */
    await createAgent({
      id: agentCustomId,
      name: 'Test Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: authorId,
    });

    const app = createAppWithUser(otherUserId, SystemRoles.USER, {
      filters: {
        files: {
          pii: {
            fields: ['content'],
            starterPatterns: [],
            customPatterns: [],
            uninspectable: 'block',
          },
        },
      },
    });
    const response = await request(app).post('/images').send({
      endpoint: 'agents',
      agent_id: agentCustomId,
      tool_resource: 'context',
      file_id: uuidv4(),
    });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Forbidden');
    expect(processAgentFileUpload).not.toHaveBeenCalled();
  });

  it('should allow upload for agent owner', async () => {
    await createAgent({
      id: agentCustomId,
      name: 'Test Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: authorId,
    });

    const app = createAppWithUser(authorId);
    const response = await request(app).post('/images').send({
      endpoint: 'agents',
      agent_id: agentCustomId,
      tool_resource: 'context',
      file_id: uuidv4(),
    });

    expect(response.status).toBe(200);
    expect(processAgentFileUpload).toHaveBeenCalled();
  });

  it('rejects a none-routed image for a standard chat', async () => {
    const app = createAppWithUser(authorId, SystemRoles.USER, {
      fileConfig: {
        endpoints: {
          openAI: { defaultLLMDeliveryPath: { overrides: { 'image/*': 'none' } } },
        },
      },
    });

    const response = await request(app).post('/images').send({
      endpoint: 'openAI',
      message_file: 'true',
      file_id: uuidv4(),
    });

    expect(response.status).toBe(500);
    expect(processImageFile).not.toHaveBeenCalled();
    expect(processAgentFileUpload).not.toHaveBeenCalled();
  });

  it.each(['content', 'extracted_text'])(
    'blocks opaque image %s before processing side effects',
    async (field) => {
      await createAgent({
        id: agentCustomId,
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
      });
      const app = createAppWithUser(authorId, SystemRoles.USER, {
        filters: {
          files: {
            pii: {
              fields: [field],
              starterPatterns: [],
              customPatterns: [],
              uninspectable: 'block',
            },
          },
        },
      });
      const response = await request(app).post('/images').send({
        endpoint: 'agents',
        agent_id: agentCustomId,
        tool_resource: 'context',
        file_id: uuidv4(),
      });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: 'content_filter_uninspectable',
        message: 'Submitted file content could not be inspected before processing.',
        source: 'file',
        field,
      });
      expect(processAgentFileUpload).not.toHaveBeenCalled();
      expect(fs.promises.unlink).toHaveBeenCalledWith('/tmp/t.png');
    },
  );

  it('defers extracted-text fail-close to configured OCR for a supported agent-context image', async () => {
    await createAgent({
      id: agentCustomId,
      name: 'Test Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: authorId,
    });

    const app = createAppWithUser(authorId, SystemRoles.USER, {
      filters: {
        files: {
          pii: {
            fields: ['extracted_text'],
            starterPatterns: [],
            customPatterns: [],
            uninspectable: 'block',
          },
        },
      },
      fileConfig: {
        ocr: { supportedMimeTypes: ['image/png'] },
      },
      ocr: {},
    });
    const response = await request(app).post('/images').send({
      endpoint: 'agents',
      agent_id: agentCustomId,
      tool_resource: 'context',
      file_id: uuidv4(),
    });

    expect(response.status).toBe(200);
    expect(processAgentFileUpload).toHaveBeenCalledTimes(1);
  });

  it('defers extracted-text fail-close for a unified upload the config routes to text', async () => {
    /* Same policy and file as the explicit-context case above, but with no tool_resource.
     * Routing promotes it to a context resource, so the preflight has to see the same
     * downstream extraction rather than fail-closing on an uninspectable derived field. */
    await createAgent({
      id: agentCustomId,
      name: 'Test Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: authorId,
    });
    resolveEffectiveToolResource.mockResolvedValueOnce('context');

    const app = createAppWithUser(authorId, SystemRoles.USER, {
      filters: {
        files: {
          pii: {
            fields: ['extracted_text'],
            starterPatterns: [],
            customPatterns: [],
            uninspectable: 'block',
          },
        },
      },
      fileConfig: {
        ocr: { supportedMimeTypes: ['image/png'] },
      },
      ocr: {},
    });
    const response = await request(app).post('/images').send({
      endpoint: 'agents',
      agent_id: agentCustomId,
      file_id: uuidv4(),
    });

    expect(response.status).toBe(200);
    expect(processAgentFileUpload).toHaveBeenCalledTimes(1);
  });

  it('preserves a deferred extracted-text policy error from image processing', async () => {
    await createAgent({
      id: agentCustomId,
      name: 'Test Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: authorId,
    });
    processAgentFileUpload.mockRejectedValueOnce(new UninspectableFileError('extracted_text'));
    const app = createAppWithUser(authorId, SystemRoles.USER, {
      filters: {
        files: {
          pii: {
            fields: ['extracted_text'],
            starterPatterns: [],
            customPatterns: [],
            uninspectable: 'block',
          },
        },
      },
      fileConfig: {
        ocr: { supportedMimeTypes: ['image/png'] },
      },
      ocr: {},
    });

    const response = await request(app).post('/images').send({
      endpoint: 'agents',
      agent_id: agentCustomId,
      tool_resource: 'context',
      file_id: uuidv4(),
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'content_filter_uninspectable',
      message: 'Submitted file content could not be inspected before processing.',
      source: 'file',
      field: 'extracted_text',
    });
    expect(fs.promises.unlink).toHaveBeenCalledWith(`/tmp/images/${authorId.toString()}/test.png`);
    expect(fs.promises.unlink).toHaveBeenCalledWith('/tmp/t.png');
  });

  it('blocks extracted-text fail-close when configured OCR does not support the image MIME type', async () => {
    await createAgent({
      id: agentCustomId,
      name: 'Test Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: authorId,
    });
    const app = createAppWithUser(authorId, SystemRoles.USER, {
      filters: {
        files: {
          pii: {
            fields: ['extracted_text'],
            starterPatterns: [],
            customPatterns: [],
            uninspectable: 'block',
          },
        },
      },
      fileConfig: {
        ocr: { supportedMimeTypes: ['image/jpeg'] },
      },
      ocr: {},
    });
    const response = await request(app).post('/images').send({
      endpoint: 'agents',
      agent_id: agentCustomId,
      tool_resource: 'context',
      file_id: uuidv4(),
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: 'content_filter_uninspectable',
      field: 'extracted_text',
    });
    expect(processAgentFileUpload).not.toHaveBeenCalled();
  });

  it('preserves raw-content fail-close even when configured OCR supports the image', async () => {
    await createAgent({
      id: agentCustomId,
      name: 'Test Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: authorId,
    });
    const app = createAppWithUser(authorId, SystemRoles.USER, {
      filters: {
        files: {
          pii: {
            fields: ['content'],
            starterPatterns: [],
            customPatterns: [],
            uninspectable: 'block',
          },
        },
      },
      fileConfig: {
        ocr: { supportedMimeTypes: ['image/png'] },
      },
      ocr: {},
    });
    const response = await request(app).post('/images').send({
      endpoint: 'agents',
      agent_id: agentCustomId,
      tool_resource: 'context',
      file_id: uuidv4(),
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: 'content_filter_uninspectable',
      field: 'content',
    });
    expect(processAgentFileUpload).not.toHaveBeenCalled();
  });

  it('should allow upload for admin regardless of ownership', async () => {
    await createAgent({
      id: agentCustomId,
      name: 'Test Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: authorId,
    });

    const app = createAppWithUser(otherUserId, SystemRoles.ADMIN);
    const response = await request(app).post('/images').send({
      endpoint: 'agents',
      agent_id: agentCustomId,
      tool_resource: 'context',
      file_id: uuidv4(),
    });

    expect(response.status).toBe(200);
    expect(processAgentFileUpload).toHaveBeenCalled();
  });

  it('should allow upload for user with EDIT permission', async () => {
    const agent = await createAgent({
      id: agentCustomId,
      name: 'Test Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: authorId,
    });

    const { grantPermission } = require('~/server/services/PermissionService');
    await grantPermission({
      principalType: PrincipalType.USER,
      principalId: otherUserId,
      resourceType: ResourceType.AGENT,
      resourceId: agent._id,
      accessRoleId: AccessRoleIds.AGENT_EDITOR,
      grantedBy: authorId,
    });

    const app = createAppWithUser(otherUserId);
    const response = await request(app).post('/images').send({
      endpoint: 'agents',
      agent_id: agentCustomId,
      tool_resource: 'context',
      file_id: uuidv4(),
    });

    expect(response.status).toBe(200);
    expect(processAgentFileUpload).toHaveBeenCalled();
  });

  it('should deny upload for user with only VIEW permission', async () => {
    const agent = await createAgent({
      id: agentCustomId,
      name: 'Test Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: authorId,
    });

    const { grantPermission } = require('~/server/services/PermissionService');
    await grantPermission({
      principalType: PrincipalType.USER,
      principalId: otherUserId,
      resourceType: ResourceType.AGENT,
      resourceId: agent._id,
      accessRoleId: AccessRoleIds.AGENT_VIEWER,
      grantedBy: authorId,
    });

    const app = createAppWithUser(otherUserId);
    const response = await request(app).post('/images').send({
      endpoint: 'agents',
      agent_id: agentCustomId,
      tool_resource: 'context',
      file_id: uuidv4(),
    });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Forbidden');
    expect(processAgentFileUpload).not.toHaveBeenCalled();
    expect(fs.promises.unlink).toHaveBeenCalledWith('/tmp/t.png');
  });

  it('should skip permission check for regular image uploads without agent_id/tool_resource', async () => {
    const app = createAppWithUser(otherUserId);
    const response = await request(app).post('/images').send({
      endpoint: 'agents',
      file_id: uuidv4(),
    });

    expect(response.status).toBe(200);
  });

  it('validates an agent upload against the provider that will process it', async () => {
    /* The request carries endpoint `agents`, but the agent's own provider governs
     * routing, so it has to govern acceptance too or the two disagree. */
    await createAgent({
      id: agentCustomId,
      name: 'Test Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: authorId,
    });
    const app = createAppWithUser(authorId);

    await request(app).post('/images').send({
      endpoint: 'agents',
      agent_id: agentCustomId,
      tool_resource: 'context',
      file_id: uuidv4(),
    });

    expect(filterFile).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'openai', image: true }),
    );
  });

  it('sends a permanent agent image through the agent upload path', async () => {
    /* The image pipeline always stores a message attachment and never files anything
     * against the agent, so a permanent upload sent there would report success while
     * leaving an orphan. */
    await createAgent({
      id: agentCustomId,
      name: 'Test Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: authorId,
    });
    const app = createAppWithUser(authorId);

    await request(app).post('/images').send({
      endpoint: 'agents',
      agent_id: agentCustomId,
      file_id: uuidv4(),
    });

    expect(processAgentFileUpload).toHaveBeenCalled();
    expect(processImageFile).not.toHaveBeenCalled();
  });

  it('sends an image the config routes to text through the agent upload path', async () => {
    resolveEffectiveToolResource.mockResolvedValueOnce('context');
    const app = createAppWithUser(otherUserId);

    const response = await request(app).post('/images').send({
      endpoint: 'agents',
      file_id: uuidv4(),
    });

    expect(response.status).toBe(200);
    expect(processAgentFileUpload).toHaveBeenCalled();
    expect(processImageFile).not.toHaveBeenCalled();
  });

  it('uses a normalized image error when file protection is active', async () => {
    const rawProviderDetail = 'PRIVATE-IMAGE echoed in provider failure';
    const providerError = Object.assign(new Error(rawProviderDetail), {
      response: {
        status: 502,
        data: rawProviderDetail,
        headers: { 'x-provider-debug': rawProviderDetail },
      },
    });
    processImageFile.mockRejectedValueOnce(providerError);
    const errorLogSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    const app = createAppWithUser(otherUserId, SystemRoles.USER, {
      filters: {
        files: {
          pii: {
            fields: ['name'],
          },
        },
      },
    });

    const response = await request(app).post('/images').send({
      endpoint: 'agents',
      file_id: uuidv4(),
    });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ message: 'Error processing file' });
    expect(JSON.stringify(response.body)).not.toContain(rawProviderDetail);
    expect(JSON.stringify(errorLogSpy.mock.calls)).not.toContain(rawProviderDetail);
    errorLogSpy.mockRestore();
  });

  it('preserves legacy image error details when file protection is inactive', async () => {
    const legacyMessage = 'Invalid file format: .legacy';
    processImageFile.mockRejectedValueOnce(new Error(legacyMessage));
    const app = createAppWithUser(otherUserId);

    const response = await request(app).post('/images').send({
      endpoint: 'agents',
      file_id: uuidv4(),
    });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ message: legacyMessage });
  });

  it.each([
    [
      'file policy',
      {
        filters: {
          files: {
            pii: { fields: ['name'], starterPatterns: [], customPatterns: [] },
          },
        },
      },
    ],
    [
      'legacy message policy',
      { messageFilter: { pii: { starterPatterns: [], customPatterns: [] } } },
    ],
  ])('preserves image error details for an inert %s', async (_label, config) => {
    const legacyMessage = 'Invalid file format: .legacy';
    processImageFile.mockRejectedValueOnce(new Error(legacyMessage));
    const app = createAppWithUser(otherUserId, SystemRoles.USER, config);

    const response = await request(app).post('/images').send({
      endpoint: 'agents',
      file_id: uuidv4(),
    });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ message: legacyMessage });
  });

  it('normalizes image errors when the legacy message policy is active', async () => {
    const rawProviderDetail = 'Invalid file format: PRIVATE-IMAGE.legacy';
    processImageFile.mockRejectedValueOnce(new Error(rawProviderDetail));
    const app = createAppWithUser(otherUserId, SystemRoles.USER, {
      messageFilter: { pii: {} },
    });

    const response = await request(app).post('/images').send({
      endpoint: 'agents',
      file_id: uuidv4(),
    });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ message: 'Invalid file format' });
    expect(JSON.stringify(response.body)).not.toContain(rawProviderDetail);
  });

  it('should return 404 for non-existent agent', async () => {
    const app = createAppWithUser(otherUserId);
    const response = await request(app).post('/images').send({
      endpoint: 'agents',
      agent_id: 'agent_nonexistent123456789',
      tool_resource: 'context',
      file_id: uuidv4(),
    });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Not Found');
    expect(processAgentFileUpload).not.toHaveBeenCalled();
    expect(fs.promises.unlink).toHaveBeenCalledWith('/tmp/t.png');
  });

  it('should allow message_file attachment (boolean true) without EDIT permission', async () => {
    const agent = await createAgent({
      id: agentCustomId,
      name: 'Test Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: authorId,
    });

    const { grantPermission } = require('~/server/services/PermissionService');
    await grantPermission({
      principalType: PrincipalType.USER,
      principalId: otherUserId,
      resourceType: ResourceType.AGENT,
      resourceId: agent._id,
      accessRoleId: AccessRoleIds.AGENT_VIEWER,
      grantedBy: authorId,
    });

    const app = createAppWithUser(otherUserId);
    const response = await request(app).post('/images').send({
      endpoint: 'agents',
      agent_id: agentCustomId,
      tool_resource: 'context',
      message_file: true,
      file_id: uuidv4(),
    });

    expect(response.status).toBe(200);
    expect(processAgentFileUpload).toHaveBeenCalled();
  });

  it('should allow message_file attachment (string "true") without EDIT permission', async () => {
    const agent = await createAgent({
      id: agentCustomId,
      name: 'Test Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: authorId,
    });

    const { grantPermission } = require('~/server/services/PermissionService');
    await grantPermission({
      principalType: PrincipalType.USER,
      principalId: otherUserId,
      resourceType: ResourceType.AGENT,
      resourceId: agent._id,
      accessRoleId: AccessRoleIds.AGENT_VIEWER,
      grantedBy: authorId,
    });

    const app = createAppWithUser(otherUserId);
    const response = await request(app).post('/images').send({
      endpoint: 'agents',
      agent_id: agentCustomId,
      tool_resource: 'context',
      message_file: 'true',
      file_id: uuidv4(),
    });

    expect(response.status).toBe(200);
    expect(processAgentFileUpload).toHaveBeenCalled();
  });

  it('should deny upload when message_file is false (not a message attachment)', async () => {
    const agent = await createAgent({
      id: agentCustomId,
      name: 'Test Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: authorId,
    });

    const { grantPermission } = require('~/server/services/PermissionService');
    await grantPermission({
      principalType: PrincipalType.USER,
      principalId: otherUserId,
      resourceType: ResourceType.AGENT,
      resourceId: agent._id,
      accessRoleId: AccessRoleIds.AGENT_VIEWER,
      grantedBy: authorId,
    });

    const app = createAppWithUser(otherUserId);
    const response = await request(app).post('/images').send({
      endpoint: 'agents',
      agent_id: agentCustomId,
      tool_resource: 'context',
      message_file: false,
      file_id: uuidv4(),
    });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Forbidden');
    expect(processAgentFileUpload).not.toHaveBeenCalled();
    expect(fs.promises.unlink).toHaveBeenCalledWith('/tmp/t.png');
  });
});

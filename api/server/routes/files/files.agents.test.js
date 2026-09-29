const express = require('express');
const fs = require('fs').promises;
const request = require('supertest');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createMethods, logger, SystemCapabilities } = require('@librechat/data-schemas');
const {
  SystemRoles,
  AccessRoleIds,
  ResourceType,
  EToolResources,
  PrincipalType,
} = require('librechat-data-provider');
const { createAgent, createFile } = require('~/models');

// Only mock the external dependencies that we don't want to test
jest.mock('~/server/services/Files/process', () => ({
  processDeleteRequest: jest.fn().mockResolvedValue({ deletedFileIds: [], failedFileIds: [] }),
  filterFile: jest.fn(),
  processFileUpload: jest.fn(),
  processAgentFileUpload: jest.fn().mockImplementation(async ({ res }) => {
    // processAgentFileUpload sends response directly via res.json()
    return res.status(200).json({
      message: 'Agent file uploaded and processed successfully',
      file_id: 'test-file-id',
    });
  }),
}));

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(() => ({})),
}));

jest.mock('~/server/controllers/assistants/helpers', () => ({
  getOpenAIClient: jest.fn(),
}));

jest.mock('~/server/services/Tools/credentials', () => ({
  loadAuthValues: jest.fn(),
}));

jest.mock('sharp', () =>
  jest.fn(() => ({
    metadata: jest.fn().mockResolvedValue({}),
    toFormat: jest.fn().mockReturnThis(),
    toBuffer: jest.fn().mockResolvedValue(Buffer.alloc(0)),
  })),
);

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  refreshS3FileUrls: jest.fn(),
}));

jest.mock('~/cache', () => ({
  getLogStores: jest.fn(() => ({
    get: jest.fn(),
    set: jest.fn(),
  })),
}));

// Mock fs.promises.unlink to prevent file cleanup errors in tests
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

const { processAgentFileUpload } = require('~/server/services/Files/process');
const { UninspectableFileError } = require('@librechat/api');

// Import the router
const router = require('~/server/routes/files/files');

describe('File Routes - Agent Files Endpoint', () => {
  let app;
  let mongoServer;
  let authorId;
  let otherUserId;
  let agentId;
  let fileId1;
  let fileId2;
  let fileId3;
  let File;
  let User;
  let Agent;
  let methods;
  let AclEntry;
  // eslint-disable-next-line no-unused-vars
  let AccessRole;
  let SystemGrant;
  let modelsToCleanup = [];

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);

    // Initialize all models using createModels
    const { createModels } = require('@librechat/data-schemas');
    const models = createModels(mongoose);

    // Track which models we're adding
    modelsToCleanup = Object.keys(models);

    // Register models on mongoose.models so methods can access them
    Object.assign(mongoose.models, models);

    // Create methods with our test mongoose instance
    methods = createMethods(mongoose);

    // Now we can access models from the db/models
    File = models.File;
    Agent = models.Agent;
    AclEntry = models.AclEntry;
    User = models.User;
    AccessRole = models.AccessRole;
    SystemGrant = models.SystemGrant;

    // Seed default roles using our methods
    await methods.seedDefaultRoles();

    app = express();
    app.use(express.json());

    // Mock authentication middleware
    app.use((req, res, next) => {
      req.user = { id: otherUserId || 'default-user' };
      req.app = { locals: {} };
      next();
    });

    app.use('/files', router);
  });

  afterAll(async () => {
    // Clean up all collections before disconnecting
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }

    // Clear only the models we added
    for (const modelName of modelsToCleanup) {
      if (mongoose.models[modelName]) {
        delete mongoose.models[modelName];
      }
    }

    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    // Clean up all test data
    await File.deleteMany({});
    await Agent.deleteMany({});
    await User.deleteMany({});
    await AclEntry.deleteMany({});
    // Don't delete AccessRole as they are seeded defaults needed for tests

    // Create test users
    authorId = new mongoose.Types.ObjectId();
    otherUserId = new mongoose.Types.ObjectId();
    agentId = uuidv4();
    fileId1 = uuidv4();
    fileId2 = uuidv4();
    fileId3 = uuidv4();

    // Create users in database
    await User.create({
      _id: authorId,
      username: 'author',
      email: 'author@test.com',
    });

    await User.create({
      _id: otherUserId,
      username: 'other',
      email: 'other@test.com',
    });

    // Create files
    await createFile({
      user: authorId,
      file_id: fileId1,
      filename: 'file1.txt',
      filepath: '/uploads/file1.txt',
      bytes: 100,
      type: 'text/plain',
    });

    await createFile({
      user: authorId,
      file_id: fileId2,
      filename: 'file2.txt',
      filepath: '/uploads/file2.txt',
      bytes: 200,
      type: 'text/plain',
    });

    await createFile({
      user: otherUserId,
      file_id: fileId3,
      filename: 'file3.txt',
      filepath: '/uploads/file3.txt',
      bytes: 300,
      type: 'text/plain',
    });
  });

  describe('GET /files/agent/:agent_id', () => {
    it('should return files accessible through the agent for non-author with EDIT permission', async () => {
      // Create an agent with files attached
      const agent = await createAgent({
        id: agentId,
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
        tool_resources: {
          file_search: {
            file_ids: [fileId1, fileId2, fileId3],
          },
        },
      });

      // Grant EDIT permission to user on the agent using PermissionService
      const { grantPermission } = require('~/server/services/PermissionService');
      await grantPermission({
        principalType: PrincipalType.USER,
        principalId: otherUserId,
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
        accessRoleId: AccessRoleIds.AGENT_EDITOR,
        grantedBy: authorId,
      });

      // Mock req.user for this request
      app.use((req, res, next) => {
        req.user = { id: otherUserId.toString() };
        next();
      });

      const response = await request(app).get(`/files/agent/${agentId}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body).toHaveLength(3);
      expect(response.body.map((f) => f.file_id)).toContain(fileId1);
      expect(response.body.map((f) => f.file_id)).toContain(fileId2);
      expect(response.body.map((f) => f.file_id)).toContain(fileId3);
    });

    it('should return 400 when agent_id is not provided', async () => {
      const response = await request(app).get('/files/agent/');

      expect(response.status).toBe(404); // Express returns 404 for missing route parameter
    });

    it('should return empty array for non-existent agent', async () => {
      const response = await request(app).get('/files/agent/non-existent-agent');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body).toEqual([]);
    });

    it('should return empty array when user only has VIEW permission', async () => {
      // Create an agent with files attached
      const agent = await createAgent({
        id: agentId,
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
        tool_resources: {
          file_search: {
            file_ids: [fileId1, fileId2],
          },
        },
      });

      // Grant only VIEW permission to user on the agent
      const { grantPermission } = require('~/server/services/PermissionService');
      await grantPermission({
        principalType: PrincipalType.USER,
        principalId: otherUserId,
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
        grantedBy: authorId,
      });

      const response = await request(app).get(`/files/agent/${agentId}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body).toEqual([]);
    });

    it('should return agent files for agent author', async () => {
      // Create an agent with files attached
      await createAgent({
        id: agentId,
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
        tool_resources: {
          file_search: {
            file_ids: [fileId1, fileId2],
          },
        },
      });

      // Create a new app instance with author authentication
      const authorApp = express();
      authorApp.use(express.json());
      authorApp.use((req, res, next) => {
        req.user = { id: authorId.toString() };
        req.app = { locals: {} };
        next();
      });
      authorApp.use('/files', router);

      const response = await request(authorApp).get(`/files/agent/${agentId}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body).toHaveLength(2);
    });

    it('should return attached files uploaded by another editor', async () => {
      const agent = await createAgent({
        id: agentId,
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
        tool_resources: {
          file_search: {
            file_ids: [fileId1, fileId3],
          },
        },
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

      // Create a new app instance with author authentication
      const authorApp = express();
      authorApp.use(express.json());
      authorApp.use((req, res, next) => {
        req.user = { id: authorId.toString() };
        req.app = { locals: {} };
        next();
      });
      authorApp.use('/files', router);

      const response = await request(authorApp).get(`/files/agent/${agentId}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body).toHaveLength(2);
      expect(response.body.map((f) => f.file_id)).toContain(fileId1);
      expect(response.body.map((f) => f.file_id)).toContain(fileId3);
    });
  });

  describe('POST /files - Agent File Upload Permission Check', () => {
    let agentCustomId;

    beforeEach(async () => {
      agentCustomId = `agent_${uuidv4().replace(/-/g, '').substring(0, 21)}`;
      jest.clearAllMocks();
    });

    /**
     * Helper to create an Express app with specific user context
     */
    const createAppWithUser = (
      userId,
      userRole = SystemRoles.USER,
      config = {},
      fileOverrides = {},
    ) => {
      const testApp = express();
      testApp.use(express.json());

      // Mock multer - populate req.file
      testApp.use((req, res, next) => {
        if (req.method === 'POST') {
          req.file = {
            originalname: 'test.txt',
            mimetype: 'text/plain',
            size: 100,
            path: '/tmp/test.txt',
            ...fileOverrides,
          };
          req.file_id = uuidv4();
        }
        next();
      });

      testApp.use((req, res, next) => {
        req.user = { id: userId.toString(), role: userRole };
        req.app = { locals: {} };
        req.config = { fileStrategy: 'local', ...config };
        next();
      });

      testApp.use('/files', router);
      return testApp;
    };

    it.each([
      [false, 'application/json'],
      [true, 'text/event-stream'],
    ])(
      'rejects unsupported provider audio before persistence (legacy=%s, accept=%s)',
      async (legacyFileUploadUX, accept) => {
        const testApp = createAppWithUser(
          otherUserId,
          SystemRoles.USER,
          {
            fileConfig: {
              endpoints: { MyGateway: { supportedMimeTypes: ['audio/.*'], legacyFileUploadUX } },
            },
          },
          { originalname: 'clip.wma', mimetype: 'audio/wma' },
        );
        const response = await request(testApp).post('/files').set('Accept', accept).send({
          endpoint: 'MyGateway',
          file_id: uuidv4(),
        });
        expect(response.status).toBe(415);
        expect(response.body.message).toBe('com_error_files_provider_audio_format');
        expect(processAgentFileUpload).not.toHaveBeenCalled();
        expect(fs.unlink).toHaveBeenCalledWith('/tmp/test.txt');
      },
    );

    it('inspects the canonical sanitized filename used by upload processing', async () => {
      await createAgent({
        id: agentCustomId,
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
      });
      const testApp = createAppWithUser(
        authorId,
        SystemRoles.USER,
        {
          filters: {
            files: {
              pii: {
                fields: ['name'],
                starterPatterns: [],
                customPatterns: [
                  { id: 'canonical-name', label: 'canonical name', regex: 'PRIVATE_FILE' },
                ],
              },
            },
          },
        },
        { originalname: 'PRIVATE FILE.txt' },
      );

      const response = await request(testApp).post('/files').send({
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
    });

    it('denies an unauthorized caller before validating against the agent', async () => {
      /* Size and content validation run under the target agent's provider policy, so
       * reaching them first answers an unauthorized caller with that agent's
       * configuration instead of a 403. */
      await createAgent({
        id: agentCustomId,
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
      });

      const readFile = jest.spyOn(fs, 'readFile');
      const testApp = createAppWithUser(
        otherUserId,
        SystemRoles.USER,
        {
          filters: {
            files: {
              pii: {
                fields: ['content'],
                uninspectable: 'block',
              },
            },
          },
        },
        { mimetype: 'application/octet-stream', size: 15 * 1024 * 1024 + 1 },
      );

      const response = await request(testApp).post('/files').send({
        endpoint: 'agents',
        agent_id: agentCustomId,
        tool_resource: 'context',
        file_id: uuidv4(),
      });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Forbidden');
      expect(readFile).not.toHaveBeenCalled();
      expect(processAgentFileUpload).not.toHaveBeenCalled();
      readFile.mockRestore();
    });

    it('should deny file upload to agent when user has no permission', async () => {
      // Create an agent owned by authorId
      await createAgent({
        id: agentCustomId,
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
      });

      const testApp = createAppWithUser(otherUserId);

      const response = await request(testApp).post('/files').send({
        endpoint: 'agents',
        agent_id: agentCustomId,
        tool_resource: 'context',
        file_id: uuidv4(),
      });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Forbidden');
      expect(response.body.message).toBe('Insufficient permissions to upload files to this agent');
      expect(processAgentFileUpload).not.toHaveBeenCalled();
    });

    it('should allow file upload to agent for agent author', async () => {
      // Create an agent owned by authorId
      await createAgent({
        id: agentCustomId,
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
      });

      const testApp = createAppWithUser(authorId);

      const response = await request(testApp).post('/files').send({
        endpoint: 'agents',
        agent_id: agentCustomId,
        tool_resource: 'context',
        file_id: uuidv4(),
      });

      expect(response.status).toBe(200);
      expect(processAgentFileUpload).toHaveBeenCalled();
    });

    it('inspects mislabeled text content before upload processing', async () => {
      await createAgent({
        id: agentCustomId,
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
      });
      const readFile = jest
        .spyOn(fs, 'readFile')
        .mockResolvedValueOnce(Buffer.from('Contains PRIVATE-1234'));
      const testApp = createAppWithUser(
        authorId,
        SystemRoles.USER,
        {
          filters: {
            files: {
              pii: {
                fields: ['content'],
                starterPatterns: [],
                customPatterns: [
                  { id: 'private_token', label: 'private token', regex: 'PRIVATE-\\d+' },
                ],
              },
            },
          },
        },
        { mimetype: 'application/octet-stream' },
      );

      const response = await request(testApp).post('/files').send({
        endpoint: 'agents',
        agent_id: agentCustomId,
        tool_resource: 'context',
        file_id: uuidv4(),
      });

      expect(response.status).toBe(400);
      expect(response.body).toEqual(
        expect.objectContaining({
          error: 'content_filter_block',
          source: 'file',
          field: 'content',
        }),
      );
      expect(processAgentFileUpload).not.toHaveBeenCalled();
      readFile.mockRestore();
    });

    it('blocks opaque file content before upload processing when configured fail-closed', async () => {
      await createAgent({
        id: agentCustomId,
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
      });
      const readFile = jest
        .spyOn(fs, 'readFile')
        .mockResolvedValueOnce(Buffer.from([0, 255, 0, 137, 80, 78, 71]));
      const testApp = createAppWithUser(
        authorId,
        SystemRoles.USER,
        {
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
        },
        { mimetype: 'application/octet-stream' },
      );

      const response = await request(testApp).post('/files').send({
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
        field: 'content',
      });
      expect(processAgentFileUpload).not.toHaveBeenCalled();
      readFile.mockRestore();
    });

    it.each([
      ['PDF', 'report.pdf', 'application/pdf'],
      [
        'DOCX',
        'report.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ],
    ])(
      'lets a supported binary %s context document reach extracted-text processing',
      async (_label, originalname, mimetype) => {
        await createAgent({
          id: agentCustomId,
          name: 'Test Agent',
          provider: 'openai',
          model: 'gpt-4',
          author: authorId,
        });
        const readFile = jest
          .spyOn(fs, 'readFile')
          .mockResolvedValueOnce(Buffer.from([0, 255, 0, 80, 68, 70]));
        const testApp = createAppWithUser(
          authorId,
          SystemRoles.USER,
          {
            filters: {
              files: {
                pii: {
                  fields: ['extracted_text'],
                  uninspectable: 'block',
                },
              },
            },
          },
          { originalname, mimetype },
        );

        const response = await request(testApp).post('/files').send({
          endpoint: 'agents',
          agent_id: agentCustomId,
          tool_resource: 'context',
          file_id: uuidv4(),
        });

        expect(response.status).toBe(200);
        expect(processAgentFileUpload).toHaveBeenCalledWith(
          expect.objectContaining({
            req: expect.objectContaining({
              file: expect.objectContaining({ mimetype }),
            }),
            metadata: expect.objectContaining({ tool_resource: EToolResources.context }),
          }),
        );
        readFile.mockRestore();
      },
    );

    it('returns a raw-free policy error when deferred document extraction fails', async () => {
      await createAgent({
        id: agentCustomId,
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
      });
      const readFile = jest
        .spyOn(fs, 'readFile')
        .mockResolvedValueOnce(Buffer.from([0, 255, 0, 80, 68, 70]));
      const parserFailure = Object.assign(
        new Error('PRIVATE parser response and document fragment'),
        { response: { status: 502, data: 'PRIVATE extracted content' } },
      );
      const { getStrategyFunctions } = require('~/server/services/Files/strategies');
      getStrategyFunctions.mockReturnValueOnce({
        handleFileUpload: jest.fn().mockRejectedValue(parserFailure),
      });
      const { processAgentFileUpload: processAgentFileUploadActual } = jest.requireActual(
        '~/server/services/Files/process',
      );
      processAgentFileUpload.mockImplementationOnce(processAgentFileUploadActual);
      const testApp = createAppWithUser(
        authorId,
        SystemRoles.USER,
        {
          filters: {
            files: {
              pii: {
                fields: ['extracted_text'],
                uninspectable: 'block',
              },
            },
          },
        },
        { originalname: 'report.pdf', mimetype: 'application/pdf' },
      );
      const filesBefore = await File.countDocuments();

      const response = await request(testApp).post('/files').send({
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
      expect(JSON.stringify(response.body)).not.toContain('PRIVATE');
      expect(await File.countDocuments()).toBe(filesBefore);
      readFile.mockRestore();
    });

    it('does not defer raw content fail-close when extracted text is also selected', async () => {
      await createAgent({
        id: agentCustomId,
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
      });
      const readFile = jest
        .spyOn(fs, 'readFile')
        .mockResolvedValueOnce(Buffer.from([0, 255, 0, 80, 68, 70]));
      const testApp = createAppWithUser(
        authorId,
        SystemRoles.USER,
        {
          filters: {
            files: {
              pii: {
                fields: ['content', 'extracted_text'],
                uninspectable: 'block',
              },
            },
          },
        },
        { originalname: 'report.pdf', mimetype: 'application/pdf' },
      );

      const response = await request(testApp).post('/files').send({
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
        field: 'content',
      });
      expect(processAgentFileUpload).not.toHaveBeenCalled();
      readFile.mockRestore();
    });

    it('does not defer extracted-text fail-close for non-context agent resources', async () => {
      await createAgent({
        id: agentCustomId,
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
      });
      const readFile = jest
        .spyOn(fs, 'readFile')
        .mockResolvedValueOnce(Buffer.from([0, 255, 0, 80, 68, 70]));
      const testApp = createAppWithUser(
        authorId,
        SystemRoles.USER,
        {
          filters: {
            files: {
              pii: {
                fields: ['extracted_text'],
                uninspectable: 'block',
              },
            },
          },
        },
        { originalname: 'report.pdf', mimetype: 'application/pdf' },
      );

      const response = await request(testApp).post('/files').send({
        endpoint: 'agents',
        agent_id: agentCustomId,
        tool_resource: 'file_search',
        file_id: uuidv4(),
      });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: 'content_filter_uninspectable',
        message: 'Submitted file content could not be inspected before processing.',
        source: 'file',
        field: 'extracted_text',
      });
      expect(processAgentFileUpload).not.toHaveBeenCalled();
      readFile.mockRestore();
    });

    it.each([
      ['an unsupported binary', 'archive.bin', 'application/octet-stream'],
      ['audio handled as a transcript', 'recording.mp3', 'audio/mpeg'],
    ])('does not defer extracted-text fail-close for %s', async (_, originalname, mimetype) => {
      await createAgent({
        id: agentCustomId,
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
      });
      const readFile = jest
        .spyOn(fs, 'readFile')
        .mockResolvedValueOnce(Buffer.from([0, 255, 0, 80, 68, 70]));
      const testApp = createAppWithUser(
        authorId,
        SystemRoles.USER,
        {
          filters: {
            files: {
              pii: {
                fields: ['extracted_text'],
                uninspectable: 'block',
              },
            },
          },
        },
        { originalname, mimetype },
      );

      const response = await request(testApp).post('/files').send({
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
      expect(processAgentFileUpload).not.toHaveBeenCalled();
      readFile.mockRestore();
    });

    it.each([
      [
        'an inert content policy',
        {
          fields: ['content'],
          starterPatterns: [],
          customPatterns: [],
        },
      ],
      [
        'an active name-only policy',
        {
          fields: ['name'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private', regex: 'PRIVATE-\\d+' }],
        },
      ],
    ])('does not read uploaded bytes for %s', async (_label, pii) => {
      const readFile = jest.spyOn(fs, 'readFile');
      const testApp = createAppWithUser(otherUserId, SystemRoles.USER, {
        filters: { files: { pii } },
      });

      const response = await request(testApp).post('/files').send({
        endpoint: 'agents',
        file_id: uuidv4(),
      });

      expect(response.status).toBe(200);
      expect(readFile).not.toHaveBeenCalled();
      expect(processAgentFileUpload).toHaveBeenCalled();
      readFile.mockRestore();
    });

    it('detects opaque content after a long printable file prefix', async () => {
      await createAgent({
        id: agentCustomId,
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
      });
      const readFile = jest
        .spyOn(fs, 'readFile')
        .mockResolvedValueOnce(Buffer.concat([Buffer.alloc(8192, 'a'), Buffer.from([0, 255])]));
      const testApp = createAppWithUser(
        authorId,
        SystemRoles.USER,
        {
          filters: {
            files: {
              pii: {
                fields: ['content'],
                uninspectable: 'block',
              },
            },
          },
        },
        { mimetype: 'application/octet-stream', size: 8194 },
      );

      const response = await request(testApp).post('/files').send({
        endpoint: 'agents',
        agent_id: agentCustomId,
        tool_resource: 'context',
        file_id: uuidv4(),
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('content_filter_uninspectable');
      expect(processAgentFileUpload).not.toHaveBeenCalled();
      readFile.mockRestore();
    });

    it('allows oversized text content when uninspectable content is allowed', async () => {
      await createAgent({
        id: agentCustomId,
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
      });
      const readFile = jest.spyOn(fs, 'readFile');
      const testApp = createAppWithUser(
        authorId,
        SystemRoles.USER,
        {
          filters: {
            files: {
              pii: {
                fields: ['content'],
                uninspectable: 'allow',
              },
            },
          },
        },
        { size: 15 * 1024 * 1024 + 1 },
      );

      const response = await request(testApp).post('/files').send({
        endpoint: 'agents',
        agent_id: agentCustomId,
        tool_resource: 'context',
        file_id: uuidv4(),
      });

      expect(response.status).toBe(200);
      expect(readFile).not.toHaveBeenCalled();
      expect(processAgentFileUpload).toHaveBeenCalled();
      readFile.mockRestore();
    });

    it('lets STT-supported context audio reach transcript processing under fail-close policy', async () => {
      await createAgent({
        id: agentCustomId,
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
      });
      const testApp = createAppWithUser(
        authorId,
        SystemRoles.USER,
        {
          filters: {
            files: {
              pii: {
                fields: ['transcript'],
                uninspectable: 'block',
              },
            },
          },
        },
        { originalname: 'recording.mp3', mimetype: 'audio/mpeg' },
      );

      const response = await request(testApp).post('/files').send({
        endpoint: 'agents',
        agent_id: agentCustomId,
        tool_resource: 'context',
        file_id: uuidv4(),
      });

      expect(response.status).toBe(200);
      expect(processAgentFileUpload).toHaveBeenCalledWith(
        expect.objectContaining({
          req: expect.objectContaining({
            file: expect.objectContaining({ mimetype: 'audio/mpeg' }),
          }),
          metadata: expect.objectContaining({ tool_resource: EToolResources.context }),
        }),
      );
    });

    it('fails closed when context audio cannot produce an inspectable transcript', async () => {
      await createAgent({
        id: agentCustomId,
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
      });
      processAgentFileUpload.mockRejectedValueOnce(new UninspectableFileError('transcript'));
      const testApp = createAppWithUser(
        authorId,
        SystemRoles.USER,
        {
          filters: {
            files: {
              pii: {
                fields: ['transcript'],
                uninspectable: 'block',
              },
            },
          },
        },
        { originalname: 'recording.mp3', mimetype: 'audio/mpeg' },
      );

      const response = await request(testApp).post('/files').send({
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
        field: 'transcript',
      });
    });

    it('should allow file upload to agent for user with EDIT permission', async () => {
      // Create an agent owned by authorId
      const agent = await createAgent({
        id: agentCustomId,
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
      });

      // Grant EDIT permission to otherUserId
      const { grantPermission } = require('~/server/services/PermissionService');
      await grantPermission({
        principalType: PrincipalType.USER,
        principalId: otherUserId,
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
        accessRoleId: AccessRoleIds.AGENT_EDITOR,
        grantedBy: authorId,
      });

      const testApp = createAppWithUser(otherUserId);

      const response = await request(testApp).post('/files').send({
        endpoint: 'agents',
        agent_id: agentCustomId,
        tool_resource: 'context',
        file_id: uuidv4(),
      });

      expect(response.status).toBe(200);
      expect(processAgentFileUpload).toHaveBeenCalled();
    });

    it('should deny file upload to agent for user with only VIEW permission', async () => {
      // Create an agent owned by authorId
      const agent = await createAgent({
        id: agentCustomId,
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
      });

      // Grant only VIEW permission to otherUserId
      const { grantPermission } = require('~/server/services/PermissionService');
      await grantPermission({
        principalType: PrincipalType.USER,
        principalId: otherUserId,
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
        grantedBy: authorId,
      });

      const testApp = createAppWithUser(otherUserId);

      const response = await request(testApp).post('/files').send({
        endpoint: 'agents',
        agent_id: agentCustomId,
        tool_resource: 'file_search',
        file_id: uuidv4(),
      });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Forbidden');
      expect(processAgentFileUpload).not.toHaveBeenCalled();
    });

    it('should allow file upload for user with MANAGE_AGENTS capability regardless of agent ownership', async () => {
      // Create an agent owned by authorId
      await createAgent({
        id: agentCustomId,
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
      });

      // Seed MANAGE_AGENTS capability for the ADMIN role
      await SystemGrant.create({
        principalType: PrincipalType.ROLE,
        principalId: SystemRoles.ADMIN,
        capability: SystemCapabilities.MANAGE_AGENTS,
        grantedAt: new Date(),
      });

      // Create app with admin user (otherUserId as admin)
      const testApp = createAppWithUser(otherUserId, SystemRoles.ADMIN);

      const response = await request(testApp).post('/files').send({
        endpoint: 'agents',
        agent_id: agentCustomId,
        tool_resource: 'context',
        file_id: uuidv4(),
      });

      expect(response.status).toBe(200);
      expect(processAgentFileUpload).toHaveBeenCalled();
    });

    it('should return 404 when uploading to non-existent agent', async () => {
      const testApp = createAppWithUser(otherUserId);

      const response = await request(testApp).post('/files').send({
        endpoint: 'agents',
        agent_id: 'agent_nonexistent123456789',
        tool_resource: 'context',
        file_id: uuidv4(),
      });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Not Found');
      expect(response.body.message).toBe('Agent not found');
      expect(processAgentFileUpload).not.toHaveBeenCalled();
    });

    it('should allow file upload without agent_id (message attachment)', async () => {
      const testApp = createAppWithUser(otherUserId);

      const response = await request(testApp).post('/files').send({
        endpoint: 'agents',
        file_id: uuidv4(),
        // No agent_id or tool_resource - this is a message attachment
      });

      expect(response.status).toBe(200);
      expect(processAgentFileUpload).toHaveBeenCalled();
    });

    it('uses a normalized upload error when file protection is active', async () => {
      const rawProviderDetail = 'PRIVATE-UPLOAD echoed in provider failure';
      const providerError = Object.assign(new Error(rawProviderDetail), {
        response: {
          status: 502,
          data: rawProviderDetail,
          headers: { 'x-provider-debug': rawProviderDetail },
        },
        userErrorStatusCode: 799,
      });
      processAgentFileUpload.mockRejectedValueOnce(providerError);
      const errorLogSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
      const testApp = createAppWithUser(otherUserId, SystemRoles.USER, {
        filters: {
          files: {
            pii: {
              fields: ['name'],
            },
          },
        },
      });

      const response = await request(testApp).post('/files').send({
        endpoint: 'agents',
        file_id: uuidv4(),
      });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ message: 'Error processing file' });
      expect(JSON.stringify(response.body)).not.toContain(rawProviderDetail);
      expect(JSON.stringify(errorLogSpy.mock.calls)).not.toContain(rawProviderDetail);
      errorLogSpy.mockRestore();
    });

    it('preserves legacy upload error details when file protection is inactive', async () => {
      const legacyMessage = 'Invalid file format: .legacy';
      processAgentFileUpload.mockRejectedValueOnce(
        Object.assign(new Error(legacyMessage), { userErrorStatusCode: 400 }),
      );
      const testApp = createAppWithUser(otherUserId);

      const response = await request(testApp).post('/files').send({
        endpoint: 'agents',
        file_id: uuidv4(),
      });

      expect(response.status).toBe(400);
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
    ])('preserves upload error details for an inert %s', async (_label, config) => {
      const legacyMessage = 'Invalid file format: .legacy';
      processAgentFileUpload.mockRejectedValueOnce(
        Object.assign(new Error(legacyMessage), { userErrorStatusCode: 400 }),
      );
      const testApp = createAppWithUser(otherUserId, SystemRoles.USER, config);

      const response = await request(testApp).post('/files').send({
        endpoint: 'agents',
        file_id: uuidv4(),
      });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ message: legacyMessage });
    });

    it('normalizes upload errors when the legacy message policy is active', async () => {
      const rawProviderDetail = 'Invalid file format: PRIVATE-UPLOAD.legacy';
      processAgentFileUpload.mockRejectedValueOnce(new Error(rawProviderDetail));
      const testApp = createAppWithUser(otherUserId, SystemRoles.USER, {
        messageFilter: { pii: {} },
      });

      const response = await request(testApp).post('/files').send({
        endpoint: 'agents',
        file_id: uuidv4(),
      });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ message: 'Invalid file format' });
      expect(JSON.stringify(response.body)).not.toContain(rawProviderDetail);
    });

    it('should deny a permanent agent upload with no tool_resource from a user without permission', async () => {
      // Create an agent owned by authorId
      await createAgent({
        id: agentCustomId,
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
      });

      const testApp = createAppWithUser(otherUserId);

      /* Unified mode accepts an upload with no tool_resource and promotes it to a
       * context resource, so the permission check has to apply here: otherwise any
       * user could attach persistent context to an agent they cannot edit. */
      const response = await request(testApp).post('/files').send({
        endpoint: 'agents',
        agent_id: agentCustomId,
        file_id: uuidv4(),
      });

      expect(response.status).toBe(403);
      expect(processAgentFileUpload).not.toHaveBeenCalled();
    });

    it('should allow message_file attachment to agent even without EDIT permission', async () => {
      // Create an agent owned by authorId
      const agent = await createAgent({
        id: agentCustomId,
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
      });

      // Grant only VIEW permission to otherUserId
      const { grantPermission } = require('~/server/services/PermissionService');
      await grantPermission({
        principalType: PrincipalType.USER,
        principalId: otherUserId,
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
        grantedBy: authorId,
      });

      const testApp = createAppWithUser(otherUserId);

      // message_file: true indicates this is a chat message attachment, not a permanent file upload
      const response = await request(testApp).post('/files').send({
        endpoint: 'agents',
        agent_id: agentCustomId,
        tool_resource: 'context',
        message_file: true,
        file_id: uuidv4(),
      });

      expect(response.status).toBe(200);
      expect(processAgentFileUpload).toHaveBeenCalled();
    });

    it('should allow message_file attachment (string "true") to agent even without EDIT permission', async () => {
      // Create an agent owned by authorId
      const agent = await createAgent({
        id: agentCustomId,
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
      });

      // Grant only VIEW permission to otherUserId
      const { grantPermission } = require('~/server/services/PermissionService');
      await grantPermission({
        principalType: PrincipalType.USER,
        principalId: otherUserId,
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
        grantedBy: authorId,
      });

      const testApp = createAppWithUser(otherUserId);

      // message_file as string "true" (from form data) should also be allowed
      const response = await request(testApp).post('/files').send({
        endpoint: 'agents',
        agent_id: agentCustomId,
        tool_resource: 'context',
        message_file: 'true',
        file_id: uuidv4(),
      });

      expect(response.status).toBe(200);
      expect(processAgentFileUpload).toHaveBeenCalled();
    });

    it('should deny file upload when message_file is false (not a message attachment)', async () => {
      // Create an agent owned by authorId
      const agent = await createAgent({
        id: agentCustomId,
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
      });

      // Grant only VIEW permission to otherUserId
      const { grantPermission } = require('~/server/services/PermissionService');
      await grantPermission({
        principalType: PrincipalType.USER,
        principalId: otherUserId,
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
        grantedBy: authorId,
      });

      const testApp = createAppWithUser(otherUserId);

      // message_file: false should NOT bypass permission check
      const response = await request(testApp).post('/files').send({
        endpoint: 'agents',
        agent_id: agentCustomId,
        tool_resource: 'context',
        message_file: false,
        file_id: uuidv4(),
      });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Forbidden');
      expect(processAgentFileUpload).not.toHaveBeenCalled();
    });
  });
});

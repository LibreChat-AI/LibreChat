const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { Readable } = require('stream');
const { v4: uuidv4 } = require('uuid');
const { createMethods, tenantStorage } = require('@librechat/data-schemas');
const { MongoMemoryServer } = require('mongodb-memory-server');
const {
  SystemRoles,
  ResourceType,
  AccessRoleIds,
  PrincipalType,
  FileSources,
} = require('librechat-data-provider');
const { createAgent, createFile } = require('~/models');

// Only mock the external dependencies that we don't want to test
jest.mock('~/server/services/Files/process', () => ({
  processDeleteRequest: jest.fn().mockResolvedValue({ deletedFileIds: [], failedFileIds: [] }),
  filterFile: jest.fn(),
  processFileUpload: jest.fn(),
  processAgentFileUpload: jest.fn(),
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
  getCodeExecutionBaseUrl: jest.fn((profile, environment) => {
    if (environment?.baseURL) {
      return environment.baseURL;
    }
    if (profile === 'stateful') {
      return process.env.LIBRECHAT_CODE_BASEURL_STATEFUL;
    }
    return 'https://code-default.example.com/v1';
  }),
}));

jest.mock('~/cache', () => ({
  getLogStores: jest.fn(() => ({
    get: jest.fn(),
    set: jest.fn(),
  })),
}));

jest.mock('~/config', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

const { processDeleteRequest } = require('~/server/services/Files/process');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { createCodeExecutionRouteKey } = require('@librechat/api');

// Import the router after mocks
const router = require('./files');

describe('File Routes - Delete with Agent Access', () => {
  let app;
  let mongoServer;
  let authorId;
  let otherUserId;
  let fileId;
  let File;
  let Agent;
  let AclEntry;
  let User;
  let methods;
  let requestConfig;
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

    // Seed default roles using our methods
    await methods.seedDefaultRoles();

    app = express();
    app.use(express.json());

    app.use((req, res, next) => {
      req.user = {
        id: otherUserId?.toString() || 'default-user',
        role: SystemRoles.USER,
      };
      req.config = requestConfig;
      req.app.locals = {};
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
    jest.clearAllMocks();
    requestConfig = {};

    // Clear database - clean up all test data
    await File.deleteMany({});
    await Agent.deleteMany({});
    await User.deleteMany({});
    await AclEntry.deleteMany({});
    // Don't delete AccessRole as they are seeded defaults needed for tests

    // Create test data
    authorId = new mongoose.Types.ObjectId();
    otherUserId = new mongoose.Types.ObjectId();
    fileId = uuidv4();

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

    // Create a file owned by the author
    await createFile({
      user: authorId,
      file_id: fileId,
      filename: 'test.txt',
      filepath: '/uploads/test.txt',
      bytes: 100,
      type: 'text/plain',
    });
  });

  describe('DELETE /files', () => {
    it('should allow deleting files owned by the user', async () => {
      // Create a file owned by the current user
      const userFileId = uuidv4();
      await createFile({
        user: otherUserId,
        file_id: userFileId,
        filename: 'user-file.txt',
        filepath: '/uploads/user-file.txt',
        bytes: 200,
        type: 'text/plain',
      });

      const response = await request(app)
        .delete('/files')
        .send({
          files: [
            {
              file_id: userFileId,
              filepath: '/uploads/user-file.txt',
            },
          ],
        });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Files deleted successfully');
      expect(processDeleteRequest).toHaveBeenCalled();
    });

    it('should prevent deleting files not owned by user without agent context', async () => {
      const response = await request(app)
        .delete('/files')
        .send({
          files: [
            {
              file_id: fileId,
              filepath: '/uploads/test.txt',
            },
          ],
        });

      expect(response.status).toBe(403);
      expect(response.body.message).toBe('You can only delete files you own');
      expect(response.body.unauthorizedFiles).toContain(fileId);
      expect(processDeleteRequest).not.toHaveBeenCalled();
    });

    it('should prevent physically deleting non-owned files accessible through shared agent', async () => {
      const agent = await createAgent({
        id: uuidv4(),
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
        tool_resources: {
          file_search: {
            file_ids: [fileId],
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

      const response = await request(app)
        .delete('/files')
        .send({
          agent_id: agent.id,
          files: [
            {
              file_id: fileId,
              filepath: '/uploads/test.txt',
            },
          ],
        });

      expect(response.status).toBe(403);
      expect(response.body.message).toBe('You can only delete files you own');
      expect(response.body.unauthorizedFiles).toContain(fileId);
      expect(processDeleteRequest).not.toHaveBeenCalled();
    });

    it('unlinks attached agent files without invoking storage deletion', async () => {
      const agent = await createAgent({
        id: uuidv4(),
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
        tool_resources: {
          file_search: {
            file_ids: [fileId],
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

      const response = await request(app)
        .delete('/files')
        .send({
          agent_id: agent.id,
          tool_resource: 'file_search',
          files: [
            {
              file_id: fileId,
              filepath: '/uploads/test.txt',
            },
          ],
        });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('File associations removed successfully from agent');
      expect(processDeleteRequest).not.toHaveBeenCalled();

      const updatedAgent = await Agent.findOne({ id: agent.id }).lean();
      expect(updatedAgent.tool_resources.file_search.file_ids).toEqual([]);
    });

    it('deletes storage and embeddings for an attached file the caller owns', async () => {
      const ownedFileId = uuidv4();
      await createFile({
        user: otherUserId,
        file_id: ownedFileId,
        filename: 'owned-knowledge.txt',
        filepath: '/uploads/owned-knowledge.txt',
        bytes: 100,
        type: 'text/plain',
        source: FileSources.vectordb,
        embedded: true,
      });

      const agent = await createAgent({
        id: uuidv4(),
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: otherUserId,
        tool_resources: {
          file_search: {
            file_ids: [ownedFileId],
          },
        },
      });

      const response = await request(app)
        .delete('/files')
        .send({
          agent_id: agent.id,
          tool_resource: 'file_search',
          files: [{ file_id: ownedFileId, filepath: '/uploads/owned-knowledge.txt' }],
        });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Files deleted successfully');
      expect(processDeleteRequest).toHaveBeenCalledTimes(1);

      const [{ req, files: deletedFiles }] = processDeleteRequest.mock.calls[0];
      expect(deletedFiles.map((file) => file.file_id)).toEqual([ownedFileId]);
      expect(deletedFiles[0].source).toBe(FileSources.vectordb);
      expect(req.body.agent_id).toBe(agent.id);
      expect(req.body.tool_resource).toBe('file_search');
    });

    it('unlinks another user’s attached file while deleting the caller’s own', async () => {
      const ownedFileId = uuidv4();
      await createFile({
        user: otherUserId,
        file_id: ownedFileId,
        filename: 'owned-knowledge.txt',
        filepath: '/uploads/owned-knowledge.txt',
        bytes: 100,
        type: 'text/plain',
        source: FileSources.vectordb,
        embedded: true,
      });

      const agent = await createAgent({
        id: uuidv4(),
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: otherUserId,
        tool_resources: {
          file_search: {
            file_ids: [ownedFileId, fileId],
          },
        },
      });

      const response = await request(app)
        .delete('/files')
        .send({
          agent_id: agent.id,
          tool_resource: 'file_search',
          files: [
            { file_id: ownedFileId, filepath: '/uploads/owned-knowledge.txt' },
            { file_id: fileId, filepath: '/uploads/test.txt' },
          ],
        });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Files deleted successfully');

      const [{ files: deletedFiles }] = processDeleteRequest.mock.calls[0];
      expect(deletedFiles.map((file) => file.file_id)).toEqual([ownedFileId]);

      const updatedAgent = await Agent.findOne({ id: agent.id }).lean();
      expect(updatedAgent.tool_resources.file_search.file_ids).toEqual([ownedFileId]);

      const retainedFile = await File.findOne({ file_id: fileId }).lean();
      expect(retainedFile).toBeTruthy();
    });

    it('keeps a file the same agent holds under another tool resource', async () => {
      const sharedFileId = uuidv4();
      await createFile({
        user: otherUserId,
        file_id: sharedFileId,
        filename: 'dual-purpose.txt',
        filepath: '/uploads/dual-purpose.txt',
        bytes: 100,
        type: 'text/plain',
        source: FileSources.vectordb,
        embedded: true,
      });

      /* One agent can hold the same file under two resources, so the reference being removed is the
         `(agent, tool_resource)` pair rather than the agent. */
      const agent = await createAgent({
        id: uuidv4(),
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: otherUserId,
        tool_resources: {
          file_search: { file_ids: [sharedFileId] },
          context: { file_ids: [sharedFileId] },
        },
      });

      const response = await request(app)
        .delete('/files')
        .send({
          agent_id: agent.id,
          tool_resource: 'file_search',
          files: [{ file_id: sharedFileId, filepath: '/uploads/dual-purpose.txt' }],
        });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('File associations removed successfully from agent');
      expect(processDeleteRequest).not.toHaveBeenCalled();

      const updatedAgent = await Agent.findOne({ id: agent.id }).lean();
      expect(updatedAgent.tool_resources.file_search.file_ids).toEqual([]);
      expect(updatedAgent.tool_resources.context.file_ids).toEqual([sharedFileId]);

      const retainedFile = await File.findOne({ file_id: sharedFileId }).lean();
      expect(retainedFile).toBeTruthy();
    });

    it('keeps a file a duplicated agent still references, unlinking it here only', async () => {
      const sharedFileId = uuidv4();
      await createFile({
        user: otherUserId,
        file_id: sharedFileId,
        filename: 'shared-knowledge.txt',
        filepath: '/uploads/shared-knowledge.txt',
        bytes: 100,
        type: 'text/plain',
        source: FileSources.vectordb,
        embedded: true,
      });

      const agent = await createAgent({
        id: uuidv4(),
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: otherUserId,
        tool_resources: { file_search: { file_ids: [sharedFileId] } },
      });

      /* Duplicating an agent copies file_ids rather than the files behind them, and lands them
         under `context`, so the second holder is found across tool resources. */
      const duplicate = await createAgent({
        id: uuidv4(),
        name: 'Test Agent (copy)',
        provider: 'openai',
        model: 'gpt-4',
        author: otherUserId,
        tool_resources: { context: { file_ids: [sharedFileId] } },
      });

      const response = await request(app)
        .delete('/files')
        .send({
          agent_id: agent.id,
          tool_resource: 'file_search',
          files: [{ file_id: sharedFileId, filepath: '/uploads/shared-knowledge.txt' }],
        });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('File associations removed successfully from agent');
      expect(processDeleteRequest).not.toHaveBeenCalled();

      const updatedAgent = await Agent.findOne({ id: agent.id }).lean();
      expect(updatedAgent.tool_resources.file_search.file_ids).toEqual([]);

      const untouchedDuplicate = await Agent.findOne({ id: duplicate.id }).lean();
      expect(untouchedDuplicate.tool_resources.context.file_ids).toEqual([sharedFileId]);

      const retainedFile = await File.findOne({ file_id: sharedFileId }).lean();
      expect(retainedFile).toBeTruthy();
    });

    it('leaves an owned file alone when the tool resource does not hold it', async () => {
      const ownedFileId = uuidv4();
      await createFile({
        user: otherUserId,
        file_id: ownedFileId,
        filename: 'detached-knowledge.txt',
        filepath: '/uploads/detached-knowledge.txt',
        bytes: 100,
        type: 'text/plain',
        source: FileSources.vectordb,
        embedded: true,
      });

      const agent = await createAgent({
        id: uuidv4(),
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: otherUserId,
        tool_resources: {
          file_search: {
            file_ids: [fileId],
          },
        },
      });

      const response = await request(app)
        .delete('/files')
        .send({
          agent_id: agent.id,
          tool_resource: 'file_search',
          files: [{ file_id: ownedFileId, filepath: '/uploads/detached-knowledge.txt' }],
        });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('File associations removed successfully from agent');
      expect(processDeleteRequest).not.toHaveBeenCalled();

      const updatedAgent = await Agent.findOne({ id: agent.id }).lean();
      expect(updatedAgent.tool_resources.file_search.file_ids).toEqual([fileId]);
    });

    it('rejects invalid agent tool_resource values before unlinking', async () => {
      const agent = await createAgent({
        id: uuidv4(),
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: otherUserId,
        tool_resources: {
          file_search: {
            file_ids: [fileId],
          },
        },
      });

      const response = await request(app)
        .delete('/files')
        .send({
          agent_id: agent.id,
          tool_resource: 'file_search.$pullAll',
          files: [{ file_id: fileId, filepath: '/uploads/test.txt' }],
        });

      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Invalid agent tool resource');
      expect(processDeleteRequest).not.toHaveBeenCalled();

      const updatedAgent = await Agent.findOne({ id: agent.id }).lean();
      expect(updatedAgent.tool_resources.file_search.file_ids).toEqual([fileId]);
    });

    it('allows an agent author to unlink an editor-owned attached file', async () => {
      const editorFileId = uuidv4();
      await createFile({
        user: otherUserId,
        file_id: editorFileId,
        filename: 'editor-file.txt',
        filepath: '/uploads/editor-file.txt',
        bytes: 300,
        type: 'text/plain',
      });

      const agent = await createAgent({
        id: uuidv4(),
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
        tool_resources: {
          file_search: {
            file_ids: [editorFileId],
          },
        },
      });

      const authorApp = express();
      authorApp.use(express.json());
      authorApp.use((req, res, next) => {
        req.user = {
          id: authorId.toString(),
          role: SystemRoles.USER,
        };
        req.app.locals = {};
        next();
      });
      authorApp.use('/files', router);

      const response = await request(authorApp)
        .delete('/files')
        .send({
          agent_id: agent.id,
          tool_resource: 'file_search',
          files: [{ file_id: editorFileId, filepath: '/uploads/editor-file.txt' }],
        });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('File associations removed successfully from agent');
      expect(processDeleteRequest).not.toHaveBeenCalled();

      const updatedAgent = await Agent.findOne({ id: agent.id }).lean();
      expect(updatedAgent.tool_resources.file_search.file_ids).toEqual([]);

      const retainedFile = await File.findOne({ file_id: editorFileId }).lean();
      expect(retainedFile).toBeTruthy();
    });

    it('should prevent physically deleting attached files owned by another user', async () => {
      const thirdUserId = new mongoose.Types.ObjectId();
      const thirdUserFileId = uuidv4();
      await createFile({
        user: thirdUserId,
        file_id: thirdUserFileId,
        filename: 'third-user-file.txt',
        filepath: '/uploads/third-user-file.txt',
        bytes: 300,
        type: 'text/plain',
      });

      const agent = await createAgent({
        id: uuidv4(),
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
        tool_resources: {
          file_search: {
            file_ids: [thirdUserFileId],
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

      const response = await request(app)
        .delete('/files')
        .send({
          agent_id: agent.id,
          files: [
            {
              file_id: thirdUserFileId,
              filepath: '/uploads/third-user-file.txt',
            },
          ],
        });

      expect(response.status).toBe(403);
      expect(response.body.message).toBe('You can only delete files you own');
      expect(response.body.unauthorizedFiles).toContain(thirdUserFileId);
      expect(processDeleteRequest).not.toHaveBeenCalled();
    });

    it('should prevent physically deleting non-owned files not attached to the specified agent', async () => {
      // Create another file not attached to the agent
      const unattachedFileId = uuidv4();
      await createFile({
        user: authorId,
        file_id: unattachedFileId,
        filename: 'unattached.txt',
        filepath: '/uploads/unattached.txt',
        bytes: 300,
        type: 'text/plain',
      });

      // Create an agent without the unattached file
      const agent = await createAgent({
        id: uuidv4(),
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
        tool_resources: {
          file_search: {
            file_ids: [fileId], // Only fileId, not unattachedFileId
          },
        },
      });

      // Grant EDIT permission to user on the agent
      const { grantPermission } = require('~/server/services/PermissionService');
      await grantPermission({
        principalType: PrincipalType.USER,
        principalId: otherUserId,
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
        accessRoleId: AccessRoleIds.AGENT_EDITOR,
        grantedBy: authorId,
      });

      const response = await request(app)
        .delete('/files')
        .send({
          agent_id: agent.id,
          files: [
            {
              file_id: unattachedFileId,
              filepath: '/uploads/unattached.txt',
            },
          ],
        });

      expect(response.status).toBe(403);
      expect(response.body.message).toBe('You can only delete files you own');
      expect(response.body.unauthorizedFiles).toContain(unattachedFileId);
      expect(processDeleteRequest).not.toHaveBeenCalled();
    });

    it('should handle mixed authorized and unauthorized files', async () => {
      // Create a file owned by the current user
      const userFileId = uuidv4();
      await createFile({
        user: otherUserId,
        file_id: userFileId,
        filename: 'user-file.txt',
        filepath: '/uploads/user-file.txt',
        bytes: 200,
        type: 'text/plain',
      });

      // Create an unauthorized file
      const unauthorizedFileId = uuidv4();
      await createFile({
        user: authorId,
        file_id: unauthorizedFileId,
        filename: 'unauthorized.txt',
        filepath: '/uploads/unauthorized.txt',
        bytes: 400,
        type: 'text/plain',
      });

      // Create an agent with only fileId attached
      const agent = await createAgent({
        id: uuidv4(),
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
        tool_resources: {
          file_search: {
            file_ids: [fileId],
          },
        },
      });

      // Grant EDIT permission to user on the agent
      const { grantPermission } = require('~/server/services/PermissionService');
      await grantPermission({
        principalType: PrincipalType.USER,
        principalId: otherUserId,
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
        accessRoleId: AccessRoleIds.AGENT_EDITOR,
        grantedBy: authorId,
      });

      const response = await request(app)
        .delete('/files')
        .send({
          agent_id: agent.id,
          files: [
            { file_id: userFileId, filepath: '/uploads/user-file.txt' },
            { file_id: fileId, filepath: '/uploads/test.txt' },
            { file_id: unauthorizedFileId, filepath: '/uploads/unauthorized.txt' },
          ],
        });

      expect(response.status).toBe(403);
      expect(response.body.message).toBe('You can only delete files you own');
      expect(response.body.unauthorizedFiles).toContain(unauthorizedFileId);
      expect(processDeleteRequest).not.toHaveBeenCalled();
    });

    it('should prevent unlinking attached files when user lacks EDIT permission on agent', async () => {
      // Create an agent with the file attached
      const agent = await createAgent({
        id: uuidv4(),
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
        tool_resources: {
          file_search: {
            file_ids: [fileId],
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

      const response = await request(app)
        .delete('/files')
        .send({
          agent_id: agent.id,
          tool_resource: 'file_search',
          files: [
            {
              file_id: fileId,
              filepath: '/uploads/test.txt',
            },
          ],
        });

      expect(response.status).toBe(403);
      expect(response.body.message).toBe('You can only delete files you have access to');
      expect(response.body.unauthorizedFiles).toContain(fileId);
      expect(processDeleteRequest).not.toHaveBeenCalled();
    });

    it('unlinks missing agent resource files without invoking storage deletion', async () => {
      const missingFileId = uuidv4();
      const agent = await createAgent({
        id: uuidv4(),
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: otherUserId,
        tool_resources: {
          file_search: {
            file_ids: [missingFileId],
          },
        },
      });

      const response = await request(app)
        .delete('/files')
        .send({
          agent_id: agent.id,
          tool_resource: 'file_search',
          files: [{ file_id: missingFileId, filepath: '/uploads/missing.txt' }],
        });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('File associations removed successfully from agent');
      expect(processDeleteRequest).not.toHaveBeenCalled();

      const updatedAgent = await Agent.findOne({ id: agent.id }).lean();
      expect(updatedAgent.tool_resources.file_search.file_ids).toEqual([]);
    });

    it('prevents unlinking missing agent resource files without agent edit access', async () => {
      const missingFileId = uuidv4();
      const agent = await createAgent({
        id: uuidv4(),
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
        tool_resources: {
          file_search: {
            file_ids: [missingFileId],
          },
        },
      });

      const response = await request(app)
        .delete('/files')
        .send({
          agent_id: agent.id,
          tool_resource: 'file_search',
          files: [{ file_id: missingFileId, filepath: '/uploads/missing.txt' }],
        });

      expect(response.status).toBe(403);
      expect(response.body.message).toBe('You can only delete files you have access to');
      expect(response.body.unauthorizedFiles).toContain(missingFileId);
      expect(processDeleteRequest).not.toHaveBeenCalled();

      const updatedAgent = await Agent.findOne({ id: agent.id }).lean();
      expect(updatedAgent.tool_resources.file_search.file_ids).toEqual([missingFileId]);
    });
  });

  /* Mirrors api/db/connect.js, which sets strictQuery for the running server. Under it
     Mongoose DROPS filter keys absent from the schema, so a lookup on a misspelled path
     degrades to findOne({}) — the first document in the collection, whoever owns it. */
  describe('DELETE /files - assistant tool resource unlinking', () => {
    let previousStrictQuery;

    beforeAll(() => {
      previousStrictQuery = mongoose.get('strictQuery');
      mongoose.set('strictQuery', true);
    });

    afterAll(async () => {
      mongoose.set('strictQuery', previousStrictQuery);
      await mongoose.connection.collection('assistants').deleteMany({});
    });

    beforeEach(async () => {
      await mongoose.connection.collection('assistants').deleteMany({});
    });

    it("does not unlink another user's assistant files when the requested assistant is missing", async () => {
      const strangerFileId = uuidv4();
      /* Written straight to the collection: `tool_resources` predates the current schema. */
      await mongoose.connection.collection('assistants').insertOne({
        user: new mongoose.Types.ObjectId(),
        assistant_id: 'asst_belonging_to_someone_else',
        tool_resources: { file_search: { file_ids: [strangerFileId] } },
      });

      const response = await request(app)
        .delete('/files')
        .send({
          assistant_id: 'asst_that_does_not_exist',
          tool_resource: 'file_search',
          files: [{ file_id: strangerFileId, filepath: '/uploads/stranger.txt' }],
        });

      expect(response.status).toBe(200);
      expect(processDeleteRequest).toHaveBeenCalledWith(expect.objectContaining({ files: [] }));
    });

    it('unlinks the requested assistant own files', async () => {
      const ownFileId = uuidv4();
      await mongoose.connection.collection('assistants').insertOne({
        user: new mongoose.Types.ObjectId(),
        assistant_id: 'asst_requested',
        tool_resources: { file_search: { file_ids: [ownFileId] } },
      });

      const response = await request(app)
        .delete('/files')
        .send({
          assistant_id: 'asst_requested',
          tool_resource: 'file_search',
          files: [{ file_id: ownFileId, filepath: '/uploads/own.txt' }],
        });

      expect(response.status).toBe(200);
      expect(processDeleteRequest).toHaveBeenCalledWith(
        expect.objectContaining({ files: [expect.objectContaining({ file_id: ownFileId })] }),
      );
    });

    it('answers instead of throwing when no assistants exist at all', async () => {
      const response = await request(app)
        .delete('/files')
        .send({
          assistant_id: 'asst_that_does_not_exist',
          tool_resource: 'file_search',
          files: [{ file_id: uuidv4(), filepath: '/uploads/ghost.txt' }],
        });

      expect(response.status).toBe(200);
      expect(processDeleteRequest).toHaveBeenCalledWith(expect.objectContaining({ files: [] }));
    });
  });

  describe('GET /files/download-url/:userId/:file_id', () => {
    it('returns a direct signed download URL when the strategy supports it', async () => {
      const userFileId = uuidv4();
      const getDownloadURL = jest.fn().mockResolvedValue('https://cdn.example.com/file.pdf?signed');
      getStrategyFunctions.mockReturnValue({ getDownloadURL });

      await createFile({
        user: otherUserId,
        file_id: userFileId,
        filename: 'file.pdf',
        filepath: 'uploads/user/file.pdf',
        storageKey: 'r/us-east-2/uploads/user/file.pdf',
        storageRegion: 'us-east-2',
        bytes: 200,
        type: 'application/pdf',
        source: FileSources.s3,
        text: 'private extracted text',
      });

      const response = await request(app).get(`/files/download-url/${otherUserId}/${userFileId}`);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        url: 'https://cdn.example.com/file.pdf?signed',
        filename: 'file.pdf',
        type: 'application/pdf',
      });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body.metadata).toMatchObject({
        file_id: userFileId,
        filename: 'file.pdf',
        filepath: 'uploads/user/file.pdf',
        storageKey: 'r/us-east-2/uploads/user/file.pdf',
        storageRegion: 'us-east-2',
        source: FileSources.s3,
      });
      expect(response.body.metadata).not.toHaveProperty('_id');
      expect(response.body.metadata).not.toHaveProperty('__v');
      expect(response.body.metadata).not.toHaveProperty('user');
      expect(response.body.metadata).not.toHaveProperty('tenantId');
      expect(response.body.metadata).not.toHaveProperty('text');
      expect(getDownloadURL).toHaveBeenCalledWith(
        expect.objectContaining({
          file: expect.objectContaining({ file_id: userFileId }),
          customFilename: 'file.pdf',
          contentType: 'application/pdf',
        }),
      );
    });

    it('returns 501 when the strategy does not support direct URLs', async () => {
      const userFileId = uuidv4();
      getStrategyFunctions.mockReturnValue({});

      await createFile({
        user: otherUserId,
        file_id: userFileId,
        filename: 'file.txt',
        filepath: 'uploads/user/file.txt',
        bytes: 200,
        type: 'text/plain',
        source: FileSources.local,
      });

      const response = await request(app).get(`/files/download-url/${otherUserId}/${userFileId}`);

      expect(response.status).toBe(501);
    });

    it('denies tenant-scoped files before issuing a signed URL', async () => {
      const userFileId = uuidv4();
      const getDownloadURL = jest.fn().mockResolvedValue('https://cdn.example.com/file.pdf?signed');
      getStrategyFunctions.mockReturnValue({ getDownloadURL });

      await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        createFile({
          user: otherUserId,
          file_id: userFileId,
          filename: 'file.pdf',
          filepath: 'uploads/user/file.pdf',
          bytes: 200,
          type: 'application/pdf',
          source: FileSources.s3,
          tenantId: 'tenant-a',
        }),
      );

      const response = await request(app).get(`/files/download-url/${otherUserId}/${userFileId}`);

      expect(response.status).toBe(403);
      expect(getDownloadURL).not.toHaveBeenCalled();
    });

    it('returns 500 when direct URL generation fails', async () => {
      const userFileId = uuidv4();
      const getDownloadURL = jest.fn().mockRejectedValue(new Error('signing failed'));
      getStrategyFunctions.mockReturnValue({ getDownloadURL });

      await createFile({
        user: otherUserId,
        file_id: userFileId,
        filename: 'file.pdf',
        filepath: 'uploads/user/file.pdf',
        storageKey: 'r/us-east-2/uploads/user/file.pdf',
        storageRegion: 'us-east-2',
        bytes: 200,
        type: 'application/pdf',
        source: FileSources.s3,
      });

      const response = await request(app).get(`/files/download-url/${otherUserId}/${userFileId}`);

      expect(response.status).toBe(500);
      expect(response.text).toBe('Error generating file download URL');
    });
  });

  describe('GET /files/download/:userId/:file_id', () => {
    it('streams proxied downloads by default when a direct URL is available', async () => {
      const userFileId = uuidv4();
      const getDownloadURL = jest.fn().mockResolvedValue('https://cdn.example.com/file.pdf?signed');
      const getDownloadStream = jest.fn().mockResolvedValue(Readable.from(['file content']));
      getStrategyFunctions.mockReturnValue({ getDownloadURL, getDownloadStream });

      await createFile({
        user: otherUserId,
        file_id: userFileId,
        filename: 'file.pdf',
        filepath: 'uploads/user/file.pdf',
        storageKey: 'r/us-east-2/uploads/user/file.pdf',
        storageRegion: 'us-east-2',
        bytes: 200,
        type: 'application/pdf',
        source: FileSources.cloudfront,
        text: 'private extracted text',
      });

      const response = await request(app).get(`/files/download/${otherUserId}/${userFileId}`);

      expect(response.status).toBe(200);
      expect(response.body.toString()).toBe('file content');
      expect(response.headers.location).toBeUndefined();
      const metadata = JSON.parse(decodeURIComponent(response.headers['x-file-metadata']));
      expect(metadata).toMatchObject({
        file_id: userFileId,
        filename: 'file.pdf',
        filepath: 'uploads/user/file.pdf',
        storageKey: 'r/us-east-2/uploads/user/file.pdf',
        storageRegion: 'us-east-2',
        source: FileSources.cloudfront,
      });
      expect(metadata).not.toHaveProperty('_id');
      expect(metadata).not.toHaveProperty('__v');
      expect(metadata).not.toHaveProperty('user');
      expect(metadata).not.toHaveProperty('tenantId');
      expect(metadata).not.toHaveProperty('text');
      expect(getDownloadURL).not.toHaveBeenCalled();
      expect(getDownloadStream).toHaveBeenCalledWith(
        expect.any(Object),
        'r/us-east-2/uploads/user/file.pdf',
      );
    });

    it('redirects to a direct signed download URL when explicitly requested', async () => {
      const userFileId = uuidv4();
      const getDownloadURL = jest.fn().mockResolvedValue('https://cdn.example.com/file.pdf?signed');
      const getDownloadStream = jest.fn();
      getStrategyFunctions.mockReturnValue({ getDownloadURL, getDownloadStream });

      await createFile({
        user: otherUserId,
        file_id: userFileId,
        filename: 'file.pdf',
        filepath: 'uploads/user/file.pdf',
        bytes: 200,
        type: 'application/pdf',
        source: FileSources.cloudfront,
      });

      const response = await request(app).get(
        `/files/download/${otherUserId}/${userFileId}?direct=true`,
      );

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe('https://cdn.example.com/file.pdf?signed');
      expect(response.headers['x-file-metadata']).toBeUndefined();
      expect(response.headers['cache-control']).toBe('no-store');
      expect(getDownloadStream).not.toHaveBeenCalled();
    });

    it('falls back to streaming when direct URL generation fails', async () => {
      const userFileId = uuidv4();
      const getDownloadURL = jest.fn().mockRejectedValue(new Error('missing signing keys'));
      const getDownloadStream = jest.fn().mockResolvedValue(Readable.from(['file content']));
      getStrategyFunctions.mockReturnValue({ getDownloadURL, getDownloadStream });

      await createFile({
        user: otherUserId,
        file_id: userFileId,
        filename: 'file.txt',
        filepath: 'uploads/user/file.txt',
        bytes: 200,
        type: 'text/plain',
        source: FileSources.s3,
      });

      const response = await request(app).get(
        `/files/download/${otherUserId}/${userFileId}?direct=true`,
      );

      expect(response.status).toBe(200);
      expect(response.body.toString()).toBe('file content');
      expect(response.headers.location).toBeUndefined();
      expect(response.headers['cache-control']).toBeUndefined();
      expect(getDownloadURL).toHaveBeenCalledWith(
        expect.objectContaining({
          file: expect.objectContaining({ file_id: userFileId }),
          customFilename: 'file.txt',
          contentType: 'text/plain',
        }),
      );
      expect(getDownloadStream).toHaveBeenCalledWith(expect.any(Object), 'uploads/user/file.txt');
    });

    it('returns 501 when direct URL generation fails and no stream fallback exists', async () => {
      const userFileId = uuidv4();
      const getDownloadURL = jest.fn().mockRejectedValue(new Error('missing signing keys'));
      getStrategyFunctions.mockReturnValue({ getDownloadURL });

      await createFile({
        user: otherUserId,
        file_id: userFileId,
        filename: 'file.txt',
        filepath: 'uploads/user/file.txt',
        bytes: 200,
        type: 'text/plain',
        source: FileSources.cloudfront,
      });

      const response = await request(app).get(
        `/files/download/${otherUserId}/${userFileId}?direct=true`,
      );

      expect(response.status).toBe(501);
      expect(response.text).toBe('Not Implemented');
      expect(response.headers.location).toBeUndefined();
      expect(getDownloadURL).toHaveBeenCalledWith(
        expect.objectContaining({
          file: expect.objectContaining({ file_id: userFileId }),
          customFilename: 'file.txt',
          contentType: 'text/plain',
        }),
      );
    });

    it('serves stored text for text-source files instead of streaming', async () => {
      const userFileId = uuidv4();
      const getDownloadStream = jest.fn();
      getStrategyFunctions.mockReturnValue({ getDownloadStream });

      await createFile({
        user: otherUserId,
        file_id: userFileId,
        filename: 'screenshot.png',
        filepath: FileSources.mistral_ocr,
        bytes: 70,
        type: 'text/plain',
        source: FileSources.text,
        text: 'Extracted OCR text',
      });

      const response = await request(app).get(`/files/download/${otherUserId}/${userFileId}`);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.headers['content-disposition']).toContain('screenshot.png.txt');
      expect(response.text).toBe('Extracted OCR text');
      const metadata = JSON.parse(decodeURIComponent(response.headers['x-file-metadata']));
      expect(metadata).toMatchObject({ file_id: userFileId, source: FileSources.text });
      expect(metadata).not.toHaveProperty('text');
      expect(getDownloadStream).not.toHaveBeenCalled();
    });

    it('does not append .txt when the text-source filename already ends in .txt', async () => {
      const userFileId = uuidv4();
      getStrategyFunctions.mockReturnValue({});

      await createFile({
        user: otherUserId,
        file_id: userFileId,
        filename: 'NOTES.TXT',
        filepath: FileSources.mistral_ocr,
        bytes: 20,
        type: 'text/plain',
        source: FileSources.text,
        text: 'plain text notes',
      });

      const response = await request(app).get(`/files/download/${otherUserId}/${userFileId}`);

      expect(response.status).toBe(200);
      expect(response.headers['content-disposition']).toContain('filename="NOTES.TXT"');
      expect(response.headers['content-disposition']).not.toContain('NOTES.TXT.txt');
      expect(response.text).toBe('plain text notes');
    });

    it('returns 404 for text-source files without stored text', async () => {
      const userFileId = uuidv4();
      const getDownloadStream = jest.fn();
      getStrategyFunctions.mockReturnValue({ getDownloadStream });

      await createFile({
        user: otherUserId,
        file_id: userFileId,
        filename: 'empty.png',
        filepath: FileSources.mistral_ocr,
        bytes: 0,
        type: 'text/plain',
        source: FileSources.text,
      });

      const response = await request(app).get(`/files/download/${otherUserId}/${userFileId}`);

      expect(response.status).toBe(404);
      expect(response.text).toBe('No file content found');
      expect(getDownloadStream).not.toHaveBeenCalled();
    });

    it('serves a valid empty stored-text result', async () => {
      const userFileId = uuidv4();
      const getDownloadStream = jest.fn();
      getStrategyFunctions.mockReturnValue({ getDownloadStream });

      await createFile({
        user: otherUserId,
        file_id: userFileId,
        filename: 'empty.txt',
        filepath: '/uploads/empty.txt',
        bytes: 0,
        type: 'text/plain',
        source: FileSources.text,
        text: '',
      });

      const response = await request(app).get(`/files/download/${otherUserId}/${userFileId}`);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.text).toBe('');
      expect(getDownloadStream).not.toHaveBeenCalled();
    });

    it('responds with 500 when the download stream errors before data is sent', async () => {
      const userFileId = uuidv4();
      const erroringStream = new Readable({
        read() {
          this.destroy(new Error('ENOENT: no such file or directory'));
        },
      });
      const getDownloadStream = jest.fn().mockResolvedValue(erroringStream);
      getStrategyFunctions.mockReturnValue({ getDownloadStream });

      await createFile({
        user: otherUserId,
        file_id: userFileId,
        filename: 'gone.bin',
        filepath: '/uploads/user/gone.bin',
        bytes: 5,
        type: 'application/octet-stream',
        source: FileSources.local,
      });

      const response = await request(app).get(`/files/download/${otherUserId}/${userFileId}`);

      expect(response.status).toBe(500);
      expect(response.text).toBe('Error downloading file');
    });

    it('aborts the response when the download stream errors mid-transfer', async () => {
      const userFileId = uuidv4();
      let pushed = false;
      const erroringStream = new Readable({
        read() {
          if (!pushed) {
            pushed = true;
            this.push('partial content');
            return;
          }
          this.destroy(new Error('read failed mid-stream'));
        },
      });
      const getDownloadStream = jest.fn().mockResolvedValue(erroringStream);
      getStrategyFunctions.mockReturnValue({ getDownloadStream });

      await createFile({
        user: otherUserId,
        file_id: userFileId,
        filename: 'truncated.bin',
        filepath: '/uploads/user/truncated.bin',
        bytes: 100,
        type: 'application/octet-stream',
        source: FileSources.local,
      });

      await expect(
        request(app).get(`/files/download/${otherUserId}/${userFileId}`),
      ).rejects.toThrow(/aborted|socket hang up|ECONNRESET/i);
    });
  });

  /**
   * The client mirrors the upload path's routing to decide what it may offer, and both
   * of these read the environment rather than the YAML, so the config endpoint is where
   * that knowledge crosses over.
   */
  describe('GET /files/config', () => {
    const originalRagUrl = process.env.RAG_API_URL;

    afterEach(() => {
      requestConfig = {};
      if (originalRagUrl === undefined) {
        delete process.env.RAG_API_URL;
      } else {
        process.env.RAG_API_URL = originalRagUrl;
      }
    });

    it('reports whether an OCR strategy and a RAG text service are configured', async () => {
      process.env.RAG_API_URL = 'http://rag-api.test';
      requestConfig = { ocr: { strategy: 'mistral_ocr' }, fileConfig: {} };

      const response = await request(app).get('/files/config');

      expect(response.status).toBe(200);
      expect(response.body.ocr.enabled).toBe(true);
      expect(response.body.text.enabled).toBe(true);
    });

    it('reports both as absent when neither is configured', async () => {
      delete process.env.RAG_API_URL;
      requestConfig = { fileConfig: {} };

      const response = await request(app).get('/files/config');

      expect(response.status).toBe(200);
      expect(response.body.ocr.enabled).toBe(false);
      expect(response.body.text.enabled).toBe(false);
    });

    it('keeps the configured text allowlist alongside the derived flag', async () => {
      process.env.RAG_API_URL = 'http://rag-api.test';
      requestConfig = { fileConfig: { text: { supportedMimeTypes: ['^text/plain$'] } } };

      const response = await request(app).get('/files/config');

      expect(response.body.text).toEqual({
        supportedMimeTypes: ['^text/plain$'],
        enabled: true,
      });
    });
  });

  describe('POST /files/usage', () => {
    const createQueuedFile = async (expiresAt) => {
      const ownFileId = uuidv4();
      await createFile({
        user: otherUserId,
        file_id: ownFileId,
        filename: 'queued.png',
        filepath: '/uploads/queued.png',
        bytes: 10,
        type: 'image/png',
      });
      await File.updateOne({ file_id: ownFileId }, { $set: { expiresAt } });
      return ownFileId;
    };

    it('extends the upload TTL of owned files without clearing it', async () => {
      const soon = new Date(Date.now() + 60 * 1000);
      const ownFileId = await createQueuedFile(soon);

      const response = await request(app)
        .post('/files/usage')
        .send({ file_ids: [ownFileId] });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ held: 1 });
      const held = await File.findOne({ file_id: ownFileId }).lean();
      /* The hold must remain a hold: still reapable, just later. */
      expect(held.expiresAt).toBeDefined();
      expect(held.expiresAt.getTime()).toBeGreaterThan(soon.getTime());
      /* The 24h baseline plus the default 24h approval window, so a queue
       * waiting on a paused run outlives that pause. Renewed from now, but
       * never past the ceiling measured from upload time. */
      const HOUR = 60 * 60 * 1000;
      expect(held.expiresAt.getTime()).toBeGreaterThan(Date.now() + 47 * HOUR);
      expect(held.expiresAt.getTime()).toBeLessThanOrEqual(
        held.createdAt.getTime() + 24 * HOUR + 8 * 24 * HOUR,
      );
      /* A queue touch is not a send, so it must not inflate usage. */
      expect(held.usage).toBe(0);
    });

    it('cannot be replayed to preserve a file indefinitely', async () => {
      const ownFileId = await createQueuedFile(new Date(Date.now() + 60 * 1000));

      const first = await request(app)
        .post('/files/usage')
        .send({ file_ids: [ownFileId] });
      expect(first.body).toEqual({ held: 1 });

      for (let i = 0; i < 5; i++) {
        const repeat = await request(app)
          .post('/files/usage')
          .send({ file_ids: [ownFileId] });
        expect(repeat.status).toBe(200);
      }

      /* Every renewal is clamped to the ceiling measured from upload time, so
       * replay converges there instead of advancing a window per call. */
      const HOUR = 60 * 60 * 1000;
      const held = await File.findOne({ file_id: ownFileId }).lean();
      expect(held.expiresAt).toBeDefined();
      expect(held.expiresAt.getTime()).toBeLessThanOrEqual(
        held.createdAt.getTime() + 24 * HOUR + 8 * 24 * HOUR,
      );
    });

    it('never re-adds a TTL to a file that was already sent', async () => {
      const sentFileId = uuidv4();
      await createFile({
        user: otherUserId,
        file_id: sentFileId,
        filename: 'sent.png',
        filepath: '/uploads/sent.png',
        bytes: 10,
        type: 'image/png',
      });
      await File.updateOne({ file_id: sentFileId }, { $unset: { expiresAt: '' } });

      const response = await request(app)
        .post('/files/usage')
        .send({ file_ids: [sentFileId] });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ held: 0 });
      const permanent = await File.findOne({ file_id: sentFileId }).lean();
      expect(permanent.expiresAt).toBeUndefined();
    });

    it('never shortens an existing hold', async () => {
      const farOut = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
      const ownFileId = await createQueuedFile(farOut);

      const response = await request(app)
        .post('/files/usage')
        .send({ file_ids: [ownFileId] });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ held: 0 });
      const untouched = await File.findOne({ file_id: ownFileId }).lean();
      expect(untouched.expiresAt.getTime()).toBe(farOut.getTime());
    });

    it("is owner-scoped: another user's file stays untouched (best-effort 200)", async () => {
      const soon = new Date(Date.now() + 60 * 1000);
      await File.updateOne({ file_id: fileId }, { $set: { expiresAt: soon } });

      const response = await request(app)
        .post('/files/usage')
        .send({ file_ids: [fileId] });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ held: 0 });
      const untouched = await File.findOne({ file_id: fileId }).lean();
      expect(untouched.usage).toBe(0);
      expect(untouched.expiresAt.getTime()).toBe(soon.getTime());
    });

    it('rejects a list over the cap', async () => {
      const file_ids = Array.from({ length: 11 }, () => uuidv4());
      const response = await request(app).post('/files/usage').send({ file_ids });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('TOO_MANY_FILES');
    });

    it('rejects invalid bodies', async () => {
      expect((await request(app).post('/files/usage').send({})).status).toBe(400);
      expect((await request(app).post('/files/usage').send({ file_ids: 'f1' })).status).toBe(400);
      expect(
        (
          await request(app)
            .post('/files/usage')
            .send({ file_ids: [1] })
        ).status,
      ).toBe(400);
    });

    it('rejects unauthenticated requests', async () => {
      const bareApp = express();
      bareApp.use(express.json());
      bareApp.use((req, res, next) => {
        req.app.locals = {};
        next();
      });
      bareApp.use('/files', router);

      const response = await request(bareApp)
        .post('/files/usage')
        .send({ file_ids: [fileId] });
      expect(response.status).toBe(401);
    });
  });

  describe('GET /files/code/download/:session_id/:fileId', () => {
    it('resolves a configured environment route for a persisted fallback', async () => {
      const environment = {
        id: 'managed-vm',
        name: 'Managed VM',
        type: 'managed',
        baseURL: 'https://managed-code.example.com/v1',
        workerId: 'personal-worker-1',
        default: true,
        owner: 'deployment',
      };
      requestConfig = {
        endpoints: {
          agents: {
            statefulCodeSessions: { environments: [environment] },
          },
        },
      };
      const executionRouteKey = createCodeExecutionRouteKey('stateful', environment);
      const getDownloadStream = jest.fn().mockResolvedValue({
        data: Readable.from(['configured output']),
      });
      getStrategyFunctions.mockReturnValue({ getDownloadStream });
      const sessionId = 's'.repeat(21);
      const codeFileId = 'f'.repeat(21);

      const response = await request(app).get(
        `/files/code/download/${sessionId}/${codeFileId}?execution_profile=stateful&execution_route_key=${encodeURIComponent(executionRouteKey)}`,
      );

      expect(response.status).toBe(200);
      expect(getDownloadStream).toHaveBeenCalledWith(
        `${sessionId}/${codeFileId}`,
        { kind: 'user', id: otherUserId.toString() },
        expect.any(Object),
        {
          baseUrl: environment.baseURL,
          executionProfile: 'stateful',
          bridgeWorkerId: 'personal-worker-1',
        },
      );
    });

    it('routes a persisted stateful fallback through the stateful Code API', async () => {
      const getDownloadStream = jest.fn().mockResolvedValue({
        headers: {
          'content-type': 'text/html',
          'set-cookie': 'internal-service-cookie=secret',
        },
        data: Readable.from(['stateful output']),
      });
      getStrategyFunctions.mockReturnValue({ getDownloadStream });
      process.env.LIBRECHAT_CODE_BASEURL_STATEFUL = 'https://code-stateful.example.com/v1';

      try {
        const sessionId = 's'.repeat(21);
        const codeFileId = 'f'.repeat(21);
        const response = await request(app).get(
          `/files/code/download/${sessionId}/${codeFileId}?execution_profile=stateful`,
        );

        expect(response.status).toBe(200);
        expect(response.body.toString()).toBe('stateful output');
        expect(response.headers['content-disposition']).toBe('attachment');
        expect(response.headers['content-type']).toBe('application/octet-stream');
        expect(response.headers['x-content-type-options']).toBe('nosniff');
        expect(response.headers['cache-control']).toBe('private, no-store');
        expect(response.headers['set-cookie']).toBeUndefined();
        expect(getDownloadStream).toHaveBeenCalledWith(
          `${sessionId}/${codeFileId}`,
          { kind: 'user', id: otherUserId.toString() },
          expect.any(Object),
          { baseUrl: 'https://code-stateful.example.com/v1', executionProfile: 'stateful' },
        );
      } finally {
        delete process.env.LIBRECHAT_CODE_BASEURL_STATEFUL;
      }
    });

    it('rejects an unmapped configured-environment route before contacting Code API', async () => {
      const response = await request(app).get(
        `/files/code/download/${'s'.repeat(21)}/${'f'.repeat(21)}?execution_profile=stateful&execution_route_key=stateful:${'a'.repeat(32)}`,
      );

      expect(response.status).toBe(404);
      expect(getStrategyFunctions).not.toHaveBeenCalled();
    });

    it('rejects an unknown execution profile', async () => {
      const response = await request(app).get(
        `/files/code/download/${'s'.repeat(21)}/${'f'.repeat(21)}?execution_profile=attacker`,
      );

      expect(response.status).toBe(400);
      expect(getStrategyFunctions).not.toHaveBeenCalled();
    });
  });
});

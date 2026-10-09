const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { FileSources, ContentTypes } = require('librechat-data-provider');

jest.mock('../connect', () => jest.fn().mockResolvedValue(true));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://bucket.s3.amazonaws.com/re-signed'),
}));

logger.silent = true;

const OWNER = '65cfb246f7ecadb8b1e8036b';
const KEY = `images/${OWNER}/file-1__photo.png`;
const CONTAINER_URL = 'https://account.blob.core.windows.net/files';
const BLOB_URL = `${CONTAINER_URL}/images/${OWNER}/report.png`;

const presigned = () =>
  `https://bucket.s3.amazonaws.com/${KEY}?X-Amz-Signature=abc&X-Amz-Date=20260101T000000Z&X-Amz-Expires=120`;

describe('Stored File Link Migration Script', () => {
  const originalEnv = { ...process.env };
  let mongoServer;
  let models;
  let api;
  let migrateStoredFileLinks;
  let relinkers;

  beforeAll(async () => {
    Object.assign(process.env, {
      AWS_REGION: 'eu-west-2',
      AWS_BUCKET_NAME: 'test-bucket',
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      DOMAIN_CLIENT: 'https://chat.example.com',
    });
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    models = require('~/db/models');
    api = require('@librechat/api');
    ({ migrateStoredFileLinks } = require('../migrate-stored-file-links'));
    relinkers = [api.s3Relinker, api.createAzureRelinker(CONTAINER_URL)];
  });

  afterAll(async () => {
    process.env = originalEnv;
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    process.env.STORAGE_PROXY_FILES = 'true';
    const _id = () => new mongoose.Types.ObjectId();
    await models.File.collection.insertMany([
      { _id: _id(), user: OWNER, file_id: 'f1', source: FileSources.s3, filepath: presigned() },
      {
        _id: _id(),
        user: OWNER,
        file_id: 'f2',
        source: FileSources.azure_blob,
        filepath: BLOB_URL,
      },
      { _id: _id(), user: OWNER, file_id: 'f3', source: FileSources.local, filepath: '/a.png' },
    ]);
    await models.Message.collection.insertOne({
      messageId: 'm1',
      files: [{ file_id: 'f1', source: FileSources.s3, filepath: presigned() }],
      content: [
        {
          type: ContentTypes.STEER,
          files: [{ file_id: 'f2', source: FileSources.azure_blob, filepath: BLOB_URL }],
        },
      ],
    });
    await models.ToolCall.collection.insertOne({
      toolId: 't1',
      attachments: [{ file_id: 'f1', source: FileSources.s3, filepath: presigned() }],
    });
    await models.Agent.collection.insertOne({
      id: 'agent_1',
      avatar: {
        source: FileSources.azure_blob,
        filepath: `${CONTAINER_URL}/images/${OWNER}/agent-agent_1-avatar-1.png`,
      },
    });
    await models.User.collection.insertOne({
      email: 'a@example.com',
      avatar: `${CONTAINER_URL}/images/${OWNER}/avatar-1.png?manual=true`,
    });
  });

  afterEach(async () => {
    await Promise.all(
      ['File', 'Message', 'ToolCall', 'Agent', 'User'].map((name) =>
        models[name].collection.deleteMany({}),
      ),
    );
  });

  const read = async () => ({
    files: await models.File.collection.find({}).sort({ file_id: 1 }).toArray(),
    message: await models.Message.collection.findOne({ messageId: 'm1' }),
    toolCall: await models.ToolCall.collection.findOne({ toolId: 't1' }),
    agent: await models.Agent.collection.findOne({ id: 'agent_1' }),
    user: await models.User.collection.findOne({ email: 'a@example.com' }),
  });

  it('reports what it would change without writing in a dry run', async () => {
    const result = await migrateStoredFileLinks({ dryRun: true, relinkers });

    expect(result).toEqual(
      expect.objectContaining({ files: 2, messages: 1, toolCalls: 1, agents: 1, users: 1 }),
    );
    const { files } = await read();
    expect(files[0].filepath).toBe(presigned());
  });

  it('replaces S3 and Azure links everywhere they are stored, and is idempotent', async () => {
    await migrateStoredFileLinks({ dryRun: false, relinkers });
    const { files, message, toolCall, agent, user } = await read();

    const s3Link = api.getStoredFileURL(FileSources.s3, KEY);
    const azureLink = (path) => api.getStoredFileURL(FileSources.azure_blob, path);
    expect(files[0].filepath).toBe(s3Link);
    expect(files[0].storageKey).toBe(KEY);
    expect(files[1].filepath).toBe(azureLink(`images/${OWNER}/report.png`));
    expect(files[2].filepath).toBe('/a.png');
    expect(message.files[0].filepath).toBe(s3Link);
    expect(message.content[0].files[0].filepath).toBe(azureLink(`images/${OWNER}/report.png`));
    expect(toolCall.attachments[0].filepath).toBe(s3Link);
    expect(agent.avatar.filepath).toBe(azureLink(`images/${OWNER}/agent-agent_1-avatar-1.png`));
    expect(user.avatar).toBe(`${azureLink(`images/${OWNER}/avatar-1.png`)}?manual=true`);

    await expect(migrateStoredFileLinks({ dryRun: false, relinkers })).resolves.toEqual(
      expect.objectContaining({ files: 0, messages: 0, toolCalls: 0, agents: 0, users: 0 }),
    );
  });

  it('writes storage links back with --revert once the proxy is off', async () => {
    await migrateStoredFileLinks({ dryRun: false, relinkers });
    process.env.STORAGE_PROXY_FILES = 'false';

    await migrateStoredFileLinks({ dryRun: false, revert: true, relinkers });
    const { files, message, user } = await read();

    expect(files[0].filepath).toBe('https://bucket.s3.amazonaws.com/re-signed');
    expect(files[1].filepath).toBe(BLOB_URL);
    expect(message.content[0].files[0].filepath).toBe(BLOB_URL);
    expect(user.avatar).toBe(`${CONTAINER_URL}/images/${OWNER}/avatar-1.png?manual=true`);
  });

  it('refuses to run in a direction the proxy setting does not serve', async () => {
    process.env.STORAGE_PROXY_FILES = 'false';
    await expect(migrateStoredFileLinks({ dryRun: true, relinkers })).rejects.toThrow(
      /STORAGE_PROXY_FILES on/,
    );
    process.env.STORAGE_PROXY_FILES = 'true';
    await expect(migrateStoredFileLinks({ dryRun: true, revert: true, relinkers })).rejects.toThrow(
      /STORAGE_PROXY_FILES off/,
    );
  });
});

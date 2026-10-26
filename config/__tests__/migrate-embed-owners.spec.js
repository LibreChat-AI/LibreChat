const axios = require('axios');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const { logger } = require('@librechat/data-schemas');
const { EToolResources } = require('librechat-data-provider');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('axios');
jest.mock('../connect', () => jest.fn().mockResolvedValue(true));
jest.mock('@librechat/api', () => ({
  generateShortLivedToken: jest.fn((userId) => `token-for-${userId}`),
}));

logger.silent = true;

const RAG_API_URL = 'http://rag.test';
const USER = new mongoose.Types.ObjectId();
const OTHER_USER = new mongoose.Types.ObjectId();

/**
 * rag_api resolves a request's scope as user ∪ entity, so `/ids` answers the
 * union. `owners` here is the store: file id → the single owner it was
 * embedded under, exactly as `delete_scoped` sees it.
 */
const serveIds = (owners) => {
  axios.get.mockImplementation(async (url, config) => {
    if (!url.endsWith('/ids')) {
      throw new Error(`unexpected request to ${url}`);
    }
    const caller = config.headers.Authorization.replace('Bearer token-for-', '');
    const scope = new Set([caller]);
    if (config.params?.entity_id) {
      scope.add(config.params.entity_id);
    }
    return {
      data: Object.entries(owners)
        .filter(([, owner]) => scope.has(owner))
        .map(([fileId]) => fileId),
    };
  });
};

describe('Embed Owner Migration Script', () => {
  let mongoServer;
  let File;
  let Agent;
  let migrateEmbedOwners;

  const createFile = (overrides = {}) =>
    File.create({
      user: USER,
      file_id: uuidv4(),
      filename: 'knowledge.txt',
      filepath: '/uploads/knowledge.txt',
      object: 'file',
      type: 'text/plain',
      bytes: 512,
      embedded: true,
      ...overrides,
    });

  const createAgent = (id, fileIds) =>
    Agent.create({
      id,
      name: id,
      author: USER,
      provider: 'openai',
      model: 'gpt-4o',
      tool_resources: { [EToolResources.file_search]: { file_ids: fileIds } },
    });

  const ownerOf = async (fileId) =>
    (await File.findOne({ file_id: fileId }).lean()).metadata?.embeddedEntities;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());

    const dbModels = require('~/db/models');
    File = dbModels.File;
    Agent = dbModels.Agent;

    ({ migrateEmbedOwners } = require('../migrate-embed-owners'));
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RAG_API_URL = RAG_API_URL;
  });

  afterEach(async () => {
    await File.deleteMany({});
    await Agent.deleteMany({});
    delete process.env.RAG_API_URL;
  });

  it('records the agent that owns a file, recovered from the scope difference', async () => {
    const file = await createFile();
    await createAgent('agent-abc', [file.file_id]);
    serveIds({ [file.file_id]: 'agent-abc' });

    const result = await migrateEmbedOwners({ dryRun: false });

    expect(await ownerOf(file.file_id)).toEqual(['agent-abc']);
    expect(result.filesUpdated).toBe(1);
  });

  it('writes nothing on a dry run, while reporting the same owners it would record', async () => {
    const file = await createFile();
    await createAgent('agent-abc', [file.file_id]);
    serveIds({ [file.file_id]: 'agent-abc' });

    const result = await migrateEmbedOwners({ dryRun: true });

    expect(await ownerOf(file.file_id)).toBeUndefined();
    expect(result.resolved).toBe(1);
    expect(result.filesUpdated).toBe(0);
    expect(result.details).toEqual([{ fileId: file.file_id, entityIds: ['agent-abc'] }]);
  });

  it('dry runs by default', async () => {
    const file = await createFile();
    await createAgent('agent-abc', [file.file_id]);
    serveIds({ [file.file_id]: 'agent-abc' });

    await migrateEmbedOwners();

    expect(await ownerOf(file.file_id)).toBeUndefined();
  });

  it('leaves a user-owned file untouched and does not report it as a problem', async () => {
    /* Invariant 11: no forced backfill onto files that have no owning entity. */
    const file = await createFile();
    await createAgent('agent-abc', [file.file_id]);
    serveIds({ [file.file_id]: USER.toString() });

    const result = await migrateEmbedOwners({ dryRun: false });

    expect(await ownerOf(file.file_id)).toBeUndefined();
    expect(result.userOwned).toBe(1);
    expect(result.unrecoverable).toEqual([]);
  });

  it('records every agent whose scope lists the file, since each holds its own copy', async () => {
    const file = await createFile();
    await createAgent('agent-one', [file.file_id]);
    await createAgent('agent-two', [file.file_id]);
    axios.get.mockImplementation(async (url, config) => ({
      data: config.params?.entity_id ? [file.file_id] : [],
    }));

    const result = await migrateEmbedOwners({ dryRun: false });

    expect((await ownerOf(file.file_id)).sort()).toEqual(['agent-one', 'agent-two']);
    expect(result.filesUpdated).toBe(1);
  });

  it('reports an entity-owned file no agent can account for, rather than leaving it silent', async () => {
    /* The uploading agent was deleted: rag_api still owns the chunks under an
     * entity, Mongo can no longer name it. Silence here is the original bug. */
    const file = await createFile();
    serveIds({ [file.file_id]: 'agent-long-gone' });

    const result = await migrateEmbedOwners({ dryRun: false });

    expect(await ownerOf(file.file_id)).toBeUndefined();
    expect(result.unrecoverable).toEqual([file.file_id]);
    /* A file no agent lists costs one scope read for its owner, and no
     * per-entity probe for an entity nobody named. */
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it('reports a row with no owner instead of failing the whole run', async () => {
    /* Written through the driver: the schema requires `user`, so only a legacy
     * or hand-edited document can look like this. */
    const fileId = uuidv4();
    await File.collection.insertOne({
      file_id: fileId,
      filename: 'legacy.txt',
      filepath: '/uploads/legacy.txt',
      object: 'file',
      type: 'text/plain',
      bytes: 128,
      embedded: true,
    });
    serveIds({});

    const result = await migrateEmbedOwners({ dryRun: false });

    expect(result.unrecoverable).toEqual([fileId]);
    expect(result.errors).toBe(0);
    /* No owner means no token to mint: the row is reported, not queried. */
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('never rescans a file that already records an owner', async () => {
    const file = await createFile({ metadata: { embeddedEntities: ['agent-abc'] } });
    await createAgent('agent-abc', [file.file_id]);
    serveIds({ [file.file_id]: 'agent-abc' });

    const result = await migrateEmbedOwners({ dryRun: false });

    expect(result.scannedFiles).toBe(0);
    expect(axios.get).not.toHaveBeenCalled();
    expect(await ownerOf(file.file_id)).toEqual(['agent-abc']);
  });

  it('skips a user whose scope could not be read, and counts it an error', async () => {
    const failing = await createFile();
    const healthy = await createFile({ user: OTHER_USER });
    await createAgent('agent-abc', [failing.file_id, healthy.file_id]);
    axios.get.mockImplementation(async (url, config) => {
      if (config.headers.Authorization.includes(USER.toString())) {
        throw new Error('connect ECONNREFUSED');
      }
      return { data: config.params?.entity_id ? [healthy.file_id] : [] };
    });

    const result = await migrateEmbedOwners({ dryRun: false });

    expect(await ownerOf(failing.file_id)).toBeUndefined();
    expect(result.errors).toBe(1);
    /* The reachable user is still repaired: one bad scope is not a reason to
     * abandon the rest. */
    expect(await ownerOf(healthy.file_id)).toEqual(['agent-abc']);
  });

  it('refuses to run without a vector service to ask', async () => {
    delete process.env.RAG_API_URL;

    await expect(migrateEmbedOwners({ dryRun: false })).rejects.toThrow(/RAG_API_URL/);
  });

  it('never scans a file that was never embedded', async () => {
    const file = await createFile({ embedded: false });
    await createAgent('agent-abc', [file.file_id]);
    serveIds({ [file.file_id]: 'agent-abc' });

    const result = await migrateEmbedOwners({ dryRun: false });

    expect(result.scannedFiles).toBe(0);
    expect(await ownerOf(file.file_id)).toBeUndefined();
  });

  it('asks rag_api twice per agent, not once per file', async () => {
    const files = await Promise.all([createFile(), createFile(), createFile()]);
    await createAgent(
      'agent-abc',
      files.map((file) => file.file_id),
    );
    serveIds(Object.fromEntries(files.map((file) => [file.file_id, 'agent-abc'])));

    const result = await migrateEmbedOwners({ dryRun: false });

    /* One unscoped call for the user, one widened call for the agent. */
    expect(axios.get).toHaveBeenCalledTimes(2);
    /* And every one of that user's files is repaired, not just the last. */
    expect(result.filesUpdated).toBe(3);
    for (const file of files) {
      expect(await ownerOf(file.file_id)).toEqual(['agent-abc']);
    }
  });

  it('counts the files it scanned, and tolerates an agent with no tool resources', async () => {
    const file = await createFile();
    await createAgent('agent-abc', [file.file_id]);
    await Agent.create({
      id: 'agent-bare',
      name: 'agent-bare',
      author: USER,
      provider: 'openai',
      model: 'gpt-4o',
    });
    serveIds({ [file.file_id]: 'agent-abc' });

    const result = await migrateEmbedOwners({ dryRun: false });

    expect(result.scannedFiles).toBe(1);
    expect(await ownerOf(file.file_id)).toEqual(['agent-abc']);
  });

  it('reports an owner it resolved but could not write, and does not count it recorded', async () => {
    /* A concurrent writer set an owner (or removed the row) between the scan
     * and the update, so the guarded write matches nothing. Reporting it as
     * recorded would leave the file's deletes unscoped and say otherwise. */
    const file = await createFile();
    await createAgent('agent-abc', [file.file_id]);
    serveIds({ [file.file_id]: 'agent-abc' });
    const updateOne = jest.spyOn(File, 'updateOne').mockResolvedValue({ modifiedCount: 0 });

    const result = await migrateEmbedOwners({ dryRun: false });

    expect(result.resolved).toBe(1);
    expect(result.filesUpdated).toBe(0);
    expect(result.notWritten).toEqual([file.file_id]);
    updateOne.mockRestore();
  });

  it('never overwrites an owner another writer recorded first', async () => {
    const file = await createFile();
    await createAgent('agent-abc', [file.file_id]);
    serveIds({ [file.file_id]: 'agent-abc' });
    /* The scan saw no owner; by write time the row has one. */
    const realUpdate = File.updateOne.bind(File);
    const updateOne = jest.spyOn(File, 'updateOne').mockImplementation(async (filter, update) => {
      await realUpdate(
        { _id: file._id },
        { $set: { 'metadata.embeddedEntities': ['agent-someone-else'] } },
      );
      return realUpdate(filter, update);
    });

    const result = await migrateEmbedOwners({ dryRun: false });

    expect(await ownerOf(file.file_id)).toEqual(['agent-someone-else']);
    expect(result.notWritten).toEqual([file.file_id]);
    updateOne.mockRestore();
  });

  it('keeps the accounting for every other file when one write fails', async () => {
    const [failing, healthy] = await Promise.all([createFile(), createFile()]);
    await createAgent('agent-abc', [failing.file_id, healthy.file_id]);
    serveIds({ [failing.file_id]: 'agent-abc', [healthy.file_id]: 'agent-abc' });
    const realUpdate = File.updateOne.bind(File);
    const updateOne = jest.spyOn(File, 'updateOne').mockImplementation(async (filter, update) => {
      if (String(filter._id) === String(failing._id)) {
        throw new Error('connection reset');
      }
      return realUpdate(filter, update);
    });

    const result = await migrateEmbedOwners({ dryRun: false });

    expect(result.notWritten).toEqual([failing.file_id]);
    expect(result.errors).toBe(1);
    expect(result.filesUpdated).toBe(1);
    expect(await ownerOf(healthy.file_id)).toEqual(['agent-abc']);
    updateOne.mockRestore();
  });

  it('caps the reported sample while still repairing every file', async () => {
    const files = await Promise.all(Array.from({ length: 55 }, () => createFile()));
    await createAgent(
      'agent-abc',
      files.map((file) => file.file_id),
    );
    serveIds(Object.fromEntries(files.map((file) => [file.file_id, 'agent-abc'])));

    const result = await migrateEmbedOwners({ dryRun: false });

    expect(result.filesUpdated).toBe(55);
    expect(result.details).toHaveLength(50);
  });

  it('reports ids and counts only, never a token', async () => {
    const file = await createFile();
    await createAgent('agent-abc', [file.file_id]);
    serveIds({ [file.file_id]: 'agent-abc' });

    const result = await migrateEmbedOwners({ dryRun: false });

    expect(JSON.stringify(result)).not.toMatch(/token-for-/);
  });
});

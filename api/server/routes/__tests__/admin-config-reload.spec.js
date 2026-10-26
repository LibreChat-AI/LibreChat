/**
 * Admin config writes through the real router, handlers, database methods, config service and
 * cache invalidation reload librechat.yaml, which is how a running server picks up an edit to a
 * base-only section such as `filters`. A request with nothing to write commits nothing and
 * reloads nothing; the e2e content-filter helpers rely on a write that always commits.
 * Only the caller's identity and capabilities and the structured-tool scan are stubbed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createModels } = require('@librechat/data-schemas');
const { Constants } = require('librechat-data-provider');

const mockAdmin = { id: new mongoose.Types.ObjectId().toString(), role: 'ADMIN' };

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = mockAdmin;
    next();
  },
}));

jest.mock('~/server/middleware/roles/capabilities', () => ({
  requireCapability: () => (_req, _res, next) => next(),
  hasCapability: async () => true,
  hasConfigCapability: async () => true,
  hasAnyConfigReadAccess: async () => true,
  getReadableConfigSections: async (_user, sections) => ({
    broad: true,
    sections: new Set(sections),
  }),
}));

jest.mock('~/server/services/start/tools', () => ({
  loadAndFormatTools: jest.fn(() => ({})),
}));

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'librechat-admin-config-reload-'));
const configPath = path.join(configDir, 'librechat.yaml');
const previousConfigPath = process.env.CONFIG_PATH;
process.env.CONFIG_PATH = configPath;

/** Each YAML edit marks the base it produces with its own `maxMatches`. */
function writeYaml(maxMatches) {
  const filters = { prompts: { pii: { action: 'block', fields: ['name'], maxMatches } } };
  fs.writeFileSync(configPath, yaml.dump({ version: Constants.CONFIG_VERSION, filters }));
}

/** A real user's profile route: a write that creates a profile needs its principal to exist. */
let principal;
let app;
let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  /** Building every model's indexes takes longer than the suite; only the config store's count. */
  mongoose.set('autoIndex', false);
  createModels(mongoose);
  await mongoose.models.Config.createIndexes();
  const user = await mongoose.models.User.create({
    email: 'reload-sentinel@example.com',
    provider: 'local',
  });
  principal = `/api/admin/config/user/${user._id}`;
  writeYaml(1);
  app = express();
  app.use(express.json());
  app.use('/api/admin/config', require('../admin/config'));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
  if (previousConfigPath === undefined) {
    delete process.env.CONFIG_PATH;
  } else {
    process.env.CONFIG_PATH = previousConfigPath;
  }
  fs.rmSync(configDir, { recursive: true, force: true });
});

/** The `maxMatches` GET /base serves, base-only and merged with the Base profile. */
async function served() {
  const responses = await Promise.all([
    request(app).get('/api/admin/config/base').query({ baseOnly: 'true' }),
    request(app).get('/api/admin/config/base'),
  ]);
  return responses.map(({ status, body }) =>
    status === 200 ? body.config.filters?.prompts?.pii?.maxMatches : status,
  );
}

describe('admin config writes and librechat.yaml', () => {
  const batch = { ops: [{ op: 'set', fieldPath: 'interface.customWelcome', value: 'batch' }] };

  /** Ordered: each write acts on the document the previous one left. */
  const writes = [
    ['PUT a document', 201, (agent) => agent.put(principal).send({ overrides: {}, priority: 10 })],
    [
      'PATCH a field',
      200,
      (agent) =>
        agent
          .patch(`${principal}/fields`)
          .send({ entries: [{ fieldPath: 'interface.customWelcome', value: 'hi' }] }),
    ],
    [
      'tombstone a field',
      200,
      (agent) => agent.post(`${principal}/fields/tombstone`).send({ fieldPath: 'webSearch' }),
    ],
    [
      'DELETE a field',
      200,
      (agent) =>
        agent.delete(`${principal}/fields`).query({ fieldPath: 'interface.customWelcome' }),
    ],
    ['POST a change batch', 200, (agent) => agent.post(`${principal}/changes`).send(batch)],
    [
      'deactivate the document',
      200,
      (agent) => agent.patch(`${principal}/active`).send({ isActive: false }),
    ],
    ['DELETE the document', 200, (agent) => agent.delete(principal)],
  ];

  it('serves the librechat.yaml that was on disk at startup', async () => {
    expect(await served()).toEqual([1, 1]);
  });

  it.each(writes.map((write, index) => [...write, index + 2]))(
    'reloads librechat.yaml after the write: %s',
    async (_label, status, send, maxMatches) => {
      writeYaml(maxMatches);
      expect(await served()).toEqual([maxMatches - 1, maxMatches - 1]);

      const response = await send(request(app));

      expect(response.status).toBe(status);
      expect(await served()).toEqual([maxMatches, maxMatches]);
    },
  );

  it('does not reload for a request with nothing to write', async () => {
    const committed = writes.length + 1;
    writeYaml(committed + 1);

    const noop = await request(app).put(principal).send({ overrides: {} });

    expect(noop.status).toBe(200);
    expect(noop.body.message).toBe('No actionable override sections provided');
    expect(await served()).toEqual([committed, committed]);

    const write = await request(app).put(principal).send({ overrides: {}, priority: 10 });

    expect(write.status).toBe(201);
    expect(await served()).toEqual([committed + 1, committed + 1]);
  });

  it('does not reload for a change batch that leaves the document as it is', async () => {
    const committed = writes.length + 2;
    const first = await request(app).post(`${principal}/changes`).send(batch);
    expect(first.body.written).toBe(true);
    expect(await served()).toEqual([committed, committed]);
    writeYaml(committed + 1);

    const repeat = await request(app).post(`${principal}/changes`).send(batch);

    expect(repeat.status).toBe(200);
    expect(repeat.body.written).toBe(false);
    expect(await served()).toEqual([committed, committed]);
  });
});

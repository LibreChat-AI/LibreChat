import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { channelConfigSchema } from 'librechat-data-provider';
import {
  createModels,
  createMethods,
  createChannelRunStorage,
  createChannelFeedbackStorage,
  tenantStorage,
  runAsSystem,
} from '@librechat/data-schemas';
import type { AppConfig } from '@librechat/data-schemas';
import type { ChannelFeedbackRuntimeDependencies } from './feedbackRuntime';
import { createChannelFeedbackRuntime } from './feedbackRuntime';
import { createChannelHandlers } from './service';

let mongo: MongoMemoryServer;
let deps: ChannelFeedbackRuntimeDependencies;
let runtime: ReturnType<typeof createChannelFeedbackRuntime>;
let app: express.Express;
let enabled: boolean;
const serviceToken = 'local-feedback-runtime-test-token-32-characters';
const tenantId = 'tenant-a';
const reaction = {
  eventId: 'Ev1',
  eventTimestampUs: 1000001,
  externalMessageKey: 'C1:1',
  externalUserId: 'U1',
  reaction: 'tada',
  action: 'added',
};
const post = () =>
  request(app)
    .post('/service/channel-a/reactions')
    .set('Authorization', `Bearer ${serviceToken}`)
    .set('x-tenant-id', tenantId)
    .send(reaction);

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await runAsSystem(async () => mongoose.models.AgentChannel.deleteMany({}));
  const db = createMethods(mongoose);
  await tenantStorage.run({ tenantId }, async () =>
    db.createAgentChannel({
      channelId: 'channel-a',
      agentId: 'agent-a',
      createdBy: 'user-a',
      type: 'slack',
      status: 'active',
      credentialMode: 'per_user',
      revision: 'rev-1',
      slack: { teamId: 'T1', appId: 'A1', botUserId: 'UBOT' },
    }),
  );
  enabled = true;
  const guarded = createChannelHandlers({
    db,
    serviceToken: () => serviceToken,
    config: async () => ({ enabled }),
    getAgent: async () => ({ id: 'agent-a' }),
    deleteApiKey: async () => false,
    verifySlackToken: async () => null,
    logError: () => {},
  });
  deps = {
    getConfig: async () => channelConfigSchema.parse({ enabled }),
    guard: guarded.service,
    runs: createChannelRunStorage(mongoose),
    hostDeps: {
      channels: db,
      storage: createChannelFeedbackStorage(mongoose),
      getAppConfig: async () =>
        ({
          interfaceConfig: { feedback: true },
          endpoints: { agents: { channels: { enabled } } },
        }) as AppConfig,
      getMessage: (filter) => db.getMessage(filter),
      currentTracePolicy: async () => null,
      sendScore: jest.fn().mockResolvedValue(undefined),
    },
    workerDeps: { listChannels: jest.fn(async () => ({ channels: [] })), onError: jest.fn() },
  };
  runtime = createChannelFeedbackRuntime(deps);
  app = express();
  app.use(express.json());
  app.post('/service/:channelId/reactions', runtime.handlers.reaction);
});
afterEach(async () => runtime.stop());

test('does not start work by construction, initializes once, and stops permanently', async () => {
  await post().expect(503);
  expect(deps.workerDeps.listChannels).not.toHaveBeenCalled();
  await Promise.all([runtime.initialize(), runtime.initialize()]);
  expect(deps.workerDeps.listChannels).toHaveBeenCalledTimes(1);
  const result = await post().expect(200);
  expect(result.body.ignored).toBe(true);
  await runtime.stop();
  await runtime.initialize();
  await post().expect(503);
  expect(deps.workerDeps.listChannels).toHaveBeenCalledTimes(1);
  expect(deps.hostDeps.sendScore).not.toHaveBeenCalled();
});

test('disabled startup and live disable both fail closed without exporting', async () => {
  enabled = false;
  await runtime.initialize();
  await post().expect(503);
  expect(deps.workerDeps.listChannels).not.toHaveBeenCalled();
  await runtime.stop();
  enabled = true;
  runtime = createChannelFeedbackRuntime(deps);
  app = express();
  app.use(express.json());
  app.post('/service/:channelId/reactions', runtime.handlers.reaction);
  await runtime.initialize();
  enabled = false;
  await post().expect(503);
  expect(deps.hostDeps.sendScore).not.toHaveBeenCalled();
});

test('stop racing configuration resolution prevents worker creation', async () => {
  let release!: (config: ReturnType<typeof channelConfigSchema.parse>) => void;
  deps.getConfig = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  runtime = createChannelFeedbackRuntime(deps);
  const initializing = runtime.initialize();
  const stopping = runtime.stop();
  release(channelConfigSchema.parse({ enabled: true }));
  await Promise.all([initializing, stopping]);
  expect(deps.workerDeps.listChannels).not.toHaveBeenCalled();
});

test('invalid timeout/lease relationship never starts a recovery worker', async () => {
  deps.getConfig = async () =>
    channelConfigSchema.parse({
      enabled: true,
      feedback: { exportTimeoutMs: 60000, exportLeaseMs: 60000 },
    });
  await expect(runtime.initialize()).rejects.toThrow('export lease longer than its timeout');
  await post().expect(503);
  expect(deps.workerDeps.listChannels).not.toHaveBeenCalled();
});

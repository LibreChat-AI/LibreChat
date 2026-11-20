import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { channelConfigSchema } from 'librechat-data-provider';
import {
  createModels,
  createMethods,
  createChannelFeedbackStorage,
  tenantStorage,
  runAsSystem,
} from '@librechat/data-schemas';
import type { AppConfig } from '@librechat/data-schemas';
import type { ChannelFeedbackRuntimeDependencies } from './feedbackRuntime';
import { createChannelFeedbackRuntime } from './feedbackRuntime';
import * as feedbackWorkers from './feedbackWorker';
import { createChannelHandlers } from './service';

let mongo: MongoMemoryReplSet;
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
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ args: ['--nounixsocket'] }],
  });
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await runAsSystem(() =>
    Promise.all(
      ['AgentChannel', 'ChannelScope', 'ResponseScope'].map((name) =>
        mongoose.models[name].deleteMany({}),
      ),
    ),
  );
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
    verifySlackToken: async () => null,
    logError: () => {},
  });
  deps = {
    getWorkerSettings: async () => channelConfigSchema.parse({ enabled }),
    guard: guarded.service,
    hostDeps: {
      channels: db,
      storage: createChannelFeedbackStorage(mongoose),
      getPolicy: async () =>
        enabled
          ? {
              appConfig: {
                interfaceConfig: { feedback: true },
                endpoints: { agents: {} },
              } as AppConfig,
              centralTraceExportEnabled: false,
            }
          : null,
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

test('scoped disable fails closed while global lifecycle remains initialized', async () => {
  enabled = false;
  await runtime.initialize();
  await post().expect(404);
  expect(deps.workerDeps.listChannels).toHaveBeenCalledTimes(1);
  await runtime.stop();
  enabled = true;
  runtime = createChannelFeedbackRuntime(deps);
  app = express();
  app.use(express.json());
  app.post('/service/:channelId/reactions', runtime.handlers.reaction);
  await runtime.initialize();
  enabled = false;
  await post().expect(404);
  expect(deps.hostDeps.sendScore).not.toHaveBeenCalled();
});

test('stop racing configuration resolution prevents worker creation', async () => {
  let release!: (config: ReturnType<typeof channelConfigSchema.parse>) => void;
  deps.getWorkerSettings = () =>
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
  deps.getWorkerSettings = async () =>
    channelConfigSchema.parse({
      enabled: true,
      feedback: { exportTimeoutMs: 60000, exportLeaseMs: 60000 },
    });
  await expect(runtime.initialize()).rejects.toThrow('export lease longer than its timeout');
  await post().expect(503);
  expect(deps.workerDeps.listChannels).not.toHaveBeenCalled();
});

test('normalizes default tenants only at the feedback worker application boundary', async () => {
  const contexts: Array<{ partition: string; tenantId?: string }> = [];
  const onError = jest.fn();
  const worker = feedbackWorkers.createChannelFeedbackWorker({
    listChannels: async () => ({ channels: [{}, { tenantId: 'named' }] }),
    feedback: {
      recover: async (partition) => {
        contexts.push({ partition, tenantId: tenantStorage.getStore()?.tenantId });
        return 0;
      },
      flush: async () => 0,
    },
    batchSize: 1,
    intervalMs: 60000,
    maxIdleIntervalMs: 60000,
    onError,
  });
  try {
    await worker.start();
  } finally {
    await worker.stop();
  }
  expect(contexts).toEqual([
    { partition: '_', tenantId: undefined },
    { partition: 'named', tenantId: 'named' },
  ]);
  expect(onError).not.toHaveBeenCalled();
});

test.each(['read', 'schema', 'settings'] as const)(
  'retries failed %s initialization while keeping ingress unavailable until ready',
  async (failure) => {
    const original = deps.getWorkerSettings;
    let fail = true;
    deps.getWorkerSettings = async () => {
      if (!fail) return original();
      if (failure === 'read') throw new Error('configuration unavailable');
      const config = channelConfigSchema.parse({ enabled: true });
      if (failure === 'schema') config.feedback.intervalMs = 0;
      else config.feedback.exportLeaseMs = config.feedback.exportTimeoutMs;
      return config;
    };
    const first = runtime.initialize();
    expect(runtime.initialize()).toBe(first);
    await expect(first).rejects.toThrow();
    await post().expect(503);
    fail = false;
    const retry = runtime.initialize();
    expect(runtime.initialize()).toBe(retry);
    await retry;
    await post().expect(200);
    await runtime.initialize();
    expect(deps.workerDeps.listChannels).toHaveBeenCalledTimes(1);
    expect(deps.hostDeps.sendScore).not.toHaveBeenCalled();
  },
);

test('disposes a partially started feedback worker before retrying and exposing handlers', async () => {
  const partial = feedbackWorkers.createChannelFeedbackWorker({
    ...deps.workerDeps,
    feedback: { recover: async () => 0, flush: async () => 0 },
    batchSize: 1,
    intervalMs: 60000,
    maxIdleIntervalMs: 60000,
  });
  const start = jest
    .spyOn(partial, 'start')
    .mockRejectedValueOnce(new Error('worker startup failed'));
  const stop = jest.spyOn(partial, 'stop');
  const factory = jest
    .spyOn(feedbackWorkers, 'createChannelFeedbackWorker')
    .mockReturnValueOnce(partial);
  try {
    await expect(runtime.initialize()).rejects.toThrow('worker startup failed');
    await post().expect(503);
    expect(stop).toHaveBeenCalledTimes(1);
    await runtime.initialize();
    await post().expect(200);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(deps.workerDeps.listChannels).toHaveBeenCalledTimes(1);
  } finally {
    factory.mockRestore();
    start.mockRestore();
    stop.mockRestore();
  }
});

test('keeps feedback stopped when pending initialization fails during shutdown', async () => {
  let reject!: (error: Error) => void;
  const gate = new Promise<Awaited<ReturnType<typeof deps.getWorkerSettings>>>((_resolve, fail) => {
    reject = fail;
  });
  const read = jest.fn(() => gate);
  deps.getWorkerSettings = read;
  const initializing = runtime.initialize();
  const stopping = runtime.stop();
  reject(new Error('configuration unavailable'));
  await expect(initializing).rejects.toThrow('configuration unavailable');
  await stopping;
  await runtime.initialize();
  await post().expect(503);
  expect(read).toHaveBeenCalledTimes(1);
  expect(deps.workerDeps.listChannels).not.toHaveBeenCalled();
});

test('initializes scoped ingress even when deployment worker defaults are disabled', async () => {
  deps.getWorkerSettings = async () => channelConfigSchema.parse({ enabled: false });
  await runtime.initialize();
  expect(deps.workerDeps.listChannels).toHaveBeenCalledTimes(1);
  await post().expect(200);
});

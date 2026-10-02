const mockTaskStore = {
  configureTaskControlTransport: jest.fn().mockResolvedValue(undefined),
  configureActivityStream: jest.fn(),
  prepareActivityForShutdown: jest.fn(),
  destroyTaskControlTransport: jest.fn().mockResolvedValue(undefined),
  destroyActivityStream: jest.fn(),
};
const mockCompletionWakeupHandler = jest.fn().mockResolvedValue(undefined);

jest.mock('@librechat/api', () => ({
  cacheConfig: { USE_REDIS: true, REDIS_KEY_PREFIX: 'test:' },
  ioredisClient: { duplicate: jest.fn() },
  registerShutdownTask: jest.fn(),
  duplicateIoRedisClient: jest.fn(),
  createIoRedisSubscriber: jest.fn(),
  createSubagentThreadTaskStore: jest.fn(() => mockTaskStore),
  createSubagentCompletionWakeupHandler: jest.fn(() => mockCompletionWakeupHandler),
  RedisSubagentTaskControlTransport: jest.fn(),
  RedisEventTransport: jest.fn(),
  SubagentActivityStream: jest.fn(),
}));

jest.mock('~/models', () => ({
  acquireSubagentThreadLease: jest.fn(),
  claimSubagentTaskResult: jest.fn(),
  releaseSubagentTaskResultClaim: jest.fn(),
  countActiveSubagentThreadLeases: jest.fn(),
  deleteConvos: jest.fn(),
  deleteMessages: jest.fn(),
  getConvo: jest.fn(),
  getSubagentTaskControlReplay: jest.fn(),
  getMessages: jest.fn(),
  listActiveSubagentThreadLeases: jest.fn(),
  recordSubagentTaskControlReceipt: jest.fn(),
  releaseSubagentThreadLease: jest.fn(),
  reserveSubagentThread: jest.fn(),
  renewSubagentThreadLease: jest.fn(),
  saveConvo: jest.fn(),
  saveMessage: jest.fn(),
  isSubagentOwnerAdmissible: jest.fn(),
  fenceSubagentAdmission: jest.fn(),
  renewSubagentAdmission: jest.fn(),
  releaseSubagentAdmission: jest.fn(),
}));

jest.mock('../../Agents/triggers', () => ({
  enqueueAgentTrigger: jest.fn(),
  expediteCompletionWakeups: jest.fn(),
}));

const {
  ioredisClient,
  registerShutdownTask,
  duplicateIoRedisClient,
  createIoRedisSubscriber,
  createSubagentThreadTaskStore,
} = require('@librechat/api');
const subagentThreadTaskStore = require('./subagentThreadStore');
const { configureSubagentTaskRouting } = subagentThreadTaskStore;
const taskStoreOptions = createSubagentThreadTaskStore.mock.calls[0][1];
const taskStoreMethods = createSubagentThreadTaskStore.mock.calls[0][0];
const db = require('~/models');
const activityPrepareRegistration = registerShutdownTask.mock.calls.find(
  ([name]) => name === 'subagent activity streams prepare',
);
const taskStoreShutdownRegistration = registerShutdownTask.mock.calls.find(
  ([name]) => name === 'subagent task store',
);

describe('subagent thread Redis lifecycle', () => {
  it('wires durable control receipt persistence into the host store', () => {
    expect(taskStoreMethods.recordSubagentTaskControlReceipt).toBe(
      db.recordSubagentTaskControlReceipt,
    );
    expect(taskStoreMethods.getSubagentTaskControlReplay).toBe(db.getSubagentTaskControlReplay);
  });

  it('pre-registers completion wakeups for every prepared task', async () => {
    await taskStoreOptions.onTaskPrepared({ taskId: 'task-1' });

    expect(mockCompletionWakeupHandler).toHaveBeenCalledWith({ taskId: 'task-1' });
  });

  it('expedites only the settled task identities in their parent conversation', () => {
    const { expediteCompletionWakeups } = require('../../Agents/triggers');
    taskStoreOptions.onTaskSettled('user-1', 'parent-1', ['task-1', 'recovered-task']);
    expect(expediteCompletionWakeups).toHaveBeenCalledWith({
      user: 'user-1',
      conversationId: 'parent-1',
      taskIds: ['task-1', 'recovered-task'],
    });
  });

  it('registers local task-store quiescence independently of optional Redis setup', () => {
    expect(taskStoreShutdownRegistration).toEqual([
      'subagent task store',
      expect.any(Function),
      { priority: 90 },
    ]);
  });

  it('closes activity SSE before drain and disconnects its subscriber after drain', async () => {
    const taskSubscriber = { disconnect: jest.fn() };
    const activitySubscriber = { disconnect: jest.fn() };
    const taskPublisher = { disconnect: jest.fn() };
    const activityPublisher = { disconnect: jest.fn() };
    createIoRedisSubscriber
      .mockReturnValueOnce(taskSubscriber)
      .mockReturnValueOnce(activitySubscriber);
    duplicateIoRedisClient
      .mockReturnValueOnce(taskPublisher)
      .mockReturnValueOnce(activityPublisher);

    await configureSubagentTaskRouting();

    expect(createIoRedisSubscriber.mock.calls).toEqual([
      [ioredisClient, '[SubagentTaskRouting] task subscriber'],
      [ioredisClient, '[SubagentTaskRouting] activity subscriber'],
    ]);
    expect(activityPrepareRegistration).toEqual([
      'subagent activity streams prepare',
      expect.any(Function),
      { phase: 'pre-drain', priority: 100 },
    ]);
    expect(taskStoreShutdownRegistration).toEqual([
      'subagent task store',
      expect.any(Function),
      { priority: 90 },
    ]);
    const prepare = activityPrepareRegistration[1];
    prepare();
    expect(mockTaskStore.prepareActivityForShutdown).toHaveBeenCalledTimes(1);

    const shutdown = taskStoreShutdownRegistration[1];
    await shutdown();

    expect(mockTaskStore.destroyTaskControlTransport).toHaveBeenCalledTimes(1);
    expect(mockTaskStore.destroyActivityStream).toHaveBeenCalledTimes(1);
    expect(taskPublisher.disconnect).toHaveBeenCalledTimes(1);
    expect(activitySubscriber.disconnect).toHaveBeenCalledTimes(1);
    expect(activityPublisher.disconnect).toHaveBeenCalledTimes(1);
  });
});

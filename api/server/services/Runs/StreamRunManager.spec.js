const mockRetrieveAndProcessFile = jest.fn();

jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  sleep: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('~/server/services/Files/process', () => ({
  retrieveAndProcessFile: (...args) => mockRetrieveAndProcessFile(...args),
}));
jest.mock('~/server/services/ToolService', () => ({ processRequiredActions: jest.fn() }));
jest.mock('~/server/services/Threads', () => ({ processMessages: jest.fn() }));
jest.mock('~/server/utils', () => ({
  createOnProgress: jest.fn(() => ({ onProgress: jest.fn(() => jest.fn()) })),
}));

const { EventEmitter } = require('events');
const {
  enrollAssistantRun,
  InMemoryJobStore,
  InMemoryEventTransport,
  GenerationJobManagerClass,
} = require('@librechat/api');
const StreamRunManager = require('./StreamRunManager');

const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createRes() {
  const res = new EventEmitter();
  res.write = jest.fn();
  res.writableEnded = false;
  res.closed = true;
  return res;
}

const toolCallEvent = (toolCall) => ({
  data: {
    id: 'step-1',
    delta: { step_details: { type: 'tool_calls', tool_calls: [toolCall] } },
  },
});

function createStreamRunManager(req) {
  return new StreamRunManager({
    req,
    res: createRes(),
    openai: { apiKey: 'key' },
    thread_id: 'thread-1',
    parentMessageId: 'user-msg',
    attachedFileIds: new Set(),
    responseMessage: { messageId: 'assistant-msg', conversationId: 'convo-1', content: [] },
  });
}

describe('StreamRunManager detached code interpreter files', () => {
  let manager;

  beforeEach(() => {
    mockRetrieveAndProcessFile.mockReset();
    manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();
  });

  afterEach(async () => {
    await manager.destroy();
  });

  it('keeps an image output that is still being stored inside the run drain', async () => {
    const fileWrite = deferred();
    mockRetrieveAndProcessFile.mockReturnValue(fileWrite.promise);
    const run = await enrollAssistantRun(
      { userId: 'user-1' },
      { manager, isPrincipalActive: async () => true, responseCloseGraceMs: 10 },
    );
    const streamRunManager = createStreamRunManager({
      assistantRun: run,
      user: { id: 'user-1' },
      body: { assistant_id: 'asst-1', endpoint: 'assistants' },
    });

    await streamRunManager.handleRunStepDeltaEvent(
      toolCallEvent({
        index: 0,
        id: 'call-1',
        type: 'code_interpreter',
        code_interpreter: { input: '', outputs: [] },
      }),
    );
    /** The stream loop gets control back while the image is still being downloaded and stored. */
    await streamRunManager.handleRunStepDeltaEvent(
      toolCallEvent({
        index: 0,
        id: 'call-1',
        type: 'code_interpreter',
        code_interpreter: { outputs: [{ index: 0, type: 'image', image: { file_id: 'file-1' } }] },
      }),
    );
    expect(mockRetrieveAndProcessFile).toHaveBeenCalledTimes(1);

    let settled = false;
    const settling = run.settle(createRes()).then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    await expect(manager.getCleanupBlockingJobIdsForUser('user-1')).resolves.toHaveLength(1);

    fileWrite.resolve({ file_id: 'file-1', filepath: '/images/file-1.png', type: 'image/png' });
    await settling;
    expect(settled).toBe(true);
    await expect(manager.getCleanupBlockingJobIdsForUser('user-1')).resolves.toEqual([]);
  });

  it('runs without a managed run', async () => {
    mockRetrieveAndProcessFile.mockResolvedValue({
      file_id: 'file-1',
      filepath: '/images/file-1.png',
      type: 'image/png',
    });
    const streamRunManager = createStreamRunManager({
      user: { id: 'user-1' },
      body: { assistant_id: 'asst-1', endpoint: 'assistants' },
    });

    await streamRunManager.handleRunStepDeltaEvent(
      toolCallEvent({
        index: 0,
        id: 'call-1',
        type: 'code_interpreter',
        code_interpreter: { input: '', outputs: [] },
      }),
    );
    await expect(
      streamRunManager.handleRunStepDeltaEvent(
        toolCallEvent({
          index: 0,
          id: 'call-1',
          type: 'code_interpreter',
          code_interpreter: {
            outputs: [{ index: 0, type: 'image', image: { file_id: 'file-1' } }],
          },
        }),
      ),
    ).resolves.toBeUndefined();
  });
});

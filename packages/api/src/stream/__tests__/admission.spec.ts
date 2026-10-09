import { logger } from '@librechat/data-schemas';
import { InMemoryJobStore } from '../implementations/InMemoryJobStore';
import { logGenerationStartFailure } from '../admission';

const STARTED = { generationProtocolVersion: 2 as const };

function createContinuationJob(store: InMemoryJobStore, streamId: string) {
  return store.createJob(
    streamId,
    'owner-1',
    streamId,
    undefined,
    STARTED,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    'continuation-create-attempt',
    undefined,
    true,
  );
}

function createConditionalJob(
  store: InMemoryJobStore,
  streamId: string,
  expectedPredecessorCreatedAt: number,
) {
  return store.createJob(
    streamId,
    'owner-1',
    streamId,
    undefined,
    STARTED,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    'conditional-create-attempt',
    expectedPredecessorCreatedAt,
  );
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the create to be rejected');
}

describe('logGenerationStartFailure', () => {
  let store: InMemoryJobStore;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    store = new InMemoryJobStore();
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    error = jest.spyOn(logger, 'error').mockImplementation(() => logger);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await store.destroy();
  });

  it('warns when a sibling continuation already won the conversation', async () => {
    const streamId = 'sibling-wakeup-race';
    const winner = await createContinuationJob(store, streamId);
    const mismatch = await rejectionOf(createContinuationJob(store, streamId));

    logGenerationStartFailure(mismatch, {
      streamId,
      conversationId: streamId,
      continuation: true,
    });

    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[ResumableAgentController] Generation predecessor changed before creation',
      {
        streamId,
        conversationId: streamId,
        continuation: true,
        active: true,
        currentCreatedAt: winner.createdAt,
        currentStatus: 'running',
      },
    );
  });

  it('warns with the stale epoch when a queued send lost its fence to a settled turn', async () => {
    const streamId = 'stale-queued-send';
    const settled = await store.createJob(streamId, 'owner-1', streamId, undefined, STARTED);
    await store.transitionStatus(streamId, {
      from: 'running',
      to: 'complete',
      expectCreatedAt: settled.createdAt,
    });
    const expectedPredecessorCreatedAt = settled.createdAt - 1;
    const mismatch = await rejectionOf(
      createConditionalJob(store, streamId, expectedPredecessorCreatedAt),
    );

    logGenerationStartFailure(mismatch, {
      streamId,
      conversationId: streamId,
      continuation: false,
      expectedPredecessorCreatedAt,
    });

    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[ResumableAgentController] Generation predecessor changed before creation',
      {
        streamId,
        conversationId: streamId,
        continuation: false,
        active: false,
        expectedPredecessorCreatedAt,
        currentCreatedAt: settled.createdAt,
        currentStatus: 'complete',
      },
    );
  });

  it('treats a code-only mismatch the same way the 409 response does', () => {
    const mismatch = Object.assign(new Error('predecessor changed'), {
      code: 'GENERATION_PREDECESSOR_MISMATCH',
      currentJob: { createdAt: 2000, status: 'requires_action', verified: false },
    });

    logGenerationStartFailure(mismatch, {
      streamId: 'code-only',
      conversationId: 'code-only',
      continuation: false,
    });

    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[ResumableAgentController] Generation predecessor changed before creation',
      {
        streamId: 'code-only',
        conversationId: 'code-only',
        continuation: false,
        active: true,
        currentCreatedAt: 2000,
        currentStatus: 'requires_action',
        verified: false,
      },
    );
  });

  it('keeps genuine initialization failures at error level as redacted text', () => {
    const failure = Object.assign(new Error('Agent not found'), { code: 'AGENT_NOT_FOUND' });

    logGenerationStartFailure(failure, {
      streamId: 'genuine-failure',
      conversationId: 'genuine-failure',
      continuation: true,
    });

    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    const [message, ...metadata] = error.mock.calls[0];
    expect(metadata).toEqual([]);
    expect(message).toMatch(
      /^\[ResumableAgentController\] Initialization error: Error: Agent not found/,
    );
  });

  it('logs a non-error rejection at error level', () => {
    logGenerationStartFailure(undefined, {
      streamId: 'unknown-failure',
      conversationId: 'unknown-failure',
      continuation: false,
    });

    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      '[ResumableAgentController] Initialization error: UnknownError',
    );
  });
});

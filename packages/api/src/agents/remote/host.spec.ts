import type { ChatCompletionRunEnvelope } from '../envelope';
import type { AgentExecutionConnection } from './host';
import { GenerationJobManager } from '~/stream';
import { executeAgentRun } from './host';

jest.mock('~/stream', () => ({
  GenerationJobManager: {
    createJob: jest.fn(),
    getJobStore: jest.fn(() => ({})),
    beginProviderExecution: jest.fn(),
    completeJob: jest.fn(),
    markProviderExecutionDrained: jest.fn(),
  },
}));

const manager = GenerationJobManager as jest.Mocked<typeof GenerationJobManager>;

function createEnvelope(): ChatCompletionRunEnvelope {
  return {
    version: 1,
    protocol: 'chat.completions',
    requestId: 'request-1',
    receivedAt: 1,
    principal: { userId: 'user-1' },
    payload: {
      model: 'agent-1',
      messages: [{ role: 'user', content: 'hello' }],
    },
  };
}

describe('executeAgentRun', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    manager.createJob.mockResolvedValue({
      streamId: 'run-1',
      createdAt: 10,
      status: 'running',
      abortController: new AbortController(),
      metadata: { providerExecutionId: 'provider-1' },
    } as never);
    manager.beginProviderExecution.mockResolvedValue(true);
    manager.completeJob.mockResolvedValue(true);
    manager.markProviderExecutionDrained.mockResolvedValue(true);
  });

  it('executes and settles from an envelope without HTTP request or response objects', async () => {
    const execute = jest.fn(async () => 'done');

    await expect(
      executeAgentRun({
        envelope: createEnvelope(),
        runId: 'run-1',
        conversationId: 'conversation-1',
        isPrincipalActive: async () => true,
        execute,
      }),
    ).resolves.toBe('done');

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-1' }));
    expect(manager.completeJob).toHaveBeenCalledWith('run-1', undefined, 10);
    expect(manager.markProviderExecutionDrained).toHaveBeenCalledWith('run-1', 10, 'provider-1');
  });

  it('aborts the enrolled run when the transport closes', async () => {
    let closeListener: (() => void) | undefined;
    const connection: AgentExecutionConnection = {
      isClosed: () => false,
      onClose: (listener) => {
        closeListener = listener;
        return () => {
          closeListener = undefined;
        };
      },
    };

    await executeAgentRun({
      envelope: createEnvelope(),
      runId: 'run-1',
      conversationId: 'conversation-1',
      connection,
      isPrincipalActive: async () => true,
      execute: async (execution) => {
        closeListener?.();
        expect(execution.signal.aborted).toBe(true);
      },
    });
  });

  it('settles failed execution with terminal error evidence', async () => {
    const failure = new Error('provider failed');

    await expect(
      executeAgentRun({
        envelope: createEnvelope(),
        runId: 'run-1',
        conversationId: 'conversation-1',
        isPrincipalActive: async () => true,
        execute: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    expect(manager.completeJob).toHaveBeenCalledWith('run-1', 'Remote agent execution failed', 10);
  });

  it('renders an execution error before terminal settlement', async () => {
    const events: string[] = [];
    manager.completeJob.mockImplementation(async () => {
      events.push('settled');
      return true;
    });

    await expect(
      executeAgentRun({
        envelope: createEnvelope(),
        runId: 'run-1',
        conversationId: 'conversation-1',
        isPrincipalActive: async () => true,
        execute: async () => {
          throw new Error('provider failed');
        },
        handleExecutionError: () => {
          events.push('rendered');
          return 'handled';
        },
      }),
    ).resolves.toBe('handled');

    expect(events).toEqual(['rendered', 'settled']);
  });

  it('passes the canonical aborted signal to execution error handling', async () => {
    let closeListener: (() => void) | undefined;
    const handleExecutionError = jest.fn<string, [unknown, AbortSignal?]>(() => 'handled');
    const abortError = Object.assign(new Error('request aborted'), { name: 'AbortError' });

    await expect(
      executeAgentRun({
        envelope: createEnvelope(),
        runId: 'run-1',
        conversationId: 'conversation-1',
        connection: {
          isClosed: () => false,
          onClose: (listener) => {
            closeListener = listener;
            return () => undefined;
          },
        },
        isPrincipalActive: async () => true,
        execute: async () => {
          closeListener?.();
          throw abortError;
        },
        handleExecutionError,
      }),
    ).resolves.toBe('handled');

    expect(handleExecutionError).toHaveBeenCalledWith(abortError, expect.any(AbortSignal));
    const executionSignal = handleExecutionError.mock.calls[0]?.[1];
    expect(executionSignal).toBeDefined();
    expect(executionSignal?.aborted).toBe(true);
  });

  it('settles even when trailing-write registration fails', async () => {
    const failure = new Error('trailing write registration failed');

    await expect(
      executeAgentRun({
        envelope: createEnvelope(),
        runId: 'run-1',
        conversationId: 'conversation-1',
        isPrincipalActive: async () => true,
        execute: async () => 'done',
        beforeSettle: async () => {
          throw failure;
        },
      }),
    ).resolves.toBe('done');

    expect(manager.completeJob).toHaveBeenCalledWith('run-1', 'Remote agent execution failed', 10);
  });

  it('journals enrollment before provider work and publishes only after drain', async () => {
    const order: string[] = [];
    manager.beginProviderExecution.mockImplementation(async () => {
      order.push('provider');
      return true;
    });
    manager.markProviderExecutionDrained.mockImplementation(async () => {
      order.push('drain');
      return true;
    });
    await executeAgentRun({
      envelope: createEnvelope(),
      runId: 'run-1',
      conversationId: 'conversation-1',
      isPrincipalActive: async () => true,
      onEnrolled: async (execution) => {
        expect(execution.createdAt).toBe(10);
        order.push('journal');
      },
      execute: async () => {
        order.push('execute');
      },
      afterSettle: async () => {
        order.push('publish');
      },
    });
    expect(order).toEqual(['journal', 'provider', 'execute', 'drain', 'publish']);
  });

  it('does not start provider work if durable enrollment publication fails', async () => {
    const failure = new Error('enrollment journal unavailable');
    const execute = jest.fn();
    await expect(
      executeAgentRun({
        envelope: createEnvelope(),
        runId: 'run-1',
        conversationId: 'conversation-1',
        isPrincipalActive: async () => true,
        onEnrolled: async () => {
          throw failure;
        },
        execute,
      }),
    ).rejects.toBe(failure);
    expect(manager.beginProviderExecution).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not publish terminal success when provider drain fails', async () => {
    manager.markProviderExecutionDrained.mockResolvedValue(false);
    const publish = jest.fn();
    const onError = jest.fn();
    await executeAgentRun({
      envelope: createEnvelope(),
      runId: 'run-1',
      conversationId: 'conversation-1',
      isPrincipalActive: async () => true,
      execute: async () => 'output',
      afterSettle: publish,
      onSettlementError: onError,
    });
    expect(publish).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });

  it('does not run terminal hooks for a provider-start CAS loser', async () => {
    manager.beginProviderExecution.mockResolvedValue(false);
    const execute = jest.fn();
    const beforeSettle = jest.fn();
    const afterSettle = jest.fn();
    await expect(
      executeAgentRun({
        envelope: createEnvelope(),
        runId: 'run-1',
        conversationId: 'conversation-1',
        isPrincipalActive: async () => true,
        execute,
        beforeSettle,
        afterSettle,
      }),
    ).rejects.toMatchObject({ code: 'RUN_REPLACED' });
    expect(execute).not.toHaveBeenCalled();
    expect(beforeSettle).not.toHaveBeenCalled();
    expect(afterSettle).not.toHaveBeenCalled();
    expect(manager.completeJob).not.toHaveBeenCalled();
    expect(manager.markProviderExecutionDrained).not.toHaveBeenCalled();
  });
});

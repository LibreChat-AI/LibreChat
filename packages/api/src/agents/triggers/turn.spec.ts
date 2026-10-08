const mockExecuteAgentEventActor = jest.fn();
const mockResumeAgentEventActor = jest.fn();

jest.mock('./actor', () => ({
  executeAgentEventActor: (...args: Parameters<typeof mockExecuteAgentEventActor>) =>
    mockExecuteAgentEventActor(...args),
  resumeAgentEventActor: (...args: Parameters<typeof mockResumeAgentEventActor>) =>
    mockResumeAgentEventActor(...args),
}));

import type {
  AgentEventActorDependencies,
  ExecuteAgentEventActorInput,
  ResumeAgentEventActorInput,
} from './actor';
import { createAgentEventActorTurn, settleAgentEventActorHistoryTurn } from './turn';

const owner = {
  user: 'user-1',
  tenantId: 'tenant-1',
  conversationId: 'actor-1',
};

describe('Event Actor turn module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps history token ordering behind one turn interface', async () => {
    const order: string[] = [];
    const begin = jest.fn(async () => {
      order.push('begin');
      return true;
    });
    const persistToken = jest.fn(async () => {
      order.push('persist');
    });
    const invoke = jest.fn(async () => {
      order.push('invoke');
      return 'history-result';
    });
    const complete = jest.fn(async () => {
      order.push('complete');
      return true;
    });
    const turn = createAgentEventActorTurn(
      { strategy: 'history', history: { owner, persistToken, invoke } },
      { history: { begin, complete } },
    );

    await expect(turn.run()).resolves.toEqual({
      adapter: 'history',
      value: 'history-result',
    });
    expect(order).toEqual(['begin', 'persist', 'invoke']);

    await turn.historyPersisted();
    await turn.historyPersisted();

    expect(order).toEqual(['begin', 'persist', 'invoke', 'complete']);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith({
      ...owner,
      token: expect.any(String),
    });
  });

  it('releases an acquired history fence when token persistence fails before invocation', async () => {
    const begin = jest.fn().mockResolvedValue(true);
    const complete = jest.fn().mockResolvedValue(true);
    const invoke = jest.fn();
    const turn = createAgentEventActorTurn(
      {
        strategy: 'history',
        history: {
          owner,
          persistToken: jest.fn().mockRejectedValue(new Error('metadata unavailable')),
          invoke,
        },
      },
      { history: { begin, complete } },
    );

    await expect(turn.run()).rejects.toThrow('metadata unavailable');
    expect(invoke).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith({
      ...owner,
      token: expect.any(String),
    });
  });

  it('retains an unstarted history fence until transient release failure can be retried', async () => {
    const complete = jest
      .fn()
      .mockRejectedValueOnce(new Error('conversation store unavailable'))
      .mockResolvedValueOnce(true);
    const turn = createAgentEventActorTurn(
      {
        strategy: 'history',
        history: {
          owner,
          persistToken: jest.fn().mockRejectedValue(new Error('metadata unavailable')),
          invoke: jest.fn(),
        },
      },
      { history: { begin: jest.fn().mockResolvedValue(true), complete } },
    );

    await expect(turn.run()).rejects.toThrow('metadata unavailable');
    await turn.historyPersisted();

    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1][0]).toEqual(complete.mock.calls[0][0]);
  });

  it('retains an invoked history fence until durable history is acknowledged', async () => {
    const complete = jest.fn().mockResolvedValue(true);
    const turn = createAgentEventActorTurn(
      {
        strategy: 'fresh',
        history: {
          owner,
          persistToken: jest.fn().mockResolvedValue(undefined),
          invoke: jest.fn().mockRejectedValue(new Error('provider failed')),
        },
      },
      { history: { begin: jest.fn().mockResolvedValue(true), complete } },
    );

    await expect(turn.run()).rejects.toThrow('provider failed');
    expect(complete).not.toHaveBeenCalled();

    await turn.historyPersisted();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('delegates checkpoint execution without exposing history state', async () => {
    const input = {
      invocationId: 'delivery-1',
    } as ExecuteAgentEventActorInput<string>;
    const actor = {} as AgentEventActorDependencies;
    mockExecuteAgentEventActor.mockResolvedValue({
      value: 'checkpoint-result',
      execution: { status: 'completed' },
    });
    const turn = createAgentEventActorTurn(
      { strategy: 'checkpoint', checkpoint: { kind: 'execute', input } },
      { actor },
    );

    await expect(turn.run()).resolves.toEqual({
      adapter: 'checkpoint',
      value: 'checkpoint-result',
      execution: { status: 'completed' },
    });
    expect(mockExecuteAgentEventActor).toHaveBeenCalledWith(input, actor);
    await expect(turn.historyPersisted()).resolves.toBeUndefined();
  });

  it('delegates checkpoint resume through the same interface', async () => {
    const input = {
      resumeAttemptId: 'resume-1',
    } as ResumeAgentEventActorInput<string>;
    const actor = {} as AgentEventActorDependencies;
    mockResumeAgentEventActor.mockResolvedValue({
      value: 'resume-result',
      execution: { status: 'applied' },
    });
    const turn = createAgentEventActorTurn(
      { strategy: 'checkpoint', checkpoint: { kind: 'resume', input } },
      { actor },
    );

    await expect(turn.run()).resolves.toEqual({
      adapter: 'checkpoint',
      value: 'resume-result',
      execution: { status: 'applied' },
    });
    expect(mockResumeAgentEventActor).toHaveBeenCalledWith(input, actor);
  });

  it('settles an historical token without exposing its storage vocabulary to callers', async () => {
    const complete = jest.fn().mockResolvedValue(true);
    await expect(
      settleAgentEventActorHistoryTurn({ ...owner, token: 'historical-token' }, complete),
    ).resolves.toBe(true);
    expect(complete).toHaveBeenCalledWith({
      ...owner,
      token: 'historical-token',
    });
  });
});

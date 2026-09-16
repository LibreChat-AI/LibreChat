import { Types } from 'mongoose';
import { ReasoningEffort } from 'librechat-data-provider';
import { AgentQueuedTurnLaneRetiredError } from '@librechat/data-schemas';
import type { AgentQueuedTurnMethods, AgentQueuedTurnRecord } from '@librechat/data-schemas';
import type { AgentQueuedTurnHttpDeps } from './queuedTurnHttp';
import {
  handleAgentQueuedTurnCancel,
  handleAgentQueuedTurnEnqueue,
  handleAgentQueuedTurnList,
} from './queuedTurnHttp';

const USER_ID = '507f191e810c19729de860ea';

function turn(status: AgentQueuedTurnRecord['status']): AgentQueuedTurnRecord {
  return {
    queuedTurnId: 'queued-turn-1',
    user: new Types.ObjectId(USER_ID),
    conversationId: 'conversation-1',
    agentId: 'agent_1',
    parentMessageId: 'assistant-1',
    clientRequestId: 'client-request-1',
    fingerprint: 'fingerprint-1',
    sequence: 1,
    status,
    priority: false,
    text: 'follow up',
    reasoningOverride: { key: 'reasoning_effort', value: ReasoningEffort.high },
    attempts: status === 'admitted' ? 1 : 0,
    availableAt: new Date('2026-08-30T12:00:00Z'),
    createdAt: new Date('2026-08-30T12:00:00Z'),
  };
}

function requestBody() {
  return {
    conversationId: 'conversation-1',
    parentMessageId: 'assistant-1',
    clientRequestId: 'client-request-1',
    text: 'follow up',
    reasoningOverride: { key: 'reasoning_effort', value: ReasoningEffort.high },
  };
}

describe('Agent queued-turn HTTP admission receipts', () => {
  it('rejects an enqueue after conversation deletion closes its lane', async () => {
    const methods = {
      getConvo: jest.fn(async () => ({ agent_id: 'agent_1', endpoint: 'agents' })),
      getAgentQueuedTurnByClientRequestId: jest.fn(async () => null),
      enqueueAgentQueuedTurn: jest.fn(async () => {
        throw new AgentQueuedTurnLaneRetiredError();
      }),
    };
    const deps = {
      methods: methods as unknown as AgentQueuedTurnMethods & {
        getConvo: typeof methods.getConvo;
      },
      lifecycle: { schedule: jest.fn(), cancel: jest.fn() },
      checkAgentAccess: jest.fn(async () => true),
    } satisfies AgentQueuedTurnHttpDeps;

    await expect(
      handleAgentQueuedTurnEnqueue({ id: USER_ID }, requestBody(), deps),
    ).resolves.toEqual({
      status: 409,
      body: { code: 'QUEUED_TURN_CONVERSATION_DELETING' },
    });
  });

  it('resolves a scheduling-pending response through an exact same-body terminal replay', async () => {
    const enqueueAgentQueuedTurn = jest
      .fn()
      .mockResolvedValueOnce({ turn: turn('queued'), replayed: false });
    const admitted = {
      ...turn('admitted'),
      terminalReceipt: {
        outcome: 'admitted' as const,
        settledAt: new Date('2026-08-30T12:01:00Z'),
        admissionId: 'client-request-1',
        generationId: 'generation-1',
        generationCreatedAt: 43,
        effectivePredecessorCreatedAt: 42,
      },
    };
    const getAgentQueuedTurnByClientRequestId = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(admitted);
    const schedule = jest.fn().mockRejectedValueOnce(new Error('scheduler unavailable'));
    const methods = {
      getConvo: jest.fn(async () => ({
        agent_id: 'agent_1',
        endpoint: 'agents',
      })),
      enqueueAgentQueuedTurn,
      getAgentQueuedTurnByClientRequestId,
      listActiveAgentQueuedTurns: jest.fn(async () => []),
    };
    const deps = {
      methods: methods as unknown as AgentQueuedTurnMethods & {
        getConvo: typeof methods.getConvo;
      },
      lifecycle: { schedule, cancel: jest.fn() },
      checkAgentAccess: jest.fn(async () => true),
    } satisfies AgentQueuedTurnHttpDeps;

    await expect(
      handleAgentQueuedTurnEnqueue({ id: USER_ID }, requestBody(), deps),
    ).resolves.toMatchObject({
      status: 503,
      body: { code: 'QUEUED_TURN_SCHEDULING_PENDING' },
    });
    await expect(
      handleAgentQueuedTurnEnqueue({ id: USER_ID }, requestBody(), deps),
    ).resolves.toMatchObject({
      status: 200,
      body: {
        receipt: {
          queuedTurnId: 'queued-turn-1',
          clientRequestId: 'client-request-1',
          status: 'admitted',
          effectivePredecessorCreatedAt: 42,
        },
      },
    });

    expect(getAgentQueuedTurnByClientRequestId).toHaveBeenCalledTimes(2);
    expect(getAgentQueuedTurnByClientRequestId.mock.calls[1][0]).toEqual(
      getAgentQueuedTurnByClientRequestId.mock.calls[0][0],
    );
    expect(enqueueAgentQueuedTurn).toHaveBeenCalledTimes(1);
    expect(enqueueAgentQueuedTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        reasoningOverride: { key: 'reasoning_effort', value: ReasoningEffort.high },
      }),
    );
    expect(methods.getConvo).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it('rejects an idempotent replay when only the reasoning override changes', async () => {
    const existing = turn('queued');
    const methods = {
      getConvo: jest.fn(),
      getAgentQueuedTurnByClientRequestId: jest.fn(async () => existing),
      enqueueAgentQueuedTurn: jest.fn(),
    };
    const deps = {
      methods: methods as unknown as AgentQueuedTurnMethods & {
        getConvo: typeof methods.getConvo;
      },
      lifecycle: { schedule: jest.fn(), cancel: jest.fn() },
    } satisfies AgentQueuedTurnHttpDeps;

    await expect(
      handleAgentQueuedTurnEnqueue(
        { id: USER_ID },
        {
          ...requestBody(),
          reasoningOverride: { key: 'reasoning_effort', value: ReasoningEffort.low },
        },
        deps,
      ),
    ).resolves.toEqual({
      status: 409,
      body: { code: 'QUEUED_TURN_IDEMPOTENCY_CONFLICT' },
    });
    expect(methods.getConvo).not.toHaveBeenCalled();
    expect(methods.enqueueAgentQueuedTurn).not.toHaveBeenCalled();
  });

  it('surfaces a dead receipt and lets the user dismiss its delivery', async () => {
    const dead = {
      ...turn('dead'),
      deliveryKey: 'delivery-1',
      settledAt: new Date('2026-08-30T12:01:00Z'),
      terminalReceipt: {
        outcome: 'dead' as const,
        settledAt: new Date('2026-08-30T12:01:00Z'),
        failure: { code: 'ATTEMPTS_EXHAUSTED', message: 'could not admit turn' },
      },
    };
    const cancelled = {
      ...dead,
      status: 'cancelled' as const,
      terminalReceipt: {
        outcome: 'cancelled' as const,
        settledAt: new Date('2026-08-30T12:02:00Z'),
      },
    };
    const methods = {
      getConvo: jest.fn(async () => ({ agent_id: 'agent_1', endpoint: 'agents' })),
      listAgentQueuedTurnReceipts: jest.fn(async () => [dead]),
    };
    const cancel = jest.fn(async () => ({ outcome: 'cancelled' as const, turn: cancelled }));
    const deps = {
      methods: methods as unknown as AgentQueuedTurnMethods & {
        getConvo: typeof methods.getConvo;
      },
      lifecycle: { schedule: jest.fn(), cancel },
      checkAgentAccess: jest.fn(async () => true),
    } satisfies AgentQueuedTurnHttpDeps;

    await expect(
      handleAgentQueuedTurnList({ id: USER_ID }, 'conversation-1', deps),
    ).resolves.toMatchObject({
      status: 200,
      body: {
        queuedTurns: [
          {
            queuedTurnId: 'queued-turn-1',
            status: 'dead',
            failure: { code: 'ATTEMPTS_EXHAUSTED', message: 'could not admit turn' },
          },
        ],
      },
    });
    await expect(
      handleAgentQueuedTurnCancel({ id: USER_ID }, 'queued-turn-1', deps),
    ).resolves.toMatchObject({
      status: 200,
      body: { receipt: { queuedTurnId: 'queued-turn-1', status: 'cancelled' } },
    });
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ queuedTurnId: 'queued-turn-1' }));
  });

  it('projects an explicit root admission without a timestamp boundary', async () => {
    const admitted = {
      ...turn('admitted'),
      terminalReceipt: {
        outcome: 'admitted' as const,
        settledAt: new Date('2026-08-30T12:01:00Z'),
        admissionId: 'client-request-1',
        generationId: 'generation-root',
        generationCreatedAt: 43,
        lineagePredecessorId: 'root:message-identity',
        rootPredecessor: true as const,
      },
    };
    const methods = {
      getConvo: jest.fn(async () => ({ agent_id: 'agent_1', endpoint: 'agents' })),
      listAgentQueuedTurnReceipts: jest.fn(async () => [admitted]),
    };
    const deps = {
      methods: methods as unknown as AgentQueuedTurnMethods & {
        getConvo: typeof methods.getConvo;
      },
      lifecycle: { schedule: jest.fn(), cancel: jest.fn() },
      checkAgentAccess: jest.fn(async () => true),
    } satisfies AgentQueuedTurnHttpDeps;

    await expect(
      handleAgentQueuedTurnList({ id: USER_ID }, 'conversation-1', deps),
    ).resolves.toMatchObject({
      status: 200,
      body: {
        queuedTurns: [
          {
            queuedTurnId: 'queued-turn-1',
            status: 'admitted',
            rootPredecessor: true,
          },
        ],
      },
    });
  });

  it('retires a cancelled source after its published delivery receipt expires', async () => {
    const cancelled = {
      ...turn('cancelled'),
      deliveryKey: 'delivery-expired',
      deliveryState: 'published' as const,
      terminalReceipt: {
        outcome: 'cancelled' as const,
        settledAt: new Date('2026-08-30T12:02:00Z'),
      },
    };
    const methods = {
      getConvo: jest.fn(async () => ({ agent_id: 'agent_1', endpoint: 'agents' })),
    };
    const cancel = jest.fn(async () => ({
      outcome: 'already_cancelled' as const,
      turn: cancelled,
    }));
    const deps = {
      methods: methods as unknown as AgentQueuedTurnMethods & {
        getConvo: typeof methods.getConvo;
      },
      lifecycle: { schedule: jest.fn(), cancel },
    } satisfies AgentQueuedTurnHttpDeps;

    await expect(
      handleAgentQueuedTurnCancel({ id: USER_ID }, 'queued-turn-1', deps),
    ).resolves.toMatchObject({ status: 200 });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

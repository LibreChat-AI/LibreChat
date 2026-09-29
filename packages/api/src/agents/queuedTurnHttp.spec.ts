import { Types } from 'mongoose';
import { AgentQueuedTurnLaneRetiredError } from '@librechat/data-schemas';
import type { AgentQueuedTurnMethods, AgentQueuedTurnRecord } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { AgentQueuedTurnHttpDeps } from './queuedTurnHttp';
import {
  createAgentQueuedTurnEnqueueHandlers,
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
  };
}

describe('Agent queued-turn HTTP admission receipts', () => {
  it('refuses snapshot writes on v1 before ownership lookup or persistence', async () => {
    const getConvo = jest.fn();
    const methods = { getConvo } as unknown as AgentQueuedTurnMethods & {
      getConvo: typeof getConvo;
    };
    await expect(
      handleAgentQueuedTurnEnqueue(
        { id: USER_ID },
        { ...requestBody(), codeApprovalMode: 'fullAccess' },
        {
          methods,
          lifecycle: { schedule: jest.fn(), cancel: jest.fn() },
        },
      ),
    ).resolves.toMatchObject({ status: 409, body: { code: 'QUEUED_TURN_PROTOCOL_REQUIRED' } });
    expect(getConvo).not.toHaveBeenCalled();
  });

  it('reserves the v2 publication identity with the authorized snapshot', async () => {
    const enqueue = jest.fn().mockResolvedValue({ turn: turn('queued'), replayed: false });
    const getConvo = jest.fn(async () => ({ agent_id: 'agent_1', endpoint: 'agents' }));
    const methods = {
      getConvo,
      getAgentQueuedTurnByClientRequestId: jest.fn(async () => null),
      enqueueAgentQueuedTurn: enqueue,
      listActiveAgentQueuedTurns: jest.fn(async () => []),
      getAgentQueuedTurnLaneSnapshot: jest.fn(async () => ({
        revision: 0,
        recoveryRequired: false,
      })),
    } as unknown as AgentQueuedTurnMethods & { getConvo: typeof getConvo };
    await expect(
      handleAgentQueuedTurnEnqueue(
        { id: USER_ID },
        { ...requestBody(), codeApprovalMode: 'ask' },
        {
          protocolVersion: 2,
          methods,
          checkAgentAccess: jest.fn(async () => true),
          lifecycle: { schedule: jest.fn(), cancel: jest.fn() },
        },
      ),
    ).resolves.toMatchObject({ status: 202, body: { capability: { protocolVersion: 2 } } });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        codeApprovalMode: 'ask',
        deliveryReservation: {
          queuedTurnId: expect.stringMatching(/^[a-f0-9]{24}$/),
          deliveryKey: expect.any(String),
        },
      }),
    );
  });

  it('rejects a same-id replay that changes its queued approval snapshot', async () => {
    const saved = { ...turn('admitted'), codeApprovalMode: 'ask' as const };
    const methods = {
      getConvo: jest.fn(),
      getAgentQueuedTurnByClientRequestId: jest.fn(async () => saved),
    };
    const deps = {
      protocolVersion: 2,
      methods: methods as unknown as AgentQueuedTurnMethods & { getConvo: typeof methods.getConvo },
      lifecycle: { schedule: jest.fn(), cancel: jest.fn() },
    } satisfies AgentQueuedTurnHttpDeps;
    await expect(
      handleAgentQueuedTurnEnqueue(
        { id: USER_ID },
        { ...requestBody(), codeApprovalMode: 'fullAccess' },
        deps,
      ),
    ).resolves.toEqual({ status: 409, body: { code: 'QUEUED_TURN_IDEMPOTENCY_CONFLICT' } });
    expect(methods.getConvo).not.toHaveBeenCalled();
    await expect(
      handleAgentQueuedTurnEnqueue(
        { id: USER_ID },
        { ...requestBody(), codeApprovalMode: 'ask' },
        deps,
      ),
    ).resolves.toMatchObject({ status: 200, body: { receipt: { codeApprovalMode: 'ask' } } });
  });

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
    expect(methods.getConvo).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(1);
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

describe('queued-turn enqueue adapters', () => {
  const getConvo = jest.fn();
  const getDependencies = jest.fn(() => ({
    protocolVersion: 2 as const,
    methods: {
      getConvo,
      getAgentQueuedTurnByClientRequestId: jest.fn(async () => ({
        ...turn('admitted'),
        codeApprovalMode: 'ask',
      })),
    } as unknown as AgentQueuedTurnHttpDeps['methods'],
    lifecycle: { schedule: jest.fn(), cancel: jest.fn() },
  }));

  beforeEach(() => jest.clearAllMocks());

  it.each(['enqueue', 'enqueueV2'] as const)(
    'pins %s protocol in the TypeScript adapter',
    async (name) => {
      const handlers = createAgentQueuedTurnEnqueueHandlers(getDependencies);
      const req = {
        user: { id: USER_ID },
        body: { ...requestBody(), codeApprovalMode: 'ask', protocolVersion: 2 },
      } as unknown as Request;
      const status = jest.fn().mockReturnThis();
      const json = jest.fn();
      const res = { status, json } as unknown as Response;
      await handlers[name](req, res, jest.fn());
      expect(getDependencies).toHaveBeenCalledWith(req);
      expect(getConvo).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(name === 'enqueue' ? 409 : 200);
      if (name === 'enqueueV2') {
        expect(json).toHaveBeenCalledWith(
          expect.objectContaining({
            receipt: expect.objectContaining({ queuedTurnId: 'queued-turn-1' }),
          }),
        );
      }
    },
  );

  it('bounds dependency failures as enqueue errors', async () => {
    const handlers = createAgentQueuedTurnEnqueueHandlers(() => {
      throw new Error('dependencies unavailable');
    });
    const status = jest.fn().mockReturnThis();
    const json = jest.fn();
    await handlers.enqueueV2({} as Request, { status, json } as unknown as Response, jest.fn());
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ code: 'QUEUED_TURN_ENQUEUE_FAILED' });
  });
});

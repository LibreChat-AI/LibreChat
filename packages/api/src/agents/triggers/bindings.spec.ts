import express from 'express';
import request from 'supertest';
import type { IConversation } from '@librechat/data-schemas';
import { createAgentEventBindingHandlers } from './bindings';

const USER_ID = '507f191e810c19729de860ea';
const SOURCE_KEY_ID = '507f191e810c19729de860eb';
const PARENT_ID = 'parent-conversation';
const PARENT_MESSAGE_ID = 'parent-message';
const PARENT_AGENT_ID = 'agent_director';
const CHILD_AGENT_ID = 'agent_player';

function parent(): IConversation {
  return {
    conversationId: PARENT_ID,
    user: USER_ID,
    tenantId: 'tenant-1',
    agent_id: PARENT_AGENT_ID,
  } as IConversation;
}

function dependencies() {
  const reserveThread = jest.fn(async (input) => ({
    created: true,
    conversation: {
      ...input.conversation,
      user: input.user,
      conversationId: input.conversationId,
    },
  }));
  return {
    getAgent: jest.fn<Promise<unknown>, [Record<string, unknown>]>(async ({ id }) =>
      id === PARENT_AGENT_ID
        ? {
            id: PARENT_AGENT_ID,
            subagents: { enabled: true, allowSelf: false, agent_ids: [CHILD_AGENT_ID] },
          }
        : { id },
    ),
    getConvo: jest.fn<Promise<IConversation | null>, [string, string]>(async () => parent()),
    getBinding: jest.fn<Promise<unknown>, [Record<string, unknown>]>(async () => null),
    getMessage: jest.fn(async () => ({
      messageId: PARENT_MESSAGE_ID,
      conversationId: PARENT_ID,
      user: USER_ID,
    })),
    deleteConvos: jest.fn(async () => ({ deletedCount: 1 })),
    reserveThread,
  };
}

function app(deps = dependencies()) {
  const handlers = createAgentEventBindingHandlers(deps as never);
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    Object.assign(req, {
      user: { id: USER_ID, tenantId: 'tenant-1' },
      apiKeyId: { toString: () => SOURCE_KEY_ID },
    });
    next();
  });
  server.post('/bindings', handlers.register);
  server.post('/resolve', handlers.resolve, (req, res) => {
    res.json(req.body);
  });
  return { server, deps };
}

describe('agent event bindings', () => {
  it('reserves a hidden depth-one actor thread bound to the authenticated API key', async () => {
    const { server, deps } = app();
    const response = await request(server)
      .post('/bindings')
      .set('Idempotency-Key', 'championship-player-a')
      .send({
        actorId: 'player-a',
        parentConversationId: PARENT_ID,
        parentMessageId: PARENT_MESSAGE_ID,
        target: { agentId: CHILD_AGENT_ID },
      });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      id: expect.stringMatching(/^evtbind_/),
      actorId: 'player-a',
      agentId: CHILD_AGENT_ID,
      threadId: expect.any(String),
    });
    expect(deps.reserveThread).toHaveBeenCalledWith(
      expect.objectContaining({
        user: USER_ID,
        tenantId: 'tenant-1',
        conversation: expect.objectContaining({
          agent_id: CHILD_AGENT_ID,
          agentEventBinding: expect.objectContaining({ sourceKeyId: SOURCE_KEY_ID }),
          subagentThread: expect.objectContaining({
            parentConversationId: PARENT_ID,
            parentMessageId: PARENT_MESSAGE_ID,
            parentAgentId: PARENT_AGENT_ID,
            subagentType: CHILD_AGENT_ID,
            depth: 1,
          }),
        }),
      }),
    );
  });

  it('rejects a target that is not a configured direct child', async () => {
    const { server, deps } = app();
    deps.getAgent.mockResolvedValueOnce({
      id: PARENT_AGENT_ID,
      subagents: { enabled: true, allowSelf: false, agent_ids: [] },
    } as never);
    const response = await request(server)
      .post('/bindings')
      .set('Idempotency-Key', 'not-configured')
      .send({
        actorId: 'player-a',
        parentConversationId: PARENT_ID,
        parentMessageId: PARENT_MESSAGE_ID,
        target: { agentId: CHILD_AGENT_ID },
      });

    expect(response.status).toBe(403);
    expect(deps.reserveThread).not.toHaveBeenCalled();
  });

  it('resolves a bound continue without accepting a caller-selected target', async () => {
    const deps = dependencies();
    deps.getBinding.mockResolvedValue({
      conversationId: 'child-thread',
      agentId: CHILD_AGENT_ID,
      tenantId: 'tenant-1',
      binding: {
        bindingId: `evtbind_${'a'.repeat(48)}`,
        sourceKeyId: SOURCE_KEY_ID,
        actorId: 'player-a',
      },
      lineage: {
        rootConversationId: PARENT_ID,
        parentConversationId: PARENT_ID,
        parentMessageId: PARENT_MESSAGE_ID,
        parentToolCallId: 'event-binding',
        parentAgentId: PARENT_AGENT_ID,
        subagentType: CHILD_AGENT_ID,
        subagentKind: 'agent',
        depth: 1,
      },
    });
    const { server } = app(deps);
    const response = await request(server)
      .post('/resolve')
      .send({
        mode: 'continue',
        bindingId: `evtbind_${'a'.repeat(48)}`,
        orderingKey: 'attacker-selected-lane',
        target: { agentId: 'agent_attacker', conversationId: 'foreign-thread' },
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      mode: 'continue',
      orderingKey: `evtbind_${'a'.repeat(48)}`,
      target: {
        agentId: CHILD_AGENT_ID,
        conversationId: 'child-thread',
        bindingId: `evtbind_${'a'.repeat(48)}`,
        sourceKeyId: SOURCE_KEY_ID,
      },
    });
    expect(response.body.target.agentId).not.toBe('agent_attacker');
    expect(response.body.orderingKey).not.toBe('attacker-selected-lane');
    expect(deps.getBinding).toHaveBeenCalledWith({
      user: USER_ID,
      tenantId: 'tenant-1',
      bindingId: `evtbind_${'a'.repeat(48)}`,
      sourceKeyId: SOURCE_KEY_ID,
    });
  });

  it('rejects a parent message outside the selected conversation', async () => {
    const deps = dependencies();
    deps.getMessage.mockResolvedValueOnce({
      messageId: PARENT_MESSAGE_ID,
      conversationId: 'another-conversation',
      user: USER_ID,
    });
    const { server } = app(deps);
    const response = await request(server)
      .post('/bindings')
      .set('Idempotency-Key', 'bad-parent-message')
      .send({
        actorId: 'player-a',
        parentConversationId: PARENT_ID,
        parentMessageId: PARENT_MESSAGE_ID,
        target: { agentId: CHILD_AGENT_ID },
      });

    expect(response.status).toBe(404);
    expect(deps.reserveThread).not.toHaveBeenCalled();
  });

  it('returns an idempotency conflict before reserving under a different parent', async () => {
    const deps = dependencies();
    const { server } = app(deps);
    const first = await request(server)
      .post('/bindings')
      .set('Idempotency-Key', 'cross-parent-replay')
      .send({
        actorId: 'player-a',
        parentConversationId: PARENT_ID,
        parentMessageId: PARENT_MESSAGE_ID,
        target: { agentId: CHILD_AGENT_ID },
      });

    expect(first.status).toBe(201);
    const reservation = await deps.reserveThread.mock.results[0].value;
    deps.getConvo.mockResolvedValueOnce({
      ...parent(),
      conversationId: 'other-parent',
    } as unknown as IConversation);
    deps.getMessage.mockResolvedValueOnce({
      messageId: PARENT_MESSAGE_ID,
      conversationId: 'other-parent',
      user: USER_ID,
    });
    deps.getBinding.mockResolvedValueOnce({
      conversationId: reservation.conversation.conversationId,
      agentId: reservation.conversation.agent_id,
      tenantId: reservation.conversation.tenantId,
      binding: reservation.conversation.agentEventBinding,
      lineage: reservation.conversation.subagentThread,
    } as never);
    const response = await request(server)
      .post('/bindings')
      .set('Idempotency-Key', 'cross-parent-replay')
      .send({
        actorId: 'player-a',
        parentConversationId: 'other-parent',
        parentMessageId: PARENT_MESSAGE_ID,
        target: { agentId: CHILD_AGENT_ID },
      });

    expect(response.status).toBe(409);
    expect(deps.reserveThread).toHaveBeenCalledTimes(1);
  });

  it('rolls back a new binding when its parent loses the registration race', async () => {
    const deps = dependencies();
    deps.getConvo.mockResolvedValueOnce(parent()).mockResolvedValueOnce(null);
    const { server } = app(deps);
    const response = await request(server)
      .post('/bindings')
      .set('Idempotency-Key', 'parent-delete-race')
      .send({
        actorId: 'player-a',
        parentConversationId: PARENT_ID,
        parentMessageId: PARENT_MESSAGE_ID,
        target: { agentId: CHILD_AGENT_ID },
      });

    expect(response.status).toBe(409);
    expect(deps.deleteConvos).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ conversationId: expect.any(String) }),
    );
  });

  it('rejects an idempotent replay when the parent disappears after the first read', async () => {
    const deps = dependencies();
    /** Fill the deterministic binding id after the request computes it. */
    deps.getBinding.mockImplementationOnce(async (input) => ({
      conversationId: 'child-thread',
      agentId: CHILD_AGENT_ID,
      tenantId: 'tenant-1',
      binding: {
        bindingId: input.bindingId,
        sourceKeyId: SOURCE_KEY_ID,
        actorId: 'player-a',
      },
      lineage: {
        rootConversationId: PARENT_ID,
        parentConversationId: PARENT_ID,
        parentMessageId: PARENT_MESSAGE_ID,
        parentToolCallId: `event-binding:${input.bindingId}`,
        parentAgentId: PARENT_AGENT_ID,
        subagentType: CHILD_AGENT_ID,
        subagentKind: 'agent',
        depth: 1,
      },
    }));
    deps.getConvo.mockResolvedValueOnce(parent()).mockResolvedValueOnce(null);
    const { server } = app(deps);

    const response = await request(server)
      .post('/bindings')
      .set('Idempotency-Key', 'parent-replay-race')
      .send({
        actorId: 'player-a',
        parentConversationId: PARENT_ID,
        parentMessageId: PARENT_MESSAGE_ID,
        target: { agentId: CHILD_AGENT_ID },
      });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('event_binding_parent_ended');
    expect(deps.deleteConvos).toHaveBeenCalledWith(USER_ID, {
      conversationId: 'child-thread',
    });
    expect(deps.reserveThread).not.toHaveBeenCalled();
  });

  it('surfaces a failed rollback and lets a retry reconcile the orphan', async () => {
    const deps = dependencies();
    deps.getConvo.mockResolvedValueOnce(parent()).mockResolvedValueOnce(null);
    deps.deleteConvos
      .mockRejectedValueOnce(new Error('stepdown'))
      .mockRejectedValueOnce(new Error('stepdown'))
      .mockRejectedValueOnce(new Error('stepdown'));
    const { server } = app(deps);
    const body = {
      actorId: 'player-a',
      parentConversationId: PARENT_ID,
      parentMessageId: PARENT_MESSAGE_ID,
      target: { agentId: CHILD_AGENT_ID },
    };

    const first = await request(server)
      .post('/bindings')
      .set('Idempotency-Key', 'rollback-recovery')
      .send(body);

    expect(first.status).toBe(503);
    expect(first.body.error.code).toBe('event_binding_cleanup_failed');
    const reservation = await deps.reserveThread.mock.results[0].value;
    deps.getConvo.mockResolvedValue(null);
    deps.getBinding.mockResolvedValue({
      conversationId: reservation.conversation.conversationId,
      agentId: reservation.conversation.agent_id,
      tenantId: reservation.conversation.tenantId,
      binding: reservation.conversation.agentEventBinding,
      lineage: reservation.conversation.subagentThread,
    } as never);

    const retry = await request(server)
      .post('/bindings')
      .set('Idempotency-Key', 'rollback-recovery')
      .send(body);

    expect(retry.status).toBe(409);
    expect(retry.body.error.code).toBe('event_binding_parent_ended');
    expect(deps.deleteConvos).toHaveBeenCalledTimes(4);
  });

  it('rejects registration after the parent retention deadline', async () => {
    const deps = dependencies();
    deps.getConvo.mockResolvedValueOnce({ ...parent(), expiredAt: new Date(0) } as IConversation);
    const { server } = app(deps);

    const response = await request(server)
      .post('/bindings')
      .set('Idempotency-Key', 'expired-parent')
      .send({
        actorId: 'player-a',
        parentConversationId: PARENT_ID,
        parentMessageId: PARENT_MESSAGE_ID,
        target: { agentId: CHILD_AGENT_ID },
      });

    expect(response.status).toBe(404);
    expect(deps.reserveThread).not.toHaveBeenCalled();
  });

  it('leaves fire and steer deliveries unchanged', async () => {
    const { server, deps } = app();
    const response = await request(server)
      .post('/resolve')
      .send({ mode: 'fire', target: { agentId: CHILD_AGENT_ID } });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ mode: 'fire', target: { agentId: CHILD_AGENT_ID } });
    expect(deps.getBinding).not.toHaveBeenCalled();
  });

  it('does not reinterpret another mode merely because it contains a binding id', async () => {
    const { server, deps } = app();
    const response = await request(server)
      .post('/resolve')
      .send({
        mode: 'fire',
        bindingId: `evtbind_${'a'.repeat(48)}`,
        target: { agentId: CHILD_AGENT_ID },
      });

    expect(response.status).toBe(400);
    expect(deps.getBinding).not.toHaveBeenCalled();
  });
});

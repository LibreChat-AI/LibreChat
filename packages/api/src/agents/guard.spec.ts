import express from 'express';
import request from 'supertest';
import type { AllMethods, IConversation } from '@librechat/data-schemas';
import {
  CHILD_THREAD_READ_ONLY_ERROR,
  createSubagentThreadTurnGuard,
  isSubagentThreadWriteBlocked,
} from './guard';
import { createSubagentThreadId } from './subagentThreadIds';
import { SubagentThreadTaskStore } from './subagentThreads';

function childConversation(): IConversation {
  return {
    conversationId: 'child-conversation',
    endpoint: 'agents',
    title: 'Child',
    agent_id: 'child-agent',
    subagentThread: {
      rootConversationId: 'parent-conversation',
      parentConversationId: 'parent-conversation',
      parentMessageId: 'parent-message',
      parentToolCallId: 'parent-tool-call',
      parentAgentId: 'parent-agent',
      subagentType: 'child-agent',
      subagentKind: 'agent',
      depth: 1,
    },
  } as IConversation;
}

function makeStore(): SubagentThreadTaskStore {
  const unused = jest.fn();
  return new SubagentThreadTaskStore({
    acquireSubagentThreadLease: unused as AllMethods['acquireSubagentThreadLease'],
    claimSubagentTaskResult: unused as AllMethods['claimSubagentTaskResult'],
    countActiveSubagentThreadLeases: unused as AllMethods['countActiveSubagentThreadLeases'],
    deleteConvos: unused as AllMethods['deleteConvos'],
    deleteMessages: unused as AllMethods['deleteMessages'],
    getConvo: unused as AllMethods['getConvo'],
    getSubagentTaskControlReplay: unused as AllMethods['getSubagentTaskControlReplay'],
    getMessages: unused as AllMethods['getMessages'],
    listActiveSubagentThreadLeases: unused as AllMethods['listActiveSubagentThreadLeases'],
    recordSubagentTaskControlReceipt: unused as AllMethods['recordSubagentTaskControlReceipt'],
    releaseSubagentThreadLease: unused as AllMethods['releaseSubagentThreadLease'],
    reserveSubagentThread: unused as AllMethods['reserveSubagentThread'],
    renewSubagentThreadLease: unused as AllMethods['renewSubagentThreadLease'],
    saveConvo: unused as AllMethods['saveConvo'],
    saveMessage: unused as AllMethods['saveMessage'],
  });
}

function createApp(
  getConvo: AllMethods['getConvo'],
  store: SubagentThreadTaskStore,
  getEventBinding?: AllMethods['getAgentEventBinding'],
  isHumanResumeAllowed?: () => Promise<boolean>,
  preResolved?: { conversation: IConversation | null },
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 'user-1', tenantId: 'tenant-1' };
    (req as typeof req & { _isAgentTrigger?: boolean })._isAgentTrigger =
      req.get('x-test-trigger') === '1';
    if (preResolved) {
      (req as typeof req & { resolvedConversation?: IConversation | null }).resolvedConversation =
        preResolved.conversation;
    }
    next();
  });
  const guard = createSubagentThreadTurnGuard({
    getConvo,
    store,
    getEventBinding,
    isHumanResumeAllowed,
  });
  const handler = (req: express.Request, res: express.Response) => {
    res.json({
      ok: true,
      resolvedConversationId: (req as typeof req & { resolvedConversation?: IConversation | null })
        .resolvedConversation?.conversationId,
      parentConversationId: (
        req as typeof req & { _agentEventBindingParentConversationId?: string }
      )._agentEventBindingParentConversationId,
      bindingId: (req as typeof req & { _agentEventBindingId?: string })._agentEventBindingId,
      retention: (
        req as typeof req & {
          _agentEventBindingRetention?: { isTemporary?: boolean; expiredAt?: Date };
        }
      )._agentEventBindingRetention,
    });
  };
  app.post('/chat', guard, handler);
  app.post('/resume', guard, handler);
  return app;
}

describe('subagent child-thread write policy', () => {
  it('allows an ordinary conversation and new-conversation requests', async () => {
    const getConvo = jest.fn().mockResolvedValue({
      conversationId: 'ordinary-conversation',
      endpoint: 'agents',
    });
    const store = makeStore();
    const app = createApp(getConvo, store);

    const ordinary = await request(app)
      .post('/chat')
      .send({ conversationId: 'ordinary-conversation' });
    const fresh = await request(app).post('/chat').send({ conversationId: 'new' });

    expect(ordinary.status).toBe(200);
    expect(ordinary.body).toEqual({
      ok: true,
      resolvedConversationId: 'ordinary-conversation',
    });
    expect(fresh.status).toBe(200);
    expect(getConvo).toHaveBeenCalledTimes(1);
  });

  it('reuses a conversation an earlier middleware already read instead of re-reading it', async () => {
    const getConvo = jest.fn();
    const store = makeStore();

    const ordinary = await request(
      createApp(getConvo, store, undefined, undefined, {
        conversation: {
          conversationId: 'ordinary-conversation',
          endpoint: 'agents',
        } as IConversation,
      }),
    )
      .post('/chat')
      .send({ conversationId: 'ordinary-conversation' });
    const child = await request(
      createApp(getConvo, store, undefined, undefined, { conversation: childConversation() }),
    )
      .post('/chat')
      .send({ conversationId: 'child-conversation', agent_id: 'child-agent' });
    const absent = await request(
      createApp(getConvo, store, undefined, undefined, { conversation: null }),
    )
      .post('/chat')
      .send({ conversationId: 'missing-conversation' });

    expect(ordinary.status).toBe(200);
    expect(ordinary.body).toEqual({ ok: true, resolvedConversationId: 'ordinary-conversation' });
    expect(child.status).toBe(409);
    expect(child.body).toEqual({ error: CHILD_THREAD_READ_ONLY_ERROR });
    expect(absent.status).toBe(200);
    expect(getConvo).not.toHaveBeenCalled();
  });

  it('rejects every model-bound human turn against a durable child conversation', async () => {
    const store = makeStore();
    const response = await request(
      createApp(jest.fn().mockResolvedValue(childConversation()), store),
    )
      .post('/chat')
      .send({ conversationId: 'child-conversation', agent_id: 'child-agent' });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: CHILD_THREAD_READ_ONLY_ERROR });
  });

  it('allows only the authenticated trigger bound to this child conversation', async () => {
    const store = makeStore();
    const getEventBinding = jest.fn(async () => ({
      conversationId: 'child-conversation',
      agentId: 'child-agent',
      tenantId: 'tenant-1',
      isTemporary: true,
      expiredAt: new Date('2099-08-22T00:00:00.000Z'),
      binding: {
        bindingId: `evtbind_${'a'.repeat(48)}`,
        sourceKeyId: 'source-key',
        actorId: 'player',
      },
      lineage: childConversation().subagentThread!,
    }));
    const app = createApp(
      jest.fn(async (_user, conversationId) =>
        conversationId === 'parent-conversation'
          ? ({
              conversationId,
              agent_id: 'parent-agent',
              tenantId: 'tenant-1',
            } as IConversation)
          : childConversation(),
      ),
      store,
      getEventBinding as AllMethods['getAgentEventBinding'],
    );

    const response = await request(app)
      .post('/chat')
      .set('x-test-trigger', '1')
      .set('x-lc-agent-event-binding', `evtbind_${'a'.repeat(48)}`)
      .set('x-lc-agent-event-source-key', 'source-key')
      .send({ conversationId: 'child-conversation' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      bindingId: `evtbind_${'a'.repeat(48)}`,
      parentConversationId: 'parent-conversation',
      retention: { isTemporary: true, expiredAt: '2099-08-22T00:00:00.000Z' },
    });
    expect(getEventBinding).toHaveBeenCalledWith({
      user: 'user-1',
      tenantId: 'tenant-1',
      bindingId: `evtbind_${'a'.repeat(48)}`,
      sourceKeyId: 'source-key',
    });
  });

  it('allows only an exact pending human resume for a bound child', async () => {
    const store = makeStore();
    const reservedThreadId = createSubagentThreadId('scope', 'bound-child');
    const boundChild = {
      ...childConversation(),
      conversationId: reservedThreadId,
      tenantId: 'tenant-1',
      isTemporary: true,
      agentEventBinding: {
        bindingId: `evtbind_${'b'.repeat(48)}`,
        sourceKeyId: 'source-key',
        actorId: 'player',
      },
    } as unknown as IConversation;
    const isHumanResumeAllowed = jest.fn(async () => true);
    const app = createApp(
      jest.fn(async (_user, conversationId) =>
        conversationId === 'parent-conversation'
          ? ({ conversationId, agent_id: 'parent-agent', tenantId: 'tenant-1' } as IConversation)
          : boundChild,
      ),
      store,
      undefined,
      isHumanResumeAllowed,
    );

    const response = await request(app)
      .post('/resume')
      .send({ conversationId: reservedThreadId, actionId: 'action-1' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      resolvedConversationId: reservedThreadId,
      parentConversationId: 'parent-conversation',
      retention: { isTemporary: true },
    });
    expect(isHumanResumeAllowed).toHaveBeenCalledWith({
      userId: 'user-1',
      tenantId: 'tenant-1',
      conversationId: reservedThreadId,
    });
  });

  it('rejects trigger continuations and human resumes after binding retention expires', async () => {
    const store = makeStore();
    const expiredChild = {
      ...childConversation(),
      tenantId: 'tenant-1',
      expiredAt: new Date(0),
      agentEventBinding: {
        bindingId: `evtbind_${'c'.repeat(48)}`,
        sourceKeyId: 'source-key',
        actorId: 'player',
      },
    } as unknown as IConversation;
    const getEventBinding = jest.fn(async () => ({
      conversationId: expiredChild.conversationId,
      agentId: expiredChild.agent_id,
      tenantId: 'tenant-1',
      expiredAt: expiredChild.expiredAt,
      binding: expiredChild.agentEventBinding,
      lineage: expiredChild.subagentThread!,
    }));
    const getConvo = jest.fn(async (_user, conversationId) =>
      conversationId === 'parent-conversation'
        ? ({ conversationId, agent_id: 'parent-agent', tenantId: 'tenant-1' } as IConversation)
        : expiredChild,
    );
    const isHumanResumeAllowed = jest.fn(async () => true);
    const testApp = createApp(
      getConvo,
      store,
      getEventBinding as AllMethods['getAgentEventBinding'],
      isHumanResumeAllowed,
    );

    const trigger = await request(testApp)
      .post('/chat')
      .set('x-test-trigger', '1')
      .set('x-lc-agent-event-binding', `evtbind_${'c'.repeat(48)}`)
      .set('x-lc-agent-event-source-key', 'source-key')
      .send({ conversationId: 'child-conversation' });
    const human = await request(testApp)
      .post('/resume')
      .send({ conversationId: 'child-conversation', actionId: 'action-1' });

    expect(trigger.status).toBe(409);
    expect(human.status).toBe(409);
  });

  it('rejects a provisional child before its conversation becomes durable', async () => {
    const store = makeStore();
    jest.spyOn(store, 'isThreadActiveForOwner').mockReturnValue(true);
    const getConvo = jest.fn().mockResolvedValue(null);

    const response = await request(createApp(getConvo, store))
      .post('/chat')
      .send({ conversationId: 'provisional-child' });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: CHILD_THREAD_READ_ONLY_ERROR });
    expect(store.isThreadActiveForOwner).toHaveBeenCalledWith(
      'user-1',
      'provisional-child',
      'tenant-1',
    );
    expect(getConvo).not.toHaveBeenCalled();
  });

  it('rejects a reserved provisional child on a different API worker', async () => {
    const store = makeStore();
    const getConvo = jest.fn().mockResolvedValue(null);
    const reservedThreadId = createSubagentThreadId('scope', 'attempt');

    const response = await request(createApp(getConvo, store))
      .post('/chat')
      .send({ conversationId: reservedThreadId });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: CHILD_THREAD_READ_ONLY_ERROR });
    expect(getConvo).toHaveBeenCalledWith('user-1', reservedThreadId);
  });

  it('keeps the shared policy owner-scoped and treats child lineage as immutable', async () => {
    const store = makeStore();
    const getConvo = jest.fn().mockResolvedValue(childConversation());

    await expect(
      isSubagentThreadWriteBlocked(
        { getConvo, store },
        {
          userId: 'owner',
          conversationId: 'child-conversation',
          tenantId: 'tenant-1',
        },
      ),
    ).resolves.toBe(true);

    expect(getConvo).toHaveBeenCalledWith('owner', 'child-conversation');
  });
});

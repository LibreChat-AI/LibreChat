import type { CodeApprovalMode } from 'librechat-data-provider';
import type { IMessage } from '@librechat/data-schemas';
import type { AgentContinueTriggerEnvelope } from './triggers/envelope';
import type { SubagentTaskWakeupRegistration } from './subagentThreads';
import type { EnqueueAgentTrigger } from './subagentCompletionWakeup';
import {
  createAgentTriggerEnvelope,
  getAgentTriggerIdempotencyKey,
  parseAgentTriggerEnvelope,
} from './triggers/envelope';
import {
  createSubagentCompletionWakeupHandler,
  createSubagentCompletionWakeupResolver,
} from './subagentCompletionWakeup';

const NOW = 1_775_000_000_000;

interface TestMessageFilter {
  conversationId?: string;
  messageId?: { $in: string[] };
  user?: string;
  'subagentTask.parentRunId'?: string;
  'subagentTask.attemptKey'?: string;
  'subagentTask.status'?: string | { $in: string[] };
}

function enqueueMock(): jest.MockedFunction<EnqueueAgentTrigger> {
  return jest.fn<ReturnType<EnqueueAgentTrigger>, Parameters<EnqueueAgentTrigger>>(async () => ({
    id: 'delivery-1',
  }));
}

function registration(
  overrides: Partial<SubagentTaskWakeupRegistration> = {},
): SubagentTaskWakeupRegistration {
  return {
    userId: 'user-1',
    tenantId: 'tenant-1',
    parentConversationId: 'conversation-1',
    parentMessageId: 'response-1',
    parentAgentId: 'agent_parent_1',
    taskId: 'task-1',
    threadId: 'thread-1',
    subagentType: 'researcher',
    createdAt: NOW - 10,
    ...overrides,
  };
}

describe('createSubagentCompletionWakeupHandler', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('pre-registers a bounded continuation on the exact parent branch', async () => {
    const enqueue = enqueueMock();
    const notify = createSubagentCompletionWakeupHandler(enqueue);

    await expect(notify(registration())).resolves.toBe(true);

    expect(enqueue).toHaveBeenCalledTimes(1);
    const [envelopeValue, options] = enqueue.mock.calls[0]!;
    const envelope = parseAgentTriggerEnvelope(envelopeValue);
    expect(envelope).toMatchObject({
      version: 1,
      mode: 'continue',
      principal: { userId: 'user-1', tenantId: 'tenant-1' },
      target: {
        agentId: 'agent_parent_1',
        conversationId: 'conversation-1',
        parentMessageId: 'response-1',
      },
      event: {
        id: 'task-1',
        type: 'subagent.completion',
        source: { id: 'subagent-completion', type: 'internal' },
        payload: {
          taskId: 'task-1',
          threadId: 'thread-1',
          subagentType: 'researcher',
        },
      },
    });
    expect(envelope.input).toContain('waiting to complete');
    expect(options).toEqual({
      orderingKey: 'subagent-completion:conversation-1',
      availableAt: new Date(NOW + 250),
    });
  });

  it('keeps one idempotency identity across duplicate registration callbacks', async () => {
    const enqueue = enqueueMock();
    const notify = createSubagentCompletionWakeupHandler(enqueue);
    const event = registration();

    await notify(event);
    await notify(event);

    const first = parseAgentTriggerEnvelope(enqueue.mock.calls[0]![0]);
    const retry = parseAgentTriggerEnvelope(enqueue.mock.calls[1]![0]);
    expect(first.requestId).not.toBe(retry.requestId);
    expect(first.deliveryId).toBe('task-1');
    expect(getAgentTriggerIdempotencyKey(first)).toBe(getAgentTriggerIdempotencyKey(retry));
    expect(first.input).toContain('waiting to complete');
  });

  it('does not enqueue without a stable initiating agent', async () => {
    const enqueue = enqueueMock();
    const notify = createSubagentCompletionWakeupHandler(enqueue);

    await expect(notify(registration({ parentAgentId: undefined }))).resolves.toBe(false);

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does not enqueue for an ephemeral initiating agent', async () => {
    const enqueue = enqueueMock();
    const notify = createSubagentCompletionWakeupHandler(enqueue);

    await notify(registration({ parentAgentId: 'openAI__gpt-4o___GPT-4o____1' }));

    expect(enqueue).not.toHaveBeenCalled();
  });
});

function wakeupEnvelope(): AgentContinueTriggerEnvelope {
  const envelope = createAgentTriggerEnvelope({
    mode: 'continue',
    requestId: 'request-1',
    deliveryId: 'task-1',
    receivedAt: NOW,
    principal: { id: 'user-1', tenantId: 'tenant-1' },
    event: {
      id: 'task-1',
      type: 'subagent.completion',
      occurredAt: NOW,
      source: { id: 'subagent-completion', type: 'internal' },
      payload: { taskId: 'task-1', threadId: 'thread-1', subagentType: 'researcher' },
    },
    target: {
      agentId: 'agent_parent_1',
      conversationId: 'conversation-1',
      parentMessageId: 'response-1',
    },
    input: 'pending',
  });
  if (envelope.mode !== 'continue') {
    throw new Error('Expected a continue envelope.');
  }
  return envelope;
}

function resolverMethods(codeApprovalMode?: CodeApprovalMode) {
  const subagentTask: IMessage['subagentTask'] = {
    attemptKey: 'attempt-1',
    parentRunId: 'response-1',
    status: 'completed',
  };
  const terminal = {
    messageId: 'task-1:assistant',
    conversationId: 'thread-1',
    parentMessageId: 'task-1:user',
    sender: 'researcher',
    text: 'Child result',
    isCreatedByUser: false,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    subagentTask,
  };
  const methods = {
    getConvo: jest.fn(async (_userId: string, conversationId: string) =>
      conversationId === 'conversation-1'
        ? {
            conversationId,
            tenantId: 'tenant-1',
            ...(codeApprovalMode != null && { codeApprovalMode }),
          }
        : {
            conversationId,
            tenantId: 'tenant-1',
            subagentThread: {
              parentConversationId: 'conversation-1',
              parentMessageId: 'response-1',
              parentAgentId: 'agent_parent_1',
              subagentType: 'researcher',
            },
          },
    ),
    getMessages: jest.fn(async (filter: { conversationId: string }) =>
      filter.conversationId === 'conversation-1'
        ? [
            {
              messageId: 'response-1',
              parentMessageId: 'user-1',
              isCreatedByUser: false,
              createdAt: new Date(NOW - 30),
            },
            {
              messageId: 'wakeup-user',
              parentMessageId: 'response-1',
              isCreatedByUser: true,
              createdAt: new Date(NOW - 20),
            },
            {
              messageId: 'wakeup-response',
              parentMessageId: 'wakeup-user',
              isCreatedByUser: false,
              createdAt: new Date(NOW - 10),
            },
          ]
        : [
            {
              messageId: 'task-1:user',
              conversationId: 'thread-1',
              isCreatedByUser: true,
            },
            terminal,
          ],
    ),
    listActiveSubagentThreadLeases: jest.fn(
      async (): Promise<
        Array<{ conversationId: string; parentConversationId: string; taskId: string }>
      > => [],
    ),
    claimSubagentTaskResult: jest.fn(async () => ({ status: 'acquired', message: terminal })),
    releaseSubagentTaskResultClaim: jest.fn(async () => true),
  };
  return { methods, terminal };
}

function orchestrationSnapshot(
  prepared: Awaited<ReturnType<ReturnType<typeof createSubagentCompletionWakeupResolver>>>,
) {
  if (prepared?.status !== 'ready') {
    throw new Error('Expected a ready continuation.');
  }
  const marker = 'Host-authored bounded orchestration snapshot:\n';
  const start = prepared.input.indexOf(marker);
  if (start < 0) {
    throw new Error('Expected an orchestration snapshot.');
  }
  return {
    rendered: prepared.input.slice(start + marker.length),
    value: JSON.parse(prepared.input.slice(start + marker.length)) as {
      parent_message_id?: string;
      parent_message_id_truncated?: boolean;
      completeness: 'complete' | 'bounded' | 'uncertain';
      known_children: Array<{
        background_task_id: string;
        subagent_thread_id: string;
        subagent_type: string;
        status: string;
        result_state: string;
        current_completion: boolean;
      }>;
      additional_children_may_exist: boolean;
      note: string;
    },
  };
}

describe('createSubagentCompletionWakeupResolver', () => {
  it.each([undefined, 'ask', 'acceptEdits', 'fullAccess'] as const)(
    'inherits parent approval mode %s rather than child or event permissions',
    async (mode) => {
      const { methods } = resolverMethods(mode);
      const resolve = createSubagentCompletionWakeupResolver({
        methods: methods as never,
        getGenerationJob: async () => null,
      });
      const delivery = wakeupEnvelope();
      if (delivery.event.payload == null || typeof delivery.event.payload !== 'object') {
        throw new Error('Expected a completion payload');
      }
      delivery.event.payload = { ...delivery.event.payload, codeApprovalMode: 'fullAccess' };

      const prepared = await resolve(delivery, { idempotencyKey: 'delivery-1' });

      expect(prepared?.status).toBe('ready');
      expect(prepared?.status === 'ready' && prepared.codeApprovalMode).toBe(mode);
    },
  );

  it('defers without claiming while the parent generation is active', async () => {
    const { methods } = resolverMethods();
    const resolve = createSubagentCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => ({ status: 'running' }),
    });

    await expect(
      resolve(wakeupEnvelope(), { idempotencyKey: 'trigger_claim_1' } as never),
    ).rejects.toMatchObject({
      code: 'PARENT_NOT_READY',
      retryable: true,
      deferWithoutAttempt: true,
    });
    expect(methods.claimSubagentTaskResult).not.toHaveBeenCalled();
  });

  it('lets a lost-receipt retry reach HTTP dedup for its own active continuation', async () => {
    const { methods } = resolverMethods();
    const resolve = createSubagentCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => ({
        status: 'requires_action',
        metadata: { idempotencyClientRequestId: 'trigger_claim_1' },
      }),
    });

    await expect(
      resolve(wakeupEnvelope(), { idempotencyKey: 'trigger_claim_1' } as never),
    ).resolves.toMatchObject({ status: 'ready' });
  });

  it('bounds a persisted child result before rendering model input', async () => {
    const { methods, terminal } = resolverMethods();
    terminal.text = 'x'.repeat(200_000);
    const resolve = createSubagentCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });

    const prepared = await resolve(wakeupEnvelope(), {
      idempotencyKey: 'trigger_claim_1',
    } as never);

    expect(prepared).toMatchObject({ status: 'ready' });
    expect(prepared?.status === 'ready' && prepared.input.length).toBeLessThan(110_000);
  });

  it('keeps delayed sibling completions in deterministic host-authored order', async () => {
    const { methods, terminal } = resolverMethods();
    terminal.subagentTask = {
      ...terminal.subagentTask!,
      parentRunId: 'response-1',
      resultClaim: { kind: 'wakeup', claimId: 'trigger_claim_1', claimedAt: new Date(NOW) },
    };
    const delayedSibling = {
      ...terminal,
      messageId: 'task-2:assistant',
      conversationId: 'thread-2',
      sender: 'analyst',
      text: 'private sibling transcript text',
      subagentTranscript: {
        taskId: 'task-2',
        mode: 'replace' as const,
        messagesJson: '[{"role":"assistant","content":"hidden reasoning"}]',
      },
      createdAt: new Date(NOW - 500),
      updatedAt: new Date(NOW - 400),
      subagentTask: {
        attemptKey: 'attempt-2',
        parentRunId: 'response-1',
        status: 'completed' as const,
        resultClaim: {
          kind: 'manual' as const,
          claimId: 'older-poll',
          claimedAt: new Date(NOW - 300),
        },
      },
    };
    methods.getConvo.mockImplementation(async (_userId: string, conversationId: string) => {
      if (conversationId === 'conversation-1') {
        return { conversationId, tenantId: 'tenant-1' };
      }
      return {
        conversationId,
        tenantId: 'tenant-1',
        subagentThread: {
          parentConversationId: 'conversation-1',
          parentMessageId: 'response-1',
          parentAgentId: 'agent_parent_1',
          subagentType: conversationId === 'thread-2' ? 'analyst' : 'researcher',
        },
      };
    });
    methods.getMessages.mockImplementation(async (filter: TestMessageFilter) => {
      if (filter.conversationId === 'conversation-1') {
        return [
          {
            messageId: 'response-1',
            parentMessageId: 'user-1',
            isCreatedByUser: false,
            createdAt: new Date(NOW - 30),
          },
        ];
      }
      if (filter['subagentTask.parentRunId'] === 'response-1') {
        return [terminal, delayedSibling];
      }
      return [
        {
          messageId: 'task-1:user',
          conversationId: 'thread-1',
          isCreatedByUser: true,
        },
        terminal,
      ];
    });
    methods.claimSubagentTaskResult.mockResolvedValueOnce({
      status: 'acquired',
      message: terminal,
    });
    const resolve = createSubagentCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });

    const snapshot = orchestrationSnapshot(
      await resolve(wakeupEnvelope(), { idempotencyKey: 'trigger_claim_1' } as never),
    );

    expect(snapshot.value.known_children).toEqual([
      expect.objectContaining({
        background_task_id: 'task-1',
        status: 'completed',
        result_state: 'claimed',
        current_completion: true,
      }),
      expect.objectContaining({
        background_task_id: 'task-2',
        subagent_type: 'analyst',
        status: 'completed',
        result_state: 'claimed',
        current_completion: false,
      }),
    ]);
    expect(snapshot.rendered).not.toContain('private sibling transcript text');
    expect(snapshot.rendered).not.toContain('hidden reasoning');
  });

  it('bounds sibling count and rendered snapshot bytes', async () => {
    const { methods, terminal } = resolverMethods();
    const long = '界'.repeat(240);
    const siblingMessages = Array.from({ length: 40 }, (_, index) => ({
      ...terminal,
      messageId: `task-${index}-${long}:assistant`,
      conversationId: `thread-${index}-${long}`,
      sender: `agent-${index}-${long}`,
      createdAt: new Date(NOW - index),
      updatedAt: new Date(NOW - index),
      subagentTask: {
        attemptKey: `attempt-${index}`,
        parentRunId: 'response-1',
        status: 'completed' as const,
      },
    }));
    methods.getMessages.mockImplementation(async (filter: TestMessageFilter) => {
      if (filter.conversationId === 'conversation-1') {
        return [
          {
            messageId: 'response-1',
            parentMessageId: 'user-1',
            isCreatedByUser: false,
            createdAt: new Date(NOW - 30),
          },
        ];
      }
      if (filter['subagentTask.parentRunId'] === 'response-1') {
        return siblingMessages.slice(0, 12);
      }
      return [
        {
          messageId: 'task-1:user',
          conversationId: 'thread-1',
          isCreatedByUser: true,
        },
        terminal,
      ];
    });
    methods.getConvo.mockImplementation(async (_userId: string, conversationId: string) => {
      if (conversationId === 'conversation-1') {
        return { conversationId, tenantId: 'tenant-1' };
      }
      const match = /^thread-(\d+)-/.exec(conversationId);
      return {
        conversationId,
        tenantId: 'tenant-1',
        subagentThread: {
          parentConversationId: 'conversation-1',
          parentMessageId: 'response-1',
          parentAgentId: 'agent_parent_1',
          subagentType: match == null ? 'researcher' : `agent-${match[1]}-${long}`,
        },
      };
    });
    const resolve = createSubagentCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });

    const snapshot = orchestrationSnapshot(
      await resolve(wakeupEnvelope(), { idempotencyKey: 'trigger_claim_1' } as never),
    );

    expect(snapshot.value.known_children.length).toBeLessThanOrEqual(16);
    expect(snapshot.value.known_children.length).toBeLessThan(13);
    expect(Buffer.byteLength(snapshot.rendered, 'utf8')).toBeLessThanOrEqual(8 * 1_024);
    expect(snapshot.value.completeness).toBe('bounded');
    expect(snapshot.value.additional_children_may_exist).toBe(true);
  });

  it('bounds an oversized parent identity before rendering the UTF-8 snapshot', async () => {
    const { methods, terminal } = resolverMethods();
    const oversizedParentMessageId = '界'.repeat(10_000);
    terminal.subagentTask = {
      ...terminal.subagentTask!,
      parentRunId: oversizedParentMessageId,
    };
    methods.getMessages.mockImplementation(async (filter: TestMessageFilter) => {
      if (filter.conversationId === 'conversation-1') {
        return [
          {
            messageId: oversizedParentMessageId,
            parentMessageId: 'user-1',
            isCreatedByUser: false,
            createdAt: new Date(NOW - 30),
          },
        ];
      }
      if (filter.conversationId === 'thread-1') {
        return [
          {
            messageId: 'task-1:user',
            conversationId: 'thread-1',
            isCreatedByUser: true,
          },
          terminal,
        ];
      }
      if (filter['subagentTask.parentRunId'] === oversizedParentMessageId) {
        return [terminal];
      }
      return [];
    });
    methods.claimSubagentTaskResult.mockResolvedValueOnce({
      status: 'acquired',
      message: terminal,
    });
    const envelope = wakeupEnvelope();
    envelope.target.parentMessageId = oversizedParentMessageId;
    const resolve = createSubagentCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });

    const snapshot = orchestrationSnapshot(
      await resolve(envelope, { idempotencyKey: 'trigger_claim_1' } as never),
    );

    expect(Buffer.byteLength(snapshot.rendered, 'utf8')).toBeLessThanOrEqual(8 * 1_024);
    expect(snapshot.value.parent_message_id).toBe('界'.repeat(256));
    expect(snapshot.value.parent_message_id_truncated).toBe(true);
    expect(snapshot.value.known_children).toEqual([
      expect.objectContaining({ background_task_id: 'task-1', current_completion: true }),
    ]);
  });

  it('keeps an older actively leased child ahead of newer settled siblings', async () => {
    const { methods, terminal } = resolverMethods();
    const settled = Array.from({ length: 20 }, (_, index) => ({
      ...terminal,
      messageId: `settled-${index}:assistant`,
      conversationId: `thread-settled-${index}`,
      sender: `settled-agent-${index}`,
      createdAt: new Date(NOW - index),
      updatedAt: new Date(NOW - index),
      subagentTask: {
        attemptKey: `settled-attempt-${index}`,
        parentRunId: 'response-1',
        status: 'completed' as const,
      },
    }));
    const running = {
      ...terminal,
      messageId: 'running-task:user',
      conversationId: 'thread-running',
      sender: 'User',
      createdAt: new Date(NOW - 10_000),
      updatedAt: new Date(NOW - 10_000),
      subagentTask: {
        attemptKey: 'running-attempt',
        parentRunId: 'response-1',
        status: 'running' as const,
      },
    };
    methods.listActiveSubagentThreadLeases.mockResolvedValueOnce([
      {
        conversationId: 'thread-running',
        parentConversationId: 'conversation-1',
        taskId: 'running-task',
      },
    ]);
    methods.getMessages.mockImplementation(async (filter: TestMessageFilter) => {
      if (filter.conversationId === 'conversation-1') {
        return [
          {
            messageId: 'response-1',
            parentMessageId: 'user-1',
            isCreatedByUser: false,
            createdAt: new Date(NOW - 30),
          },
        ];
      }
      if (filter.conversationId === 'thread-1') {
        return [
          {
            messageId: 'task-1:user',
            conversationId: 'thread-1',
            isCreatedByUser: true,
          },
          terminal,
        ];
      }
      if (filter.messageId != null) {
        return [running];
      }
      if (filter['subagentTask.parentRunId'] === 'response-1') {
        return [terminal, ...settled];
      }
      return [
        {
          messageId: 'task-1:user',
          conversationId: 'thread-1',
          isCreatedByUser: true,
        },
        terminal,
      ];
    });
    methods.getConvo.mockImplementation(async (_userId: string, conversationId: string) => {
      if (conversationId === 'conversation-1') {
        return { conversationId, tenantId: 'tenant-1' };
      }
      const settledIndex = /^thread-settled-(\d+)$/.exec(conversationId)?.[1];
      let subagentType = 'researcher';
      if (conversationId === 'thread-running') {
        subagentType = 'running-agent';
      } else if (settledIndex != null) {
        subagentType = `settled-agent-${settledIndex}`;
      }
      return {
        conversationId,
        tenantId: 'tenant-1',
        subagentThread: {
          parentConversationId: 'conversation-1',
          parentMessageId: 'response-1',
          parentAgentId: 'agent_parent_1',
          subagentType,
        },
      };
    });
    const resolve = createSubagentCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });

    const snapshot = orchestrationSnapshot(
      await resolve(wakeupEnvelope(), { idempotencyKey: 'trigger_claim_1' } as never),
    );

    expect(snapshot.value.known_children.slice(0, 2)).toEqual([
      expect.objectContaining({ background_task_id: 'task-1', current_completion: true }),
      expect.objectContaining({
        background_task_id: 'running-task',
        status: 'running',
        result_state: 'pending',
      }),
    ]);
  });

  it('preserves uncertainty for a retry lease without a same-task seed or terminal', async () => {
    const { methods, terminal } = resolverMethods();
    methods.listActiveSubagentThreadLeases.mockResolvedValueOnce([
      {
        conversationId: 'thread-2',
        parentConversationId: 'conversation-1',
        taskId: 'retry-task',
      },
    ]);
    methods.getMessages.mockImplementation(async (filter: TestMessageFilter) => {
      if (filter.conversationId === 'conversation-1') {
        return [
          {
            messageId: 'response-1',
            parentMessageId: 'user-1',
            isCreatedByUser: false,
            createdAt: new Date(NOW - 30),
          },
        ];
      }
      if (filter.conversationId === 'thread-1') {
        return [
          {
            messageId: 'task-1:user',
            conversationId: 'thread-1',
            isCreatedByUser: true,
          },
          terminal,
        ];
      }
      if (filter.messageId != null || filter['subagentTask.parentRunId'] === 'response-1') {
        return [];
      }
      return [];
    });
    const resolve = createSubagentCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });

    const snapshot = orchestrationSnapshot(
      await resolve(wakeupEnvelope(), { idempotencyKey: 'trigger_claim_1' } as never),
    );

    expect(snapshot.value.known_children).toEqual([
      expect.objectContaining({ background_task_id: 'task-1', current_completion: true }),
    ]);
    expect(snapshot.value.completeness).toBe('uncertain');
    expect(snapshot.value.additional_children_may_exist).toBe(true);
    expect(snapshot.value.note).toContain('Do not infer that no other children ran');
  });

  it('checks an unmatched retry lease even when ordinary active seeds exceed the task cap', async () => {
    const { methods, terminal } = resolverMethods();
    const activeSeeds = Array.from({ length: 17 }, (_, index) => ({
      messageId: `active-${index}:user`,
      conversationId: `thread-active-${index}`,
      sender: 'User',
      isCreatedByUser: true,
      createdAt: new Date(NOW - index),
      updatedAt: new Date(NOW - index),
      subagentTask: {
        attemptKey: `active-attempt-${index}`,
        parentRunId: 'response-1',
        status: 'running' as const,
      },
    }));
    methods.listActiveSubagentThreadLeases.mockResolvedValueOnce([
      ...activeSeeds.map((message, index) => ({
        conversationId: message.conversationId,
        parentConversationId: 'conversation-1',
        taskId: `active-${index}`,
      })),
      {
        conversationId: 'thread-retry',
        parentConversationId: 'conversation-1',
        taskId: 'retry-task',
      },
    ]);
    methods.getMessages.mockImplementation(async (filter: TestMessageFilter) => {
      if (filter.conversationId === 'conversation-1') {
        return [
          {
            messageId: 'response-1',
            parentMessageId: 'user-1',
            isCreatedByUser: false,
            createdAt: new Date(NOW - 30),
          },
        ];
      }
      if (filter.conversationId === 'thread-1') {
        return [
          {
            messageId: 'task-1:user',
            conversationId: 'thread-1',
            isCreatedByUser: true,
          },
          terminal,
        ];
      }
      if (filter.messageId != null) {
        return activeSeeds;
      }
      if (filter['subagentTask.parentRunId'] === 'response-1') {
        return [terminal];
      }
      return [];
    });
    methods.getConvo.mockImplementation(async (_userId: string, conversationId: string) => ({
      conversationId,
      tenantId: 'tenant-1',
      ...(conversationId === 'conversation-1'
        ? {}
        : {
            subagentThread: {
              parentConversationId: 'conversation-1',
              parentMessageId: 'response-1',
              parentAgentId: 'agent_parent_1',
              subagentType:
                conversationId === 'thread-1'
                  ? 'researcher'
                  : `active-agent-${conversationId.slice('thread-active-'.length)}`,
            },
          }),
    }));
    const resolve = createSubagentCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });

    const snapshot = orchestrationSnapshot(
      await resolve(wakeupEnvelope(), { idempotencyKey: 'trigger_claim_1' } as never),
    );

    expect(snapshot.value.known_children).toHaveLength(16);
    expect(snapshot.value.completeness).toBe('uncertain');
    expect(snapshot.value.additional_children_may_exist).toBe(true);
  });

  it('excludes a captured lease whose durable seed belongs to another parent run', async () => {
    const { methods, terminal } = resolverMethods();
    methods.listActiveSubagentThreadLeases.mockResolvedValueOnce([
      {
        conversationId: 'thread-other-run',
        parentConversationId: 'conversation-1',
        taskId: 'other-task',
      },
    ]);
    methods.getMessages.mockImplementation(async (filter: TestMessageFilter) => {
      if (filter.conversationId === 'conversation-1') {
        return [
          {
            messageId: 'response-1',
            parentMessageId: 'user-1',
            isCreatedByUser: false,
            createdAt: new Date(NOW - 30),
          },
        ];
      }
      if (filter.conversationId === 'thread-1') {
        return [
          {
            messageId: 'task-1:user',
            conversationId: 'thread-1',
            isCreatedByUser: true,
          },
          terminal,
        ];
      }
      if (filter.messageId != null) {
        return [
          {
            messageId: 'other-task:user',
            conversationId: 'thread-other-run',
            sender: 'User',
            isCreatedByUser: true,
            subagentTask: {
              attemptKey: 'other-attempt',
              parentRunId: 'response-other',
              status: 'running' as const,
            },
          },
        ];
      }
      if (filter['subagentTask.parentRunId'] === 'response-1') {
        return [terminal];
      }
      return [];
    });
    const resolve = createSubagentCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });

    const snapshot = orchestrationSnapshot(
      await resolve(wakeupEnvelope(), { idempotencyKey: 'trigger_claim_1' } as never),
    );

    expect(snapshot.value.known_children).toEqual([
      expect.objectContaining({ background_task_id: 'task-1', current_completion: true }),
    ]);
    expect(snapshot.value.completeness).toBe('complete');
    expect(snapshot.value.additional_children_may_exist).toBe(false);
  });

  it('excludes a captured lease whose same-task terminal belongs to another parent run', async () => {
    const { methods, terminal } = resolverMethods();
    methods.listActiveSubagentThreadLeases.mockResolvedValueOnce([
      {
        conversationId: 'thread-other-run',
        parentConversationId: 'conversation-1',
        taskId: 'other-retry',
      },
    ]);
    methods.getMessages.mockImplementation(async (filter: TestMessageFilter) => {
      if (filter.conversationId === 'conversation-1') {
        return [
          {
            messageId: 'response-1',
            parentMessageId: 'user-1',
            isCreatedByUser: false,
            createdAt: new Date(NOW - 30),
          },
        ];
      }
      if (filter.conversationId === 'thread-1') {
        return [
          {
            messageId: 'task-1:user',
            conversationId: 'thread-1',
            isCreatedByUser: true,
          },
          terminal,
        ];
      }
      if (filter.messageId != null) {
        return [
          {
            messageId: 'other-retry:assistant',
            conversationId: 'thread-other-run',
            sender: 'other-agent',
            isCreatedByUser: false,
            subagentTask: {
              attemptKey: 'other-attempt',
              parentRunId: 'response-other',
              status: 'error' as const,
            },
          },
        ];
      }
      if (filter['subagentTask.parentRunId'] === 'response-1') {
        return [terminal];
      }
      return [];
    });
    const resolve = createSubagentCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });

    const snapshot = orchestrationSnapshot(
      await resolve(wakeupEnvelope(), { idempotencyKey: 'trigger_claim_1' } as never),
    );

    expect(snapshot.value.known_children).toEqual([
      expect.objectContaining({ background_task_id: 'task-1', current_completion: true }),
    ]);
    expect(snapshot.value.completeness).toBe('complete');
    expect(snapshot.value.additional_children_may_exist).toBe(false);
  });

  it('retains a same-branch retry terminal seen only by lease evidence', async () => {
    const { methods, terminal } = resolverMethods();
    const retryTerminal = {
      ...terminal,
      messageId: 'retry-task:assistant',
      conversationId: 'thread-retry',
      sender: 'reviewer',
      createdAt: new Date(NOW - 20),
      updatedAt: new Date(NOW - 10),
      subagentTask: {
        attemptKey: 'retry-attempt',
        parentRunId: 'response-1',
        status: 'error' as const,
      },
    };
    methods.listActiveSubagentThreadLeases.mockResolvedValueOnce([
      {
        conversationId: 'thread-retry',
        parentConversationId: 'conversation-1',
        taskId: 'retry-task',
      },
    ]);
    methods.getMessages.mockImplementation(async (filter: TestMessageFilter) => {
      if (filter.conversationId === 'conversation-1') {
        return [
          {
            messageId: 'response-1',
            parentMessageId: 'user-1',
            isCreatedByUser: false,
            createdAt: new Date(NOW - 30),
          },
        ];
      }
      if (filter.conversationId === 'thread-1') {
        return [
          {
            messageId: 'task-1:user',
            conversationId: 'thread-1',
            isCreatedByUser: true,
          },
          terminal,
        ];
      }
      if (filter.messageId != null) {
        return [retryTerminal];
      }
      if (filter['subagentTask.parentRunId'] === 'response-1') {
        return [terminal];
      }
      return [];
    });
    methods.getConvo.mockImplementation(async (_userId: string, conversationId: string) => ({
      conversationId,
      tenantId: 'tenant-1',
      ...(conversationId === 'conversation-1'
        ? {}
        : {
            subagentThread: {
              parentConversationId: 'conversation-1',
              parentMessageId: 'response-1',
              parentAgentId: 'agent_parent_1',
              subagentType: conversationId === 'thread-retry' ? 'reviewer' : 'researcher',
            },
          }),
    }));
    const resolve = createSubagentCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });

    const snapshot = orchestrationSnapshot(
      await resolve(wakeupEnvelope(), { idempotencyKey: 'trigger_claim_1' } as never),
    );

    expect(snapshot.value.known_children).toEqual([
      expect.objectContaining({ background_task_id: 'task-1', current_completion: true }),
      expect.objectContaining({ background_task_id: 'retry-task', status: 'error' }),
    ]);
    expect(snapshot.value.completeness).toBe('complete');
    expect(snapshot.value.additional_children_may_exist).toBe(false);
  });

  it('lets a lease-evidence terminal supersede the same attempt running seed', async () => {
    const { methods, terminal } = resolverMethods();
    const runningSeed = {
      messageId: 'settling-task:user',
      conversationId: 'thread-settling',
      sender: 'User',
      isCreatedByUser: true,
      createdAt: new Date(NOW - 30),
      updatedAt: new Date(NOW - 30),
      subagentTask: {
        attemptKey: 'settling-attempt',
        parentRunId: 'response-1',
        status: 'running' as const,
      },
    };
    const settledTerminal = {
      ...terminal,
      messageId: 'settling-task:assistant',
      conversationId: 'thread-settling',
      sender: 'reviewer',
      createdAt: new Date(NOW - 20),
      updatedAt: new Date(NOW - 10),
      subagentTask: {
        attemptKey: 'settling-attempt',
        parentRunId: 'response-1',
        status: 'completed' as const,
      },
    };
    methods.listActiveSubagentThreadLeases.mockResolvedValueOnce([
      {
        conversationId: 'thread-settling',
        parentConversationId: 'conversation-1',
        taskId: 'settling-task',
      },
    ]);
    methods.getMessages.mockImplementation(async (filter: TestMessageFilter) => {
      if (filter.conversationId === 'conversation-1') {
        return [
          {
            messageId: 'response-1',
            parentMessageId: 'user-1',
            isCreatedByUser: false,
            createdAt: new Date(NOW - 30),
          },
        ];
      }
      if (filter.conversationId === 'thread-1') {
        return [
          {
            messageId: 'task-1:user',
            conversationId: 'thread-1',
            isCreatedByUser: true,
          },
          terminal,
        ];
      }
      if (filter.messageId != null) {
        return [runningSeed, settledTerminal];
      }
      if (filter['subagentTask.parentRunId'] === 'response-1') {
        return [terminal];
      }
      return [];
    });
    methods.getConvo.mockImplementation(async (_userId: string, conversationId: string) => ({
      conversationId,
      tenantId: 'tenant-1',
      ...(conversationId === 'conversation-1'
        ? {}
        : {
            subagentThread: {
              parentConversationId: 'conversation-1',
              parentMessageId: 'response-1',
              parentAgentId: 'agent_parent_1',
              subagentType: conversationId === 'thread-settling' ? 'reviewer' : 'researcher',
            },
          }),
    }));
    const resolve = createSubagentCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });

    const snapshot = orchestrationSnapshot(
      await resolve(wakeupEnvelope(), { idempotencyKey: 'trigger_claim_1' } as never),
    );

    expect(snapshot.value.known_children).toEqual([
      expect.objectContaining({ background_task_id: 'task-1', current_completion: true }),
      expect.objectContaining({
        background_task_id: 'settling-task',
        status: 'completed',
        result_state: 'available',
      }),
    ]);
    expect(snapshot.value.completeness).toBe('complete');
  });

  it('omits sibling task records outside the authorized parent lineage', async () => {
    const { methods, terminal } = resolverMethods();
    const sibling = (taskId: string, threadId: string, sender: string) => ({
      ...terminal,
      messageId: `${taskId}:assistant`,
      conversationId: threadId,
      sender,
      text: `secret-${taskId}`,
      subagentTask: {
        attemptKey: `attempt-${taskId}`,
        parentRunId: 'response-1',
        status: 'completed' as const,
      },
    });
    methods.getMessages.mockImplementation(async (filter: TestMessageFilter) => {
      if (filter.conversationId === 'conversation-1') {
        return [
          {
            messageId: 'response-1',
            parentMessageId: 'user-1',
            isCreatedByUser: false,
            createdAt: new Date(NOW - 30),
          },
        ];
      }
      if (filter['subagentTask.parentRunId'] === 'response-1') {
        expect(filter.user).toBe('user-1');
        return [
          terminal,
          sibling('valid', 'thread-valid', 'valid-agent'),
          sibling('wrong-tenant', 'thread-wrong-tenant', 'tenant-agent'),
          sibling('wrong-parent', 'thread-wrong-parent', 'parent-agent'),
          sibling('wrong-agent', 'thread-wrong-agent', 'agent-agent'),
        ];
      }
      return [
        {
          messageId: 'task-1:user',
          conversationId: 'thread-1',
          isCreatedByUser: true,
        },
        terminal,
      ];
    });
    methods.getConvo.mockImplementation(async (_userId: string, conversationId: string) => {
      if (conversationId === 'conversation-1') {
        return { conversationId, tenantId: 'tenant-1' };
      }
      const variants: Record<
        string,
        {
          tenantId: string;
          parentConversationId: string;
          parentAgentId: string;
          subagentType: string;
        }
      > = {
        'thread-1': {
          tenantId: 'tenant-1',
          parentConversationId: 'conversation-1',
          parentAgentId: 'agent_parent_1',
          subagentType: 'researcher',
        },
        'thread-valid': {
          tenantId: 'tenant-1',
          parentConversationId: 'conversation-1',
          parentAgentId: 'agent_parent_1',
          subagentType: 'valid-agent',
        },
        'thread-wrong-tenant': {
          tenantId: 'tenant-2',
          parentConversationId: 'conversation-1',
          parentAgentId: 'agent_parent_1',
          subagentType: 'tenant-agent',
        },
        'thread-wrong-parent': {
          tenantId: 'tenant-1',
          parentConversationId: 'conversation-2',
          parentAgentId: 'agent_parent_1',
          subagentType: 'parent-agent',
        },
        'thread-wrong-agent': {
          tenantId: 'tenant-1',
          parentConversationId: 'conversation-1',
          parentAgentId: 'agent_parent_2',
          subagentType: 'agent-agent',
        },
      };
      const variant = variants[conversationId];
      return {
        conversationId,
        tenantId: variant.tenantId,
        subagentThread: {
          parentConversationId: variant.parentConversationId,
          parentMessageId: 'response-1',
          parentAgentId: variant.parentAgentId,
          subagentType: variant.subagentType,
        },
      };
    });
    const resolve = createSubagentCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });

    const snapshot = orchestrationSnapshot(
      await resolve(wakeupEnvelope(), { idempotencyKey: 'trigger_claim_1' } as never),
    );

    expect(
      snapshot.value.known_children.map(({ background_task_id }) => background_task_id),
    ).toEqual(['task-1', 'valid']);
    expect(snapshot.value.completeness).toBe('uncertain');
    expect(snapshot.value.additional_children_may_exist).toBe(true);
    expect(snapshot.value.note).toContain('Do not infer that no other children ran');
    expect(snapshot.rendered).not.toContain('wrong-tenant');
    expect(snapshot.rendered).not.toContain('wrong-parent');
    expect(snapshot.rendered).not.toContain('wrong-agent');
    expect(snapshot.rendered).not.toContain('secret-');
  });

  it('states uncertainty when the bounded sibling read is unavailable', async () => {
    const { methods, terminal } = resolverMethods();
    methods.getMessages.mockImplementation(async (filter: TestMessageFilter) => {
      if (filter['subagentTask.parentRunId'] === 'response-1') {
        throw new Error('temporary sibling read failure');
      }
      if (filter.conversationId === 'conversation-1') {
        return [
          {
            messageId: 'response-1',
            parentMessageId: 'user-1',
            isCreatedByUser: false,
            createdAt: new Date(NOW - 30),
          },
        ];
      }
      return [
        {
          messageId: 'task-1:user',
          conversationId: 'thread-1',
          isCreatedByUser: true,
        },
        terminal,
      ];
    });
    const resolve = createSubagentCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });

    const snapshot = orchestrationSnapshot(
      await resolve(wakeupEnvelope(), { idempotencyKey: 'trigger_claim_1' } as never),
    );

    expect(snapshot.value.known_children).toEqual([
      expect.objectContaining({ background_task_id: 'task-1', current_completion: true }),
    ]);
    expect(snapshot.value.completeness).toBe('uncertain');
    expect(snapshot.value.additional_children_may_exist).toBe(true);
    expect(snapshot.value.note).toContain('Do not infer that no other children ran');
  });

  it('backs off by waiting age while the child task is still running', async () => {
    const { methods } = resolverMethods();
    methods.getMessages.mockImplementation(async (filter: { conversationId: string }) =>
      filter.conversationId === 'conversation-1'
        ? [
            {
              messageId: 'response-1',
              parentMessageId: 'user-1',
              isCreatedByUser: false,
              createdAt: new Date(NOW - 30),
            },
          ]
        : [{ messageId: 'task-1:user', conversationId: 'thread-1', isCreatedByUser: true }],
    );
    const resolverAt = (offsetMs: number) =>
      createSubagentCompletionWakeupResolver({
        methods: methods as never,
        getGenerationJob: async () => null,
        now: () => NOW + offsetMs,
      });

    await expect(
      resolverAt(5_000)(wakeupEnvelope(), { idempotencyKey: 'trigger_claim_1' } as never),
    ).rejects.toMatchObject({ code: 'CHILD_NOT_READY', retryAfter: '5' });
    await expect(
      resolverAt(90_000)(wakeupEnvelope(), { idempotencyKey: 'trigger_claim_1' } as never),
    ).rejects.toMatchObject({ code: 'CHILD_NOT_READY', retryAfter: '9' });
    await expect(
      resolverAt(20 * 60_000)(wakeupEnvelope(), { idempotencyKey: 'trigger_claim_1' } as never),
    ).rejects.toMatchObject({ code: 'CHILD_NOT_READY', retryAfter: '60' });
    await expect(
      createSubagentCompletionWakeupResolver({
        methods: methods as never,
        getGenerationJob: async () => null,
        now: () => NOW + 20 * 60_000,
        getWaitMaxIntervalMs: () => 30_000,
      })(wakeupEnvelope(), { idempotencyKey: 'trigger_claim_1' } as never),
    ).rejects.toMatchObject({ code: 'CHILD_NOT_READY', retryAfter: '30' });
  });

  it('backs off by waiting age while the parent generation keeps running', async () => {
    const { methods } = resolverMethods();
    const resolve = createSubagentCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => ({ status: 'running' }),
      now: () => NOW + 150_000,
    });

    await expect(
      resolve(wakeupEnvelope(), { idempotencyKey: 'trigger_claim_1' } as never),
    ).rejects.toMatchObject({ code: 'PARENT_NOT_READY', retryAfter: '15' });
  });

  it('dead-letters a child whose process disappeared after the task timeout grace', async () => {
    const { methods } = resolverMethods();
    methods.getMessages.mockImplementation(async (filter: { conversationId: string }) =>
      filter.conversationId === 'conversation-1'
        ? [
            {
              messageId: 'response-1',
              parentMessageId: 'user-1',
              isCreatedByUser: false,
              createdAt: new Date(NOW - 30),
            },
          ]
        : [
            {
              messageId: 'task-1:user',
              conversationId: 'thread-1',
              isCreatedByUser: true,
            },
          ],
    );
    const fresh = createSubagentCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
      now: () => NOW + 60_000,
    });
    const stale = createSubagentCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
      now: () => NOW + 36 * 60_000,
    });

    await expect(
      fresh(wakeupEnvelope(), { idempotencyKey: 'trigger_claim_1' } as never),
    ).rejects.toMatchObject({
      code: 'CHILD_NOT_READY',
      retryable: true,
      deferWithoutAttempt: true,
    });
    await expect(
      stale(wakeupEnvelope(), { idempotencyKey: 'trigger_claim_1' } as never),
    ).rejects.toMatchObject({ code: 'CHILD_TASK_ABANDONED', retryable: false, status: 410 });
    expect(methods.claimSubagentTaskResult).not.toHaveBeenCalled();
    expect(
      methods.getMessages.mock.calls.filter(
        ([filter]) => filter.conversationId === 'conversation-1',
      ),
    ).toHaveLength(0);
  });

  it('resolves a crash-retry terminal by logical attempt without blocking its ordered lane', async () => {
    const { methods, terminal } = resolverMethods();
    const supersedingTerminal = {
      ...terminal,
      messageId: 'task-2:assistant',
      parentMessageId: 'task-1:user',
    };
    methods.getMessages.mockImplementation(async (filter: TestMessageFilter) => {
      if (filter.conversationId === 'conversation-1') {
        return [
          {
            messageId: 'response-1',
            parentMessageId: 'user-1',
            isCreatedByUser: false,
            createdAt: new Date(NOW - 30),
          },
        ];
      }
      if (filter['subagentTask.attemptKey'] === 'attempt-1') {
        return [supersedingTerminal];
      }
      return [
        {
          messageId: 'task-1:user',
          conversationId: 'thread-1',
          isCreatedByUser: true,
          subagentTask: {
            attemptKey: 'attempt-1',
            parentRunId: 'response-1',
            status: 'running',
          },
        },
      ];
    });
    methods.claimSubagentTaskResult.mockResolvedValueOnce({
      status: 'acquired',
      message: supersedingTerminal,
    });
    const resolve = createSubagentCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });

    const prepared = await resolve(wakeupEnvelope(), {
      idempotencyKey: 'trigger_claim_1',
    } as never);

    expect(prepared).toMatchObject({
      status: 'ready',
      input: expect.stringContaining('"background_task_id":"task-2"'),
    });
    expect(
      orchestrationSnapshot(prepared).value.known_children.map(
        ({ background_task_id }) => background_task_id,
      ),
    ).toEqual(['task-2']);
    expect(methods.claimSubagentTaskResult).toHaveBeenCalledWith({
      userId: 'user-1',
      conversationId: 'thread-1',
      taskId: 'task-2',
      kind: 'wakeup',
      claimId: 'trigger_claim_1',
    });
  });

  it('validates a continued child against its per-task parent instead of original lineage', async () => {
    const { methods } = resolverMethods();
    methods.getConvo.mockImplementation(async (_userId: string, conversationId: string) =>
      conversationId === 'conversation-1'
        ? { conversationId, tenantId: 'tenant-1' }
        : {
            conversationId,
            tenantId: 'tenant-1',
            subagentThread: {
              parentConversationId: 'conversation-1',
              parentMessageId: 'original-response',
              parentAgentId: 'agent_parent_1',
              subagentType: 'researcher',
            },
          },
    );
    const resolve = createSubagentCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });

    await expect(
      resolve(wakeupEnvelope(), { idempotencyKey: 'trigger_claim_1' } as never),
    ).resolves.toMatchObject({ status: 'ready' });
  });

  it('claims the durable result and chains onto the latest assistant descendant', async () => {
    const { methods } = resolverMethods();
    const resolve = createSubagentCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });

    await expect(
      resolve(wakeupEnvelope(), { idempotencyKey: 'trigger_claim_1' } as never),
    ).resolves.toMatchObject({
      status: 'ready',
      parentMessageId: 'wakeup-response',
      input: expect.stringContaining('Child result'),
    });
    expect(methods.claimSubagentTaskResult).toHaveBeenCalledWith({
      userId: 'user-1',
      conversationId: 'thread-1',
      taskId: 'task-1',
      kind: 'wakeup',
      claimId: 'trigger_claim_1',
    });

    const prepared = await resolve(wakeupEnvelope(), {
      idempotencyKey: 'trigger_claim_1',
    } as never);
    expect(prepared?.status).toBe('ready');
    if (prepared?.status === 'ready') {
      await prepared.releaseOnDefiniteFailure?.();
    }
    expect(methods.releaseSubagentTaskResultClaim).toHaveBeenCalledWith({
      userId: 'user-1',
      conversationId: 'thread-1',
      taskId: 'task-1',
      kind: 'wakeup',
      claimId: 'trigger_claim_1',
    });
  });

  it('settles without starting a turn when a manual poll already claimed the result', async () => {
    const { methods, terminal } = resolverMethods();
    methods.claimSubagentTaskResult.mockResolvedValueOnce({
      status: 'claimed',
      message: {
        ...terminal,
        subagentTask: {
          ...terminal.subagentTask,
          resultClaim: { kind: 'manual', claimId: 'poll-1', claimedAt: new Date(NOW) },
        },
      },
    });
    const resolve = createSubagentCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });

    await expect(
      resolve(wakeupEnvelope(), { idempotencyKey: 'trigger_claim_1' } as never),
    ).resolves.toEqual({ status: 'settled' });
  });

  it('releases a cancelled wakeup result for later explicit collection', async () => {
    const { methods, terminal } = resolverMethods();
    terminal.subagentTask = { ...terminal.subagentTask!, status: 'cancelled' };
    methods.claimSubagentTaskResult.mockResolvedValueOnce({
      status: 'acquired',
      message: terminal,
    });
    const resolve = createSubagentCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });

    await expect(
      resolve(wakeupEnvelope(), { idempotencyKey: 'trigger_claim_1' } as never),
    ).resolves.toEqual({ status: 'settled' });
    expect(methods.releaseSubagentTaskResultClaim).toHaveBeenCalledWith({
      userId: 'user-1',
      conversationId: 'thread-1',
      taskId: 'task-1',
      kind: 'wakeup',
      claimId: 'trigger_claim_1',
    });
  });
});

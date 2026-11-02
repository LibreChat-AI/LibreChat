import type { IConversation, IMessage } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';
import {
  createParentSubagentIndexHandler,
  createSubagentThreadViewHandler,
  PARENT_SUBAGENT_INDEX_LIMITS,
  SUBAGENT_THREAD_VIEW_LIMITS,
} from './view';

jest.mock('@librechat/data-schemas', () => ({
  CLIENT_MESSAGE_SELECT: '-_id -user',
  SUBAGENT_TRANSCRIPT_SOURCE_BYTE_LIMIT: 256 * 1024,
  logger: { error: jest.fn() },
}));

const parentConversationId = 'parent-conversation';
const threadId = 'child-thread';

const parent = {
  conversationId: parentConversationId,
  user: 'user-1',
  tenantId: 'tenant-1',
} as IConversation;

const child = {
  conversationId: threadId,
  user: 'user-1',
  tenantId: 'tenant-1',
  title: 'Research child',
  agent_id: 'agent-1',
  updatedAt: new Date('2026-08-21T12:00:00.000Z'),
  subagentThreadLease: {
    token: 'lease-token',
    taskId: 'task-1',
    expiresAt: new Date('2099-08-21T12:00:00.000Z'),
  },
  subagentThread: {
    rootConversationId: parentConversationId,
    parentConversationId,
    parentMessageId: 'parent-message',
    parentToolCallId: 'parent-tool-call',
    subagentType: 'researcher',
    subagentKind: 'agent',
    depth: 1,
  },
} as IConversation;

const message = (
  messageId: string,
  status: NonNullable<IMessage['subagentTask']>['status'],
  isCreatedByUser = false,
): IMessage =>
  ({
    messageId,
    conversationId: threadId,
    user: 'user-1',
    parentMessageId: isCreatedByUser ? '00000000-0000-0000-0000-000000000000' : 'task-1:user',
    sender: isCreatedByUser ? 'User' : 'researcher',
    text: isCreatedByUser ? 'Investigate this.' : 'Finished the research.',
    isCreatedByUser,
    createdAt: new Date(isCreatedByUser ? '2026-08-21T11:00:00.000Z' : '2026-08-21T11:01:00.000Z'),
    subagentTask: {
      attemptKey: 'attempt-1',
      status,
    },
  }) as IMessage;

const createResponse = () => {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  return {
    response: { status } as unknown as Response,
    status,
    json,
  };
};

const createRequest = (
  params: Record<string, string> = {},
  query: Record<string, string> = {},
): ServerRequest =>
  ({
    params: { parentConversationId, threadId, ...params },
    query,
    user: { id: 'user-1', tenantId: 'tenant-1' },
  }) as ServerRequest;

describe('subagent thread parent-scoped view', () => {
  it('preserves every accepted identity and withdrawal target while budgeting Unicode message bodies', async () => {
    const input = message('task-1:user', 'running', true);
    input.subagentTask!.controlReceipts = Array.from({ length: 8 }, (_, index) => ({
      invocationId: `pending-${index}`,
      fingerprint: 'private',
      controlId: `withdraw-${index}`,
      action: 'queue',
      status: 'accepted',
      createdAt: new Date('2026-10-23T00:00:00Z'),
      updatedAt: new Date('2026-10-23T00:00:01Z'),
      message: '界'.repeat(4096),
    }));
    const handler = createSubagentThreadViewHandler({
      getConvoOwnership: jest.fn().mockResolvedValue(parent),
      getSubagentThreadForParent: jest.fn().mockResolvedValue(child),
      getMessagesForSubagentThreadView: jest.fn().mockResolvedValue([input]),
    });
    const { response, json } = createResponse();
    await handler(createRequest({}, { taskId: 'task-1' }), response);
    const body = json.mock.calls[0][0];
    expect(body.controlReceipts.map((receipt: { controlId: string }) => receipt.controlId)).toEqual(
      Array.from({ length: 8 }, (_, index) => `withdraw-${index}`),
    );
    expect(
      body.controlReceipts.some(
        (receipt: { messageTruncated?: boolean }) => receipt.messageTruncated,
      ),
    ).toBe(true);
    expect(body.controlReceiptsTruncated).not.toBe(true);
    expect(Buffer.byteLength(JSON.stringify(body), 'utf8')).toBeLessThanOrEqual(
      SUBAGENT_THREAD_VIEW_LIMITS.responseBytes,
    );
  });

  it('keeps complete stored Unicode control messages and omits whole old receipts to fit the budget', async () => {
    const input = message('task-1:user', 'running', true);
    input.subagentTask!.controlReceipts = Array.from({ length: 32 }, (_, index) => ({
      invocationId: `full-${index}`,
      fingerprint: 'private',
      controlId: `control-${index}`,
      action: 'steer',
      status: 'applied',
      createdAt: new Date('2026-10-23T00:00:00Z'),
      updatedAt: new Date('2026-10-23T00:00:01Z'),
      message: '🧭'.repeat(2048),
    }));
    const handler = createSubagentThreadViewHandler({
      getConvoOwnership: jest.fn().mockResolvedValue(parent),
      getSubagentThreadForParent: jest.fn().mockResolvedValue(child),
      getMessagesForSubagentThreadView: jest
        .fn()
        .mockResolvedValue([message('task-1:assistant', 'completed'), input]),
    });
    const { response, json } = createResponse();
    await handler(createRequest({}, { taskId: 'task-1' }), response);
    const body = json.mock.calls[0][0];
    expect(body.controlReceipts.length).toBeGreaterThan(0);
    expect(body.controlReceipts.length).toBeLessThan(32);
    expect(body.controlReceiptsTruncated).toBe(true);
    expect(body.controlReceipts.at(-1).invocationId).toBe('full-31');
    for (const receipt of body.controlReceipts) {
      expect(receipt.message).toBe('🧭'.repeat(2048));
      expect(receipt.messageTruncated).not.toBe(true);
    }
    expect(Buffer.byteLength(JSON.stringify(body), 'utf8')).toBeLessThanOrEqual(
      SUBAGENT_THREAD_VIEW_LIMITS.responseBytes,
    );
  });

  it.each([
    [false, true, false],
    [true, false, true],
    [undefined, true, true],
    [undefined, false, false],
  ])(
    'uses the seed recovery capability %s over assistant capability %s',
    async (seed, assistant, expected) => {
      const handler = createSubagentThreadViewHandler({
        getConvoOwnership: jest.fn().mockResolvedValue(parent),
        getSubagentThreadForParent: jest.fn().mockResolvedValue(child),
        getMessagesForSubagentThreadView: jest
          .fn()
          .mockResolvedValue([
            { ...message('task-1:assistant', 'completed'), contentRecoveryAvailable: assistant },
            ...(seed == null
              ? []
              : [{ ...message('task-1:user', 'running', true), contentRecoveryAvailable: seed }]),
          ]),
      });
      const { response, json } = createResponse();
      await handler(createRequest({}, { taskId: 'task-1' }), response);
      expect(json.mock.calls[0][0].turns[0].contentRecoveryAvailable).toBe(expected);
    },
  );

  it.each([false, true])(
    'returns task recovery enrollment %s from its loaded seed',
    async (available) => {
      const input = {
        ...message('task-1:user', 'running', true),
        contentRecoveryAvailable: available,
      };
      const getMessages = jest.fn().mockResolvedValue([input]);
      const handler = createSubagentThreadViewHandler({
        getConvoOwnership: jest.fn().mockResolvedValue(parent),
        getSubagentThreadForParent: jest.fn().mockResolvedValue(child),
        getMessagesForSubagentThreadView: getMessages,
      });
      const { response, json } = createResponse();
      await handler(createRequest({}, { taskId: 'task-1' }), response);
      expect(json.mock.calls[0][0].turns).toEqual([
        expect.objectContaining({ taskId: 'task-1', contentRecoveryAvailable: available }),
      ]);
      expect(getMessages).toHaveBeenCalledTimes(1);
    },
  );

  it('returns a bounded public child projection through the owning parent', async () => {
    const getConvoOwnership = jest.fn().mockResolvedValue(parent);
    const newest = {
      ...message('task-1:assistant', 'completed'),
      text: 'a'.repeat(SUBAGENT_THREAD_VIEW_LIMITS.messageTextBytes / 4),
      textProjectionTruncated: true,
    } as IMessage & { textProjectionTruncated: boolean };
    const getMessages = jest
      .fn()
      .mockResolvedValue([newest, message('task-1:user', 'running', true)]);
    const getSubagentThreadForParent = jest.fn().mockResolvedValue(child);
    const handler = createSubagentThreadViewHandler({
      getConvoOwnership,
      getSubagentThreadForParent,
      getMessagesForSubagentThreadView: getMessages,
    });
    const { response, json } = createResponse();

    await handler(createRequest(), response);

    expect(getMessages).toHaveBeenCalledWith({
      conversationId: threadId,
      user: 'user-1',
      tenantId: 'tenant-1',
      limit: SUBAGENT_THREAD_VIEW_LIMITS.messages + 1,
      textCodePointLimit: SUBAGENT_THREAD_VIEW_LIMITS.messageTextBytes / 4,
    });
    expect(getConvoOwnership).toHaveBeenCalledWith('user-1', parentConversationId, 'tenant-1');
    expect(json).toHaveBeenCalledWith({
      threadId,
      parentConversationId,
      parentMessageId: 'parent-message',
      parentToolCallId: 'parent-tool-call',
      subagentType: 'researcher',
      subagentKind: 'agent',
      depth: 1,
      agentId: 'agent-1',
      title: 'Research child',
      status: 'completed',
      activity: [],
      activityTruncated: false,
      controlReceipts: [],
      turns: [
        {
          taskId: 'task-1',
          contentRecoveryAvailable: false,
          trigger: {
            kind: 'parent_dispatch',
            summary: 'Investigate this.',
            createdAt: '2026-08-21T11:00:00.000Z',
          },
          status: 'completed',
          activity: [],
          activityTruncated: false,
          controlReceipts: [],
          messages: [
            expect.objectContaining({
              messageId: 'task-1:assistant',
              role: 'assistant',
              textTruncated: true,
            }),
          ],
        },
      ],
      messages: [
        expect.objectContaining({ messageId: 'task-1:user', role: 'user' }),
        expect.objectContaining({
          messageId: 'task-1:assistant',
          role: 'assistant',
          textTruncated: true,
        }),
      ],
      historyTruncated: false,
      updatedAt: '2026-08-21T12:00:00.000Z',
    });
    expect(Buffer.byteLength(json.mock.calls[0][0].messages[1].text, 'utf8')).toBeLessThanOrEqual(
      SUBAGENT_THREAD_VIEW_LIMITS.messageTextBytes,
    );
    expect(Buffer.byteLength(JSON.stringify(json.mock.calls[0][0]), 'utf8')).toBeLessThanOrEqual(
      SUBAGENT_THREAD_VIEW_LIMITS.responseBytes,
    );
    expect(json.mock.calls[0][0].messages[1]).not.toHaveProperty('subagentTask');
    expect(JSON.stringify(json.mock.calls[0][0])).not.toMatch(
      /subagentTranscript|messagesJson|attemptKey|lease-token/,
    );
  });

  it('returns branch-selected child turns as one chronological conversation', async () => {
    const firstInput = {
      ...message('task-1:user', 'running', true),
      parentMessageId: '00000000-0000-0000-0000-000000000000',
    } as IMessage;
    const firstAssistant = {
      ...message('task-1:assistant', 'completed'),
      parentMessageId: 'task-1:user',
      subagentTranscript: {
        taskId: 'task-1',
        mode: 'append' as const,
        messagesJson: JSON.stringify([{ type: 'ai', data: { content: 'First answer.' } }]),
      },
    } as IMessage;
    const secondInput = {
      ...message('task-2:user', 'running', true),
      parentMessageId: 'task-1:assistant',
      text: 'Continue with the new event.',
      createdAt: new Date('2026-08-21T11:02:00.000Z'),
    } as IMessage;
    const secondAssistant = {
      ...message('task-2:assistant', 'completed'),
      parentMessageId: 'task-2:user',
      createdAt: new Date('2026-08-21T11:03:00.000Z'),
      subagentTranscript: {
        taskId: 'task-2',
        mode: 'append' as const,
        messagesJson: JSON.stringify([{ type: 'ai', data: { content: 'Second answer.' } }]),
      },
    } as IMessage;
    const abandoned = {
      ...message('abandoned:assistant', 'error'),
      parentMessageId: 'task-1:user',
      createdAt: new Date('2026-08-21T11:01:30.000Z'),
    } as IMessage;
    const handler = createSubagentThreadViewHandler({
      getConvoOwnership: jest.fn().mockResolvedValue(parent),
      getSubagentThreadForParent: jest.fn().mockResolvedValue({
        ...child,
        subagentThreadLease: undefined,
      }),
      getMessagesForSubagentThreadView: jest
        .fn()
        .mockResolvedValue([secondAssistant, secondInput, abandoned, firstAssistant, firstInput]),
    });
    const { response, json } = createResponse();

    await handler(createRequest({}, { taskId: 'task-2' }), response);

    const view = json.mock.calls[0][0];
    expect(view.turns).toEqual([
      expect.objectContaining({
        taskId: 'task-1',
        trigger: expect.objectContaining({
          kind: 'parent_dispatch',
          summary: 'Investigate this.',
        }),
        activity: [{ type: 'writing', text: 'First answer.' }],
      }),
      expect.objectContaining({
        taskId: 'task-2',
        trigger: expect.objectContaining({
          kind: 'parent_continuation',
          summary: 'Continue with the new event.',
        }),
        activity: [{ type: 'writing', text: 'Second answer.' }],
      }),
    ]);
    expect(JSON.stringify(view)).not.toContain('abandoned');
    expect(view.historyTruncated).toBe(true);
    expect(view.historyUnavailable).toBe(true);
  });

  it('labels a retained continuation honestly when its task ancestor was truncated', async () => {
    const continuationInput = {
      ...message('task-2:user', 'running', true),
      parentMessageId: 'task-1:assistant',
      text: 'Continue from the missing earlier task.',
    } as IMessage;
    const continuationAssistant = {
      ...message('task-2:assistant', 'completed'),
      parentMessageId: 'task-2:user',
    } as IMessage;
    const handler = createSubagentThreadViewHandler({
      getConvoOwnership: jest.fn().mockResolvedValue(parent),
      getSubagentThreadForParent: jest.fn().mockResolvedValue({
        ...child,
        subagentThreadLease: undefined,
      }),
      getMessagesForSubagentThreadView: jest
        .fn()
        .mockResolvedValue([continuationAssistant, continuationInput]),
    });
    const { response, json } = createResponse();

    await handler(createRequest({}, { taskId: 'task-2' }), response);

    expect(json.mock.calls[0][0].historyTruncated).toBe(true);
    expect(json.mock.calls[0][0].turns[0].trigger.kind).toBe('parent_continuation');
  });

  it("returns only the selected task's sanitized bounded activity", async () => {
    const selected = {
      ...message('task-1:assistant', 'completed'),
      subagentTranscript: {
        taskId: 'task-1',
        mode: 'append' as const,
        messagesJson: JSON.stringify([
          {
            type: 'ai',
            data: {
              content: [{ type: 'reasoning', reasoning: 'private thought' }],
              tool_calls: [{ id: 'inner-1', name: 'search', args: { query: 'release' } }],
              response_metadata: { private: true },
            },
          },
          {
            type: 'tool',
            data: {
              tool_call_id: 'inner-1',
              name: 'search',
              content: 'Found it.',
            },
          },
          { type: 'ai', data: { content: 'Final answer.' } },
        ]),
      },
    } as IMessage;
    const getMessages = jest.fn().mockResolvedValue([selected]);
    const handler = createSubagentThreadViewHandler({
      getConvoOwnership: jest.fn().mockResolvedValue(parent),
      getSubagentThreadForParent: jest
        .fn()
        .mockResolvedValue({ ...child, subagentThreadLease: undefined }),
      getMessagesForSubagentThreadView: getMessages,
    });
    const { response, json } = createResponse();

    await handler(createRequest({}, { taskId: 'task-1' }), response);

    expect(getMessages).toHaveBeenCalledWith(
      expect.not.objectContaining({ taskId: expect.anything() }),
    );
    const view = json.mock.calls[0][0];
    expect(view.activity).toEqual([
      { type: 'reasoning', text: 'private thought' },
      expect.objectContaining({
        type: 'tool',
        toolCallId: 'inner-1',
        status: 'completed',
        output: 'Found it.',
      }),
      { type: 'writing', text: 'Final answer.' },
    ]);
    expect(JSON.stringify(view)).not.toContain('response_metadata');
    expect(view.messages[0]).not.toHaveProperty('subagentTranscript');
  });

  it('selects an exact older task outside the rolling conversation page', async () => {
    const recent = Array.from(
      { length: SUBAGENT_THREAD_VIEW_LIMITS.messages + 1 },
      (_, index) =>
        ({
          ...message(`recent-${index}:assistant`, 'completed'),
          text: '🧵'.repeat(SUBAGENT_THREAD_VIEW_LIMITS.messageTextBytes),
          createdAt: new Date(Date.UTC(2026, 7, 22, 12, index)),
        }) as IMessage,
    );
    const selectedInput = {
      ...message('selected-old:user', 'running', true),
      text: 'Original selected prompt.',
      createdAt: new Date('2026-08-21T10:00:00.000Z'),
    } as IMessage;
    const selected = {
      ...message('selected-old:assistant', 'completed'),
      text: 'Selected result.',
      createdAt: new Date('2026-08-21T10:01:00.000Z'),
      subagentActivityProjectionJson: JSON.stringify([
        { type: 'writing', text: 'Selected durable result.' },
      ]),
    } as IMessage & { subagentActivityProjectionJson: string };
    const handler = createSubagentThreadViewHandler({
      getConvoOwnership: jest.fn().mockResolvedValue(parent),
      getSubagentThreadForParent: jest
        .fn()
        .mockResolvedValue({ ...child, subagentThreadLease: undefined }),
      getMessagesForSubagentThreadView: jest
        .fn()
        .mockResolvedValue([...recent, selected, selectedInput]),
    });
    const { response, json } = createResponse();

    await handler(createRequest({}, { taskId: 'selected-old' }), response);

    const view = json.mock.calls[0][0];
    expect(view.status).toBe('completed');
    expect(view.activity).toEqual([{ type: 'writing', text: 'Selected durable result.' }]);
    expect(view.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          messageId: 'selected-old:assistant',
          text: 'Selected result.',
        }),
      ]),
    );
    expect(view.historyTruncated).toBe(true);
  });

  it('returns bounded authoritative control receipts without private fingerprints', async () => {
    const input = message('task-1:user', 'running', true);
    Object.assign(input.subagentTask!, { controlReceiptsProjectionTruncated: true });
    input.subagentTask!.controlReceipts = [
      {
        invocationId: 'private-reservation',
        fingerprint: 'private-reservation-fingerprint',
        action: 'queue' as const,
        status: 'reserved' as const,
        createdAt: new Date('2026-08-21T09:59:59.000Z'),
        updatedAt: new Date('2026-08-21T09:59:59.000Z'),
      },
      ...Array.from({ length: 31 }, (_, index) => ({
        invocationId: `earlier-${index}`,
        fingerprint: `private-${index}`,
        action: 'queue' as const,
        status: 'applied' as const,
        createdAt: new Date(`2026-08-21T10:00:${String(index).padStart(2, '0')}.000Z`),
        updatedAt: new Date(`2026-08-21T10:00:${String(index).padStart(2, '0')}.000Z`),
      })),
      {
        invocationId: 'invocation-1',
        fingerprint: 'private-fingerprint',
        controlId: 'control-1',
        action: 'steer',
        status: 'applied',
        createdAt: new Date('2026-08-21T11:00:01.000Z'),
        updatedAt: new Date('2026-08-21T11:00:02.000Z'),
        boundary: 'tool',
        message: 'x'.repeat(1_000),
      },
    ];
    const handler = createSubagentThreadViewHandler({
      getConvoOwnership: jest.fn().mockResolvedValue(parent),
      getSubagentThreadForParent: jest.fn().mockResolvedValue(child),
      getMessagesForSubagentThreadView: jest
        .fn()
        .mockResolvedValue([message('task-1:assistant', 'completed'), input]),
    });
    const { response, json } = createResponse();

    await handler(createRequest({}, { taskId: 'task-1' }), response);

    const view = json.mock.calls[0][0];
    expect(view.controlReceipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          invocationId: 'invocation-1',
          controlId: 'control-1',
          action: 'steer',
          status: 'applied',
          boundary: 'tool',
        }),
      ]),
    );
    const projected = view.controlReceipts.find(
      (receipt: { invocationId: string }) => receipt.invocationId === 'invocation-1',
    );
    expect(projected).toBeDefined();
    expect(projected?.message).toBe('x'.repeat(1_000));
    expect(projected?.messageTruncated).not.toBe(true);
    expect(view.controlReceipts).toHaveLength(32);
    expect(view.controlReceiptsTruncated).toBe(true);
    expect(JSON.stringify(view)).not.toContain('private-reservation');
    expect(JSON.stringify(view)).not.toContain('private-fingerprint');
  });

  it.each([
    'truncated input',
    'missing input',
    'mismatched boundary',
    'malformed source',
    'other task',
    'earlier steer only',
  ] as const)(
    'preserves usable legacy activity with %s instead of an unsafe reconstruction',
    async (condition) => {
      const input = message('task-1:user', 'running', true);
      if (condition === 'truncated input')
        Object.assign(input, {
          text: 'Long current task. '.repeat(575).slice(0, 8192),
          textProjectionTruncated: true,
        });
      const activity = [
        { type: 'reasoning', text: 'Retained current reasoning.' },
        { type: 'writing', text: 'Retained current activity.' },
      ];
      const transcript = [
        { type: 'human', data: { content: 'Previous task.' } },
        {
          type: 'human',
          data: {
            content: 'Previous guidance.',
            additional_kwargs: { injected: true, source: 'steer' },
          },
        },
        { type: 'ai', data: { content: 'Private previous activity.' } },
        {
          type: 'human',
          data: { content: condition === 'mismatched boundary' ? 'Other prompt.' : input.text },
        },
        { type: 'ai', data: { content: 'Current reconstructed activity.' } },
      ];
      const selected = {
        ...message('task-1:assistant', 'completed'),
        subagentActivityProjectionJson: JSON.stringify(activity),
        subagentTranscript: {
          taskId: condition === 'other task' ? 'task-other' : 'task-1',
          mode: 'replace' as const,
          messagesJson: condition === 'malformed source' ? 'not-json' : JSON.stringify(transcript),
        },
      };
      const handler = createSubagentThreadViewHandler({
        getConvoOwnership: jest.fn().mockResolvedValue(parent),
        getSubagentThreadForParent: jest
          .fn()
          .mockResolvedValue({ ...child, subagentThreadLease: undefined }),
        getMessagesForSubagentThreadView: jest
          .fn()
          .mockResolvedValue(condition === 'missing input' ? [selected] : [selected, input]),
      });
      const { response, json } = createResponse();
      await handler(createRequest({}, { taskId: 'task-1' }), response);
      expect(json.mock.calls[0][0]).toMatchObject({ activity, activityTruncated: false });
      expect(JSON.stringify(json.mock.calls[0][0])).not.toContain('Private previous activity.');
    },
  );

  it('reprojects legacy activity only when current-task guidance has a safe transcript boundary', async () => {
    const selected = {
      ...message('task-1:assistant', 'completed'),
      subagentActivityProjectionJson: JSON.stringify([
        { type: 'writing', text: 'Old projection without guidance.' },
      ]),
      subagentTranscript: {
        taskId: 'task-1',
        mode: 'replace' as const,
        messagesJson: JSON.stringify([
          { type: 'human', data: { content: 'Previous task.' } },
          { type: 'ai', data: { content: 'Private previous activity.' } },
          { type: 'human', data: { content: 'Investigate this.' } },
          { type: 'ai', data: { content: 'Before guidance.' } },
          {
            type: 'human',
            data: {
              content: 'Current guidance.',
              additional_kwargs: { injected: true, source: 'steer' },
            },
          },
          { type: 'ai', data: { content: 'After guidance.' } },
        ]),
      },
    };
    const handler = createSubagentThreadViewHandler({
      getConvoOwnership: jest.fn().mockResolvedValue(parent),
      getSubagentThreadForParent: jest
        .fn()
        .mockResolvedValue({ ...child, subagentThreadLease: undefined }),
      getMessagesForSubagentThreadView: jest
        .fn()
        .mockResolvedValue([selected, message('task-1:user', 'running', true)]),
    });
    const { response, json } = createResponse();
    await handler(createRequest({}, { taskId: 'task-1' }), response);
    expect(json.mock.calls[0][0].activity).toEqual([
      { type: 'writing', text: 'Before guidance.' },
      { type: 'steer', steer: 'Current guidance.' },
      { type: 'writing', text: 'After guidance.' },
    ]);
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain('Private previous activity.');
  });

  it('fences replacement activity to the exact selected task input', async () => {
    const selected = {
      ...message('task-1:assistant', 'completed'),
      subagentTranscript: {
        taskId: 'task-1',
        mode: 'replace' as const,
        messagesJson: JSON.stringify([
          { type: 'human', data: { content: 'Earlier request.' } },
          { type: 'ai', data: { content: 'Earlier activity.' } },
          { type: 'human', data: { content: 'Investigate this.' } },
          { type: 'ai', data: { content: 'Selected activity.' } },
        ]),
      },
    } as IMessage;
    const handler = createSubagentThreadViewHandler({
      getConvoOwnership: jest.fn().mockResolvedValue(parent),
      getSubagentThreadForParent: jest
        .fn()
        .mockResolvedValue({ ...child, subagentThreadLease: undefined }),
      getMessagesForSubagentThreadView: jest
        .fn()
        .mockResolvedValue([selected, message('task-1:user', 'running', true)]),
    });
    const { response, json } = createResponse();

    await handler(createRequest({}, { taskId: 'task-1' }), response);

    expect(json.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        activity: [{ type: 'writing', text: 'Selected activity.' }],
        activityTruncated: false,
      }),
    );
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain('Earlier activity.');
  });

  it('fails closed when the selected row carries a mismatched transcript identity', async () => {
    const selected = {
      ...message('task-1:assistant', 'completed'),
      subagentTranscript: {
        taskId: 'task-other',
        mode: 'append' as const,
        messagesJson: JSON.stringify([{ type: 'ai', data: { content: 'Wrong task.' } }]),
      },
    } as IMessage;
    const handler = createSubagentThreadViewHandler({
      getConvoOwnership: jest.fn().mockResolvedValue(parent),
      getSubagentThreadForParent: jest
        .fn()
        .mockResolvedValue({ ...child, subagentThreadLease: undefined }),
      getMessagesForSubagentThreadView: jest.fn().mockResolvedValue([selected]),
    });
    const { response, json } = createResponse();

    await handler(createRequest({}, { taskId: 'task-1' }), response);

    expect(json.mock.calls[0][0]).toEqual(
      expect.objectContaining({ activity: [], activityTruncated: true }),
    );
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain('Wrong task.');
  });

  it('falls back to the bounded final message when storage omits an oversized transcript', async () => {
    const selected = {
      ...message('task-1:assistant', 'completed'),
      text: 'The bounded final answer.',
      subagentTranscriptProjectionTruncated: true,
    } as IMessage & { subagentTranscriptProjectionTruncated: boolean };
    const handler = createSubagentThreadViewHandler({
      getConvoOwnership: jest.fn().mockResolvedValue(parent),
      getSubagentThreadForParent: jest
        .fn()
        .mockResolvedValue({ ...child, subagentThreadLease: undefined }),
      getMessagesForSubagentThreadView: jest.fn().mockResolvedValue([selected]),
    });
    const { response, json } = createResponse();

    await handler(createRequest({}, { taskId: 'task-1' }), response);

    const view = json.mock.calls[0][0];
    expect(view).toEqual(
      expect.objectContaining({
        activity: [],
        activityTruncated: true,
        messages: [expect.objectContaining({ text: 'The bounded final answer.' })],
      }),
    );
    expect(JSON.stringify(view)).not.toContain('subagentTranscript');
  });

  it('bounds the complete UTF-8 response while retaining the newest history', async () => {
    const getConvoOwnership = jest.fn().mockResolvedValue(parent);
    const messages = Array.from(
      { length: SUBAGENT_THREAD_VIEW_LIMITS.messages },
      (_, index) =>
        ({
          ...message(`task-${index}:assistant`, 'completed'),
          text: '🧵'.repeat(SUBAGENT_THREAD_VIEW_LIMITS.messageTextBytes),
        }) as IMessage,
    );
    const handler = createSubagentThreadViewHandler({
      getConvoOwnership,
      getSubagentThreadForParent: jest.fn().mockResolvedValue(child),
      getMessagesForSubagentThreadView: jest.fn().mockResolvedValue(messages),
    });
    const { response, json } = createResponse();

    await handler(createRequest(), response);

    const view = json.mock.calls[0][0];
    expect(Buffer.byteLength(JSON.stringify(view), 'utf8')).toBeLessThanOrEqual(
      SUBAGENT_THREAD_VIEW_LIMITS.responseBytes,
    );
    expect(view.historyTruncated).toBe(true);
    expect(view.messages.at(-1).messageId).toBe('task-0:assistant');
  });

  it('preserves the selected assistant while trimming a large chronological response', async () => {
    const chronological = Array.from({ length: 8 }, (_, index) => {
      const input = {
        ...message(`task-${index}:user`, 'running', true),
        parentMessageId:
          index === 0 ? '00000000-0000-0000-0000-000000000000' : `task-${index - 1}:assistant`,
        text: '🧵'.repeat(SUBAGENT_THREAD_VIEW_LIMITS.messageTextBytes),
        createdAt: new Date(Date.UTC(2026, 7, 21, 12, index * 2)),
      } as IMessage;
      const assistant = {
        ...message(`task-${index}:assistant`, 'completed'),
        parentMessageId: `task-${index}:user`,
        text: '🧵'.repeat(SUBAGENT_THREAD_VIEW_LIMITS.messageTextBytes),
        createdAt: new Date(Date.UTC(2026, 7, 21, 12, index * 2 + 1)),
      } as IMessage;
      return [input, assistant];
    }).flat();
    const handler = createSubagentThreadViewHandler({
      getConvoOwnership: jest.fn().mockResolvedValue(parent),
      getSubagentThreadForParent: jest
        .fn()
        .mockResolvedValue({ ...child, subagentThreadLease: undefined }),
      getMessagesForSubagentThreadView: jest.fn().mockResolvedValue([...chronological].reverse()),
    });
    const { response, json } = createResponse();

    await handler(createRequest({}, { taskId: 'task-0' }), response);

    const view = json.mock.calls[0][0];
    expect(view.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ messageId: 'task-0:assistant' })]),
    );
    expect(Buffer.byteLength(JSON.stringify(view), 'utf8')).toBeLessThanOrEqual(
      SUBAGENT_THREAD_VIEW_LIMITS.responseBytes,
    );
    expect(view.historyTruncated).toBe(true);
    const firstRetainedTask = Number(view.turns[0].taskId.replace('task-', ''));
    expect(view.nextCursor).toBe(`task-${firstRetainedTask - 1}:assistant`);
  });

  it('requires tenantless messages when the authenticated request has no tenant', async () => {
    const getMessages = jest.fn().mockResolvedValue([]);
    const handler = createSubagentThreadViewHandler({
      getConvoOwnership: jest.fn().mockResolvedValue({ ...parent, tenantId: undefined }),
      getSubagentThreadForParent: jest
        .fn()
        .mockResolvedValue({ ...child, tenantId: undefined, subagentThreadLease: undefined }),
      getMessagesForSubagentThreadView: getMessages,
    });
    const { response } = createResponse();

    await handler(
      { ...createRequest(), user: { id: 'user-1', tenantId: undefined } } as ServerRequest,
      response,
    );

    expect(getMessages).toHaveBeenCalledWith({
      conversationId: threadId,
      user: 'user-1',
      limit: SUBAGENT_THREAD_VIEW_LIMITS.messages + 1,
      textCodePointLimit: SUBAGENT_THREAD_VIEW_LIMITS.messageTextBytes / 4,
    });
  });

  it.each([
    ['running', 'running'],
    ['error', 'failed'],
    ['cancelled', 'cancelled'],
  ] as const)('normalizes durable %s tasks as %s', async (durableStatus, publicStatus) => {
    const getConvoOwnership = jest.fn().mockResolvedValue(parent);
    const getMessages = jest
      .fn()
      .mockResolvedValue([
        message(
          durableStatus === 'running' ? 'task-1:user' : 'task-1:assistant',
          durableStatus,
          durableStatus === 'running',
        ),
      ]);
    const handler = createSubagentThreadViewHandler({
      getConvoOwnership,
      getSubagentThreadForParent: jest.fn().mockResolvedValue(child),
      getMessagesForSubagentThreadView: getMessages,
    });
    const { response, json } = createResponse();

    await handler(createRequest(), response);

    expect(json.mock.calls[0][0]).toEqual(expect.objectContaining({ status: publicStatus }));
  });

  it('reports a reserved child with no durable task messages as dispatched', async () => {
    const getConvoOwnership = jest.fn().mockResolvedValue(parent);
    const handler = createSubagentThreadViewHandler({
      getConvoOwnership,
      getSubagentThreadForParent: jest
        .fn()
        .mockResolvedValue({ ...child, subagentThreadLease: undefined }),
      getMessagesForSubagentThreadView: jest.fn().mockResolvedValue([]),
    });
    const { response, json } = createResponse();

    await handler(createRequest(), response);

    expect(json.mock.calls[0][0]).toEqual(
      expect.objectContaining({ status: 'dispatched', messages: [] }),
    );
  });

  it('reports a child with an active preparation lease as running before its seed exists', async () => {
    const handler = createSubagentThreadViewHandler({
      getConvoOwnership: jest.fn().mockResolvedValue(parent),
      getSubagentThreadForParent: jest.fn().mockResolvedValue(child),
      getMessagesForSubagentThreadView: jest.fn().mockResolvedValue([]),
    });
    const { response, json } = createResponse();

    await handler(createRequest(), response);

    expect(json.mock.calls[0][0]).toEqual(
      expect.objectContaining({ status: 'running', messages: [] }),
    );
  });

  it('does not mistake an older completed turn for the active leased turn', async () => {
    const activeChild = {
      ...child,
      subagentThreadLease: { ...child.subagentThreadLease!, taskId: 'task-2' },
    } as IConversation;
    const handler = createSubagentThreadViewHandler({
      getConvoOwnership: jest.fn().mockResolvedValue(parent),
      getSubagentThreadForParent: jest.fn().mockResolvedValue(activeChild),
      getMessagesForSubagentThreadView: jest
        .fn()
        .mockResolvedValue([message('task-1:assistant', 'completed')]),
    });
    const { response, json } = createResponse();

    await handler(createRequest(), response);

    expect(json.mock.calls[0][0]).toEqual(expect.objectContaining({ status: 'running' }));
  });

  it('keeps the newest bounded tail and marks older history as truncated', async () => {
    const getConvoOwnership = jest.fn().mockResolvedValue(parent);
    const messages = Array.from(
      { length: SUBAGENT_THREAD_VIEW_LIMITS.messages + 1 },
      (_, index) =>
        ({
          ...message(`task-${index}:assistant`, 'completed'),
          parentMessageId:
            index === SUBAGENT_THREAD_VIEW_LIMITS.messages
              ? '00000000-0000-0000-0000-000000000000'
              : `task-${index + 1}:assistant`,
        }) as IMessage,
    );
    const handler = createSubagentThreadViewHandler({
      getConvoOwnership,
      getSubagentThreadForParent: jest.fn().mockResolvedValue(child),
      getMessagesForSubagentThreadView: jest.fn().mockResolvedValue(messages),
    });
    const { response, json } = createResponse();

    await handler(createRequest(), response);

    const view = json.mock.calls[0][0];
    expect(view.historyTruncated).toBe(true);
    expect(view.messages).toHaveLength(SUBAGENT_THREAD_VIEW_LIMITS.messages);
    expect(view.messages[0].messageId).toBe(
      `task-${SUBAGENT_THREAD_VIEW_LIMITS.messages - 1}:assistant`,
    );
    expect(view.messages.at(-1).messageId).toBe('task-0:assistant');
  });

  it('marks a retained branch whose older task ancestor is unavailable as truncated', async () => {
    const input = {
      ...message('task-2:user', 'running', true),
      parentMessageId: 'task-1:assistant',
    } as IMessage;
    const assistant = {
      ...message('task-2:assistant', 'completed'),
      parentMessageId: 'task-2:user',
    } as IMessage;
    const handler = createSubagentThreadViewHandler({
      getConvoOwnership: jest.fn().mockResolvedValue(parent),
      getSubagentThreadForParent: jest
        .fn()
        .mockResolvedValue({ ...child, subagentThreadLease: undefined }),
      getMessagesForSubagentThreadView: jest.fn().mockResolvedValue([assistant, input]),
    });
    const { response, json } = createResponse();

    await handler(createRequest({}, { taskId: 'task-2' }), response);

    expect(json.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        historyTruncated: true,
        turns: [expect.objectContaining({ taskId: 'task-2' })],
      }),
    );
  });

  it.each([
    ['missing parent', null, child, 'tenant-1'],
    ['missing child', parent, null, 'tenant-1'],
    [
      'unrelated child',
      parent,
      {
        ...child,
        subagentThread: { ...child.subagentThread, parentConversationId: 'another-parent' },
      },
      'tenant-1',
    ],
    ['parent tenant mismatch', { ...parent, tenantId: 'tenant-2' }, child, 'tenant-1'],
    ['child tenant mismatch', parent, { ...child, tenantId: 'tenant-2' }, 'tenant-1'],
  ])('returns the same 404 for %s', async (_, parentRecord, childRecord, tenantId) => {
    const getConvoOwnership = jest.fn().mockResolvedValue(parentRecord);
    const getMessages = jest.fn().mockResolvedValue([message('task-1:assistant', 'completed')]);
    const handler = createSubagentThreadViewHandler({
      getConvoOwnership,
      getSubagentThreadForParent: jest.fn().mockResolvedValue(childRecord),
      getMessagesForSubagentThreadView: getMessages,
    });
    const { response, status, json } = createResponse();

    await handler(
      {
        ...createRequest(),
        user: { id: 'user-1', tenantId },
      } as ServerRequest,
      response,
    );

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ error: 'Conversation not found' });
    expect(getMessages).not.toHaveBeenCalled();
  });

  it('rejects a child id used as its own parent before reading storage', async () => {
    const getConvoOwnership = jest.fn();
    const getSubagentThreadForParent = jest.fn();
    const getMessages = jest.fn();
    const handler = createSubagentThreadViewHandler({
      getConvoOwnership,
      getSubagentThreadForParent,
      getMessagesForSubagentThreadView: getMessages,
    });
    const { response, status } = createResponse();

    await handler(createRequest({ parentConversationId: threadId }), response);

    expect(status).toHaveBeenCalledWith(404);
    expect(getConvoOwnership).not.toHaveBeenCalled();
    expect(getSubagentThreadForParent).not.toHaveBeenCalled();
    expect(getMessages).not.toHaveBeenCalled();
  });

  it('rejects oversized route identifiers before reading storage', async () => {
    const getConvoOwnership = jest.fn();
    const getSubagentThreadForParent = jest.fn();
    const getMessages = jest.fn();
    const handler = createSubagentThreadViewHandler({
      getConvoOwnership,
      getSubagentThreadForParent,
      getMessagesForSubagentThreadView: getMessages,
    });
    const { response, status } = createResponse();

    await handler(createRequest({ threadId: 'x'.repeat(257) }), response);

    expect(status).toHaveBeenCalledWith(404);
    expect(getConvoOwnership).not.toHaveBeenCalled();
    expect(getSubagentThreadForParent).not.toHaveBeenCalled();
    expect(getMessages).not.toHaveBeenCalled();
  });

  it('rejects an oversized task selector before reading storage', async () => {
    const getConvoOwnership = jest.fn();
    const getSubagentThreadForParent = jest.fn();
    const getMessages = jest.fn();
    const handler = createSubagentThreadViewHandler({
      getConvoOwnership,
      getSubagentThreadForParent,
      getMessagesForSubagentThreadView: getMessages,
    });
    const { response, status } = createResponse();

    await handler(createRequest({}, { taskId: 'x'.repeat(513) }), response);

    expect(status).toHaveBeenCalledWith(404);
    expect(getConvoOwnership).not.toHaveBeenCalled();
    expect(getSubagentThreadForParent).not.toHaveBeenCalled();
    expect(getMessages).not.toHaveBeenCalled();
  });

  it('marks an unleased running seed as interrupted', async () => {
    const getConvoOwnership = jest.fn().mockResolvedValue(parent);
    const handler = createSubagentThreadViewHandler({
      getConvoOwnership,
      getSubagentThreadForParent: jest
        .fn()
        .mockResolvedValue({ ...child, subagentThreadLease: undefined }),
      getMessagesForSubagentThreadView: jest
        .fn()
        .mockResolvedValue([message('task-1:user', 'running', true)]),
    });
    const { response, json } = createResponse();

    await handler(createRequest(), response);

    expect(json.mock.calls[0][0]).toEqual(expect.objectContaining({ status: 'interrupted' }));
  });
});

describe('parent child-thread index', () => {
  const eventChild = {
    ...child,
    conversationId: 'event-thread',
    title: 'Agent actor: analyst-a',
    actorId: 'analyst-a',
    subagentThread: {
      ...child.subagentThread!,
      parentToolCallId: 'event-binding:private-binding-id',
    },
  };

  it('returns one bounded actor projection and batches task discovery', async () => {
    const listSubagentThreadsForParent = jest.fn().mockResolvedValue([eventChild]);
    const listSubagentTasksForThreads = jest.fn().mockResolvedValue([
      {
        conversationId: 'event-thread',
        tasks: [
          {
            messageId: 'task-1:assistant',
            status: 'completed',
            createdAt: new Date('2026-08-21T11:01:00.000Z'),
          },
        ],
      },
    ]);
    const handler = createParentSubagentIndexHandler({
      getConvoOwnership: jest.fn().mockResolvedValue(parent),
      listSubagentThreadsForParent,
      listSubagentTasksForThreads,
    });
    const { response, json } = createResponse();

    await handler(createRequest(), response);

    expect(listSubagentThreadsForParent).toHaveBeenCalledWith({
      user: 'user-1',
      parentConversationId,
      tenantId: 'tenant-1',
      limit: PARENT_SUBAGENT_INDEX_LIMITS.children + 1,
    });
    expect(listSubagentTasksForThreads).toHaveBeenCalledTimes(1);
    expect(listSubagentTasksForThreads).toHaveBeenCalledWith({
      user: 'user-1',
      conversationIds: ['event-thread'],
      tenantId: 'tenant-1',
      limitPerThread: PARENT_SUBAGENT_INDEX_LIMITS.tasksPerChild + 1,
    });
    expect(json).toHaveBeenCalledWith({
      parentConversationId,
      childrenTruncated: false,
      children: [
        expect.objectContaining({
          threadId: 'event-thread',
          origin: 'event',
          actorId: 'analyst-a',
          status: 'completed',
          latestTaskId: 'task-1',
          tasks: [expect.objectContaining({ taskId: 'task-1', status: 'completed' })],
        }),
      ],
    });
    const publicJson = JSON.stringify(json.mock.calls[0][0]);
    expect(publicJson).not.toContain('private-binding-id');
    expect(publicJson).not.toContain('subagentThreadLease');
    expect(publicJson).not.toContain('sourceKeyId');
  });

  it('propagates a filled shared task window as truncated child history', async () => {
    const handler = createParentSubagentIndexHandler({
      getConvoOwnership: jest.fn().mockResolvedValue(parent),
      listSubagentThreadsForParent: jest.fn().mockResolvedValue([eventChild]),
      listSubagentTasksForThreads: jest.fn().mockResolvedValue([
        {
          conversationId: 'event-thread',
          sourceTruncated: true,
          tasks: [
            {
              messageId: 'task-1:assistant',
              status: 'completed',
              createdAt: new Date('2026-08-21T11:01:00.000Z'),
            },
          ],
        },
      ]),
    });
    const { response, json } = createResponse();

    await handler(createRequest(), response);

    expect(json.mock.calls[0][0].children[0]).toEqual(
      expect.objectContaining({ tasksTruncated: true }),
    );
  });

  it('keeps a derived partial event snapshot running while its exact lease is active', async () => {
    const handler = createParentSubagentIndexHandler({
      getConvoOwnership: jest.fn().mockResolvedValue(parent),
      listSubagentThreadsForParent: jest.fn().mockResolvedValue([
        {
          ...eventChild,
          subagentThreadLease: {
            token: 'lease-token',
            taskId: 'delivery-active',
            expiresAt: new Date('2099-08-21T12:00:00.000Z'),
          },
        },
      ]),
      listSubagentTasksForThreads: jest.fn().mockResolvedValue([
        {
          conversationId: 'event-thread',
          tasks: [
            {
              messageId: 'delivery-active:assistant',
              status: 'cancelled',
              statusDerived: true,
              createdAt: new Date('2026-08-21T11:01:00.000Z'),
            },
          ],
        },
      ]),
    });
    const { response, json } = createResponse();

    await handler(createRequest(), response);

    expect(json.mock.calls[0][0].children[0]).toEqual(
      expect.objectContaining({ status: 'running', latestTaskId: 'delivery-active' }),
    );
  });

  it('promotes a resumed leased task ahead of a newer completed turn', async () => {
    const handler = createParentSubagentIndexHandler({
      getConvoOwnership: jest.fn().mockResolvedValue(parent),
      listSubagentThreadsForParent: jest.fn().mockResolvedValue([
        {
          ...eventChild,
          subagentThreadLease: {
            token: 'lease-token',
            taskId: 'delivery-resumed',
            expiresAt: new Date('2099-08-21T12:00:00.000Z'),
          },
        },
      ]),
      listSubagentTasksForThreads: jest.fn().mockResolvedValue([
        {
          conversationId: 'event-thread',
          tasks: [
            {
              messageId: 'delivery-newer:assistant',
              status: 'completed',
              createdAt: new Date('2026-08-21T11:02:00.000Z'),
            },
            {
              messageId: 'delivery-resumed:assistant',
              status: 'cancelled',
              statusDerived: true,
              createdAt: new Date('2026-08-21T11:01:00.000Z'),
            },
          ],
        },
      ]),
    });
    const { response, json } = createResponse();

    await handler(createRequest(), response);

    expect(json.mock.calls[0][0].children[0]).toEqual(
      expect.objectContaining({ status: 'running', latestTaskId: 'delivery-resumed' }),
    );
  });

  it('redacts event delivery identity from the detailed child view', async () => {
    const handler = createSubagentThreadViewHandler({
      getConvoOwnership: jest.fn().mockResolvedValue(parent),
      getSubagentThreadForParent: jest.fn().mockResolvedValue(eventChild),
      getMessagesForSubagentThreadView: jest.fn().mockResolvedValue([]),
    });
    const { response, json } = createResponse();

    await handler(createRequest({ threadId: 'event-thread' }), response);

    expect(json.mock.calls[0][0].parentToolCallId).toBe('event-thread:event-thread');
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain('private-binding-id');
  });

  it('derives a completed event task from its ordinary persisted assistant row', async () => {
    const getMessagesForSubagentThreadView = jest.fn().mockResolvedValue([
      {
        messageId: 'delivery-1:assistant',
        parentMessageId: 'delivery-1:user',
        isCreatedByUser: false,
        text: 'Event result',
        createdAt: new Date('2026-08-21T11:01:00.000Z'),
        subagentActivity: [
          {
            type: 'tool',
            toolCallId: 'move-1',
            name: 'submit_move',
            input: '{"uci":"e2e4"}',
            output: '{"accepted":true}',
            progress: 1,
          },
          { type: 'writing', text: 'Move submitted.' },
        ],
      },
      {
        messageId: 'delivery-1:user',
        parentMessageId: null,
        isCreatedByUser: true,
        text: 'Safe instruction. {"privateRoutingKey":"must-not-leak"}',
        textProjectionTruncated: true,
        createdAt: new Date('2026-08-21T11:00:00.000Z'),
        subagentTriggerProjection: {
          version: 1,
          eventType: 'chess.turn.ready',
          sourceType: 'speed-chess',
          occurredAt: new Date('2026-08-21T10:59:00.000Z'),
          expectedActionToolName: 'submit_move',
        },
      },
    ]);
    const handler = createSubagentThreadViewHandler({
      getConvoOwnership: jest.fn().mockResolvedValue(parent),
      getSubagentThreadForParent: jest.fn().mockResolvedValue(eventChild),
      getMessagesForSubagentThreadView,
    });
    const { response, json } = createResponse();

    await handler(createRequest({ threadId: 'event-thread' }, { taskId: 'delivery-1' }), response);

    expect(json.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        status: 'completed',
        turns: [
          expect.objectContaining({
            taskId: 'delivery-1',
            trigger: expect.objectContaining({
              kind: 'external_event',
              summary: '',
              externalEvent: {
                eventType: 'chess.turn.ready',
                sourceType: 'speed-chess',
                occurredAt: '2026-08-21T10:59:00.000Z',
                expectedActionToolName: 'submit_move',
              },
            }),
            activity: [
              expect.objectContaining({
                type: 'tool',
                toolCallId: 'move-1',
                status: 'completed',
              }),
              { type: 'writing', text: 'Move submitted.' },
            ],
          }),
        ],
      }),
    );
    expect(json.mock.calls[0][0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ messageId: 'delivery-1:user', text: '' }),
        expect.objectContaining({ messageId: 'delivery-1:assistant', text: 'Event result' }),
      ]),
    );
    expect(json.mock.calls[0][0].turns[0].trigger).not.toHaveProperty('summaryTruncated');
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain('privateRoutingKey');
    expect(getMessagesForSubagentThreadView).toHaveBeenCalledWith(
      expect.not.objectContaining({ taskId: expect.anything() }),
    );
  });

  it('anchors an older page through an exact scoped task-message cursor', async () => {
    const olderInput = {
      ...message('older:user', 'running', true),
      parentMessageId: null,
    } as IMessage;
    const olderAssistant = {
      ...message('older:assistant', 'completed'),
      parentMessageId: 'older:user',
    } as IMessage;
    const getMessagesForSubagentThreadView = jest
      .fn()
      .mockResolvedValue([olderAssistant, olderInput]);
    const handler = createSubagentThreadViewHandler({
      getConvoOwnership: jest.fn().mockResolvedValue(parent),
      getSubagentThreadForParent: jest.fn().mockResolvedValue(child),
      getMessagesForSubagentThreadView,
    });
    const { response, json } = createResponse();

    await handler(createRequest({}, { cursor: 'newer:user' }), response);

    expect(getMessagesForSubagentThreadView).toHaveBeenCalledWith(
      expect.objectContaining({ beforeMessageId: 'newer:user' }),
    );
    expect(json.mock.calls[0][0].turns).toEqual([expect.objectContaining({ taskId: 'older' })]);
  });

  it('marks a vanished inclusive history cursor as unavailable', async () => {
    const getMessagesForSubagentThreadView = jest.fn().mockResolvedValue([]);
    const handler = createSubagentThreadViewHandler({
      getConvoOwnership: jest.fn().mockResolvedValue(parent),
      getSubagentThreadForParent: jest.fn().mockResolvedValue(child),
      getMessagesForSubagentThreadView,
    });
    const { response, json } = createResponse();

    await handler(createRequest({}, { cursor: 'vanished:assistant' }), response);

    expect(getMessagesForSubagentThreadView).toHaveBeenCalledWith(
      expect.objectContaining({ beforeMessageId: 'vanished:assistant' }),
    );
    expect(json.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        historyTruncated: true,
        historyUnavailable: true,
      }),
    );
    expect(json.mock.calls[0][0]).not.toHaveProperty('nextCursor');
  });

  it('rejects malformed or combined history cursors before storage access', async () => {
    const getMessagesForSubagentThreadView = jest.fn();
    const handler = createSubagentThreadViewHandler({
      getConvoOwnership: jest.fn(),
      getSubagentThreadForParent: jest.fn(),
      getMessagesForSubagentThreadView,
    });
    const malformed = createResponse();
    const combined = createResponse();

    await handler(createRequest({}, { cursor: 'private-routing-id' }), malformed.response);
    await handler(
      createRequest({}, { cursor: 'older:user', taskId: 'selected-task' }),
      combined.response,
    );

    expect(malformed.status).toHaveBeenCalledWith(404);
    expect(combined.status).toHaveBeenCalledWith(404);
    expect(getMessagesForSubagentThreadView).not.toHaveBeenCalled();
  });

  it('projects ordinary and event children together without exposing event delivery identity', async () => {
    const handler = createParentSubagentIndexHandler({
      getConvoOwnership: jest.fn().mockResolvedValue(parent),
      listSubagentThreadsForParent: jest.fn().mockResolvedValue([eventChild, child]),
      listSubagentTasksForThreads: jest.fn().mockResolvedValue([]),
    });
    const { response, json } = createResponse();

    await handler(createRequest(), response);

    expect(json.mock.calls[0][0].children).toEqual([
      expect.objectContaining({ threadId: 'event-thread', origin: 'event', actorId: 'analyst-a' }),
      expect.objectContaining({
        threadId,
        origin: 'tool',
        parentToolCallId: 'parent-tool-call',
      }),
    ]);
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain('private-binding-id');
  });

  it('bounds child and per-child task discovery while retaining newest tasks', async () => {
    const children = Array.from(
      { length: PARENT_SUBAGENT_INDEX_LIMITS.children + 1 },
      (_, index) => ({
        ...eventChild,
        conversationId: `event-thread-${String(index).padStart(2, '0')}`,
        actorId: `actor-${String(index).padStart(2, '0')}`,
        subagentThreadLease: undefined,
      }),
    );
    const tasks = Array.from(
      { length: PARENT_SUBAGENT_INDEX_LIMITS.tasksPerChild + 1 },
      (_, index) => ({
        messageId: `task-${String(index).padStart(2, '0')}:assistant`,
        status: 'completed' as const,
        createdAt: new Date(Date.UTC(2026, 7, 21, 12, index)),
      }),
    ).reverse();
    const listSubagentTasksForThreads = jest
      .fn()
      .mockResolvedValue([{ conversationId: children[0].conversationId, tasks }]);
    const handler = createParentSubagentIndexHandler({
      getConvoOwnership: jest.fn().mockResolvedValue(parent),
      listSubagentThreadsForParent: jest.fn().mockResolvedValue(children),
      listSubagentTasksForThreads,
    });
    const { response, json } = createResponse();

    await handler(createRequest(), response);

    const projection = json.mock.calls[0][0];
    expect(projection.children).toHaveLength(PARENT_SUBAGENT_INDEX_LIMITS.children);
    expect(projection.childrenTruncated).toBe(true);
    expect(projection.children[0].tasks).toHaveLength(PARENT_SUBAGENT_INDEX_LIMITS.tasksPerChild);
    expect(projection.children[0].tasksTruncated).toBe(true);
    expect(projection.children[0].latestTaskId).toBe('task-20');
    expect(listSubagentTasksForThreads.mock.calls[0][0].conversationIds).toHaveLength(
      PARENT_SUBAGENT_INDEX_LIMITS.children,
    );
  });

  it('fails closed for a child parent and does not read task history', async () => {
    const listSubagentTasksForThreads = jest.fn();
    const handler = createParentSubagentIndexHandler({
      getConvoOwnership: jest.fn().mockResolvedValue({
        ...parent,
        subagentThread: child.subagentThread,
      }),
      listSubagentThreadsForParent: jest.fn().mockResolvedValue([]),
      listSubagentTasksForThreads,
    });
    const { response, status, json } = createResponse();

    await handler(createRequest(), response);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ error: 'Conversation not found' });
    expect(listSubagentTasksForThreads).not.toHaveBeenCalled();
  });

  it('drops a mismatched child lineage before the batched task read', async () => {
    const listSubagentTasksForThreads = jest.fn().mockResolvedValue([]);
    const handler = createParentSubagentIndexHandler({
      getConvoOwnership: jest.fn().mockResolvedValue(parent),
      listSubagentThreadsForParent: jest.fn().mockResolvedValue([
        {
          ...eventChild,
          subagentThread: {
            ...eventChild.subagentThread,
            parentConversationId: 'different-parent',
          },
        },
      ]),
      listSubagentTasksForThreads,
    });
    const { response, json } = createResponse();

    await handler(createRequest(), response);

    expect(listSubagentTasksForThreads).toHaveBeenCalledWith(
      expect.objectContaining({ conversationIds: [] }),
    );
    expect(json.mock.calls[0][0].children).toEqual([]);
  });
});

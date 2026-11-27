import type { ThreadSyncDeps, ThreadSyncClient, ThreadMessage } from './threads';
import { syncMessages, processMessages } from './threads';

/** Lets every pending promise callback run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function userMessage(): ThreadMessage {
  return {
    id: 'msg_user',
    role: 'user',
    created_at: 1,
    content: [{ type: 'text', text: { value: 'hi', annotations: [] } }],
    metadata: {},
  };
}

describe('syncMessages', () => {
  it('waits for the saves it started before rejecting with a failed thread update', async () => {
    /* On a stopped run the caller settles once this rejects; a save still in flight then lands
       after account deletion and recreates the message for the deleted owner. */
    let finishSave!: (value: unknown) => void;
    const updateError = new Error('messages.update failed');
    const deps = {
      saveMessage: jest.fn(() => new Promise((resolve) => (finishSave = resolve))),
      saveConvo: jest.fn().mockResolvedValue({}),
      stampConvoLastResponse: jest.fn().mockResolvedValue(null),
      addThreadMetadata: jest.fn().mockResolvedValue(undefined),
    } as unknown as ThreadSyncDeps;
    const openai: ThreadSyncClient = {
      req: { user: { id: 'user-123' }, body: {} },
      beta: { threads: { messages: { update: jest.fn().mockRejectedValue(updateError) } } },
    };

    let settled = false;
    const sync = syncMessages(deps, {
      openai,
      endpoint: 'assistants',
      thread_id: 'thread_1',
      dbMessages: [],
      apiMessages: [userMessage()],
      conversationId: 'convo-123',
    }).finally(() => (settled = true));
    sync.catch(() => undefined);

    await flush();
    expect(openai.beta.threads.messages.update).toHaveBeenCalled();
    expect(deps.saveMessage).toHaveBeenCalled();
    expect(settled).toBe(false);

    finishSave({ messageId: 'saved' });
    await expect(sync).rejects.toBe(updateError);
    expect(deps.saveConvo).not.toHaveBeenCalled();
  });

  it('saves missing messages, tags them on the thread and stamps the recovered reply', async () => {
    const saveMessage = jest.fn(async (_ctx: unknown, message: Record<string, unknown>) => ({
      ...message,
    }));
    const deps = {
      saveMessage,
      saveConvo: jest.fn().mockResolvedValue({ conversationId: 'convo-123' }),
      stampConvoLastResponse: jest.fn().mockResolvedValue(null),
      addThreadMetadata: jest.fn().mockResolvedValue(undefined),
    } as unknown as ThreadSyncDeps;
    const update = jest.fn().mockResolvedValue({});
    const openai: ThreadSyncClient = {
      req: { user: { id: 'user-123' }, body: {} },
      beta: { threads: { messages: { update } } },
    };
    const reply: ThreadMessage = {
      id: 'msg_reply',
      role: 'assistant',
      created_at: 2,
      content: [{ type: 'text', text: { value: 'hello', annotations: [] } }],
      assistant_id: 'asst_1',
    };

    const result = await syncMessages(deps, {
      openai,
      endpoint: 'assistants',
      thread_id: 'thread_1',
      dbMessages: [],
      apiMessages: [userMessage(), reply],
      conversationId: 'convo-123',
    });

    expect(result).toHaveLength(2);
    expect(result[1].parentMessageId).toBe(result[0].messageId);
    expect(saveMessage).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledWith('msg_reply', {
      thread_id: 'thread_1',
      metadata: { messageId: result[1].messageId },
    });
    expect(deps.stampConvoLastResponse).toHaveBeenCalledWith(
      'user-123',
      'convo-123',
      result[1].messageId,
    );
    expect(openai.req.resolvedConversation).toEqual({ conversationId: 'convo-123' });
  });
});

describe('processMessages', () => {
  it('waits for a file retrieval it started before a later message throws', async () => {
    /* The retrieval stores the file and creates its record, so it must not outlive the call. */
    let finishRetrieval!: (value: unknown) => void;
    const retrieveAndProcessFile = jest.fn(
      () => new Promise((resolve) => (finishRetrieval = resolve)),
    );
    const client = { processedFileIds: new Set<string>() };
    const messages = [
      {
        id: 'msg_1',
        role: 'assistant',
        created_at: 1,
        content: [{ type: 'image_file', image_file: { file_id: 'file-img' } }],
      },
      { id: 'msg_2', role: 'assistant', created_at: 2, content: null },
    ] as unknown as ThreadMessage[];

    let settled = false;
    const processed = processMessages({ retrieveAndProcessFile } as never, {
      openai: {},
      client,
      messages,
    }).finally(() => (settled = true));
    processed.catch(() => undefined);

    await flush();
    expect(retrieveAndProcessFile).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    finishRetrieval({ file_id: 'file-img', filepath: '/images/file-img.png' });
    await expect(processed).rejects.toThrow(TypeError);
    expect(client.processedFileIds.has('file-img')).toBe(true);
  });
});

describe('syncMessages aggregation', () => {
  it('appends an unrecorded assistant message to a database reply without an aggregation list', async () => {
    const saveMessage = jest.fn(async (_ctx: unknown, message: Record<string, unknown>) => message);
    const deps = {
      saveMessage,
      saveConvo: jest.fn().mockResolvedValue(null),
      stampConvoLastResponse: jest.fn().mockResolvedValue(null),
      addThreadMetadata: jest.fn().mockResolvedValue(undefined),
    } as unknown as ThreadSyncDeps;
    const update = jest.fn().mockResolvedValue({});
    const openai: ThreadSyncClient = {
      req: { user: { id: 'user-123' } },
      beta: { threads: { messages: { update } } },
    };
    const text = (value: string) => [{ type: 'text', text: { value, annotations: [] } }];

    const result = await syncMessages(deps, {
      openai,
      endpoint: 'assistants',
      thread_id: 'thread_1',
      dbMessages: [{ messageId: 'db-reply', role: 'assistant', content: text('first') }],
      apiMessages: [
        {
          id: 'msg_a',
          role: 'assistant',
          created_at: 1,
          content: text('first'),
          metadata: { messageId: 'db-reply' },
        },
        { id: 'msg_b', role: 'assistant', created_at: 2, content: text('second') },
      ],
      conversationId: 'convo-123',
    });

    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(2);
    expect(saveMessage).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('msg_b', {
      thread_id: 'thread_1',
      metadata: { messageId: 'db-reply' },
    });
  });
});

describe('processMessages annotations', () => {
  it('resolves a citation to a file an earlier message already attached', async () => {
    const retrieveAndProcessFile = jest.fn().mockResolvedValue({ filename: 'doc.txt' });
    const client = { processedFileIds: new Set<string>(['file-doc']) };
    const messages = [
      {
        id: 'msg_1',
        role: 'assistant',
        created_at: 1,
        content: [
          {
            type: 'text',
            text: {
              value: 'See [0]',
              annotations: [
                {
                  type: 'file_citation',
                  text: '[0]',
                  start_index: 4,
                  end_index: 7,
                  file_citation: { file_id: 'file-doc' },
                },
              ],
            },
          },
        ],
      },
    ] as unknown as ThreadMessage[];

    const result = await processMessages({ retrieveAndProcessFile } as never, {
      openai: {},
      client,
      messages,
    });

    expect(result.text).toBe('See ^1^\n\n^1.^ doc.txt');
    expect(result.messages[0].files).toEqual([]);
  });
});

describe('syncMessages stored aggregates', () => {
  it('returns a reply tagged on two provider messages once, under its own parent', async () => {
    const deps = {
      saveMessage: jest.fn(),
      saveConvo: jest.fn().mockResolvedValue(null),
      stampConvoLastResponse: jest.fn().mockResolvedValue(null),
      addThreadMetadata: jest.fn(),
    } as unknown as ThreadSyncDeps;
    const openai: ThreadSyncClient = {
      req: { user: { id: 'user-123' } },
      beta: { threads: { messages: { update: jest.fn() } } },
    };
    const tagged = (id: string, role: string, messageId: string, created_at: number) => ({
      id,
      role,
      created_at,
      content: [],
      metadata: { messageId },
    });

    const result = await syncMessages(deps, {
      openai,
      endpoint: 'assistants',
      thread_id: 'thread_1',
      dbMessages: [
        { messageId: 'db-user', role: 'user' },
        { messageId: 'db-reply', role: 'assistant' },
      ],
      apiMessages: [
        tagged('msg_u', 'user', 'db-user', 1),
        tagged('msg_a', 'assistant', 'db-reply', 2),
        tagged('msg_b', 'assistant', 'db-reply', 3),
      ],
      conversationId: 'convo-123',
    });

    expect(result.map((message) => message.messageId)).toEqual(['db-user', 'db-reply']);
    expect(result[1].parentMessageId).toBe('db-user');
    expect(deps.saveMessage).not.toHaveBeenCalled();
  });
});

describe('syncMessages partially tagged replies', () => {
  it('saves content appended between two provider messages tagged with the same reply', async () => {
    const saveMessage = jest.fn(async (_ctx: unknown, message: Record<string, unknown>) => message);
    const deps = {
      saveMessage,
      saveConvo: jest.fn().mockResolvedValue(null),
      stampConvoLastResponse: jest.fn().mockResolvedValue(null),
      addThreadMetadata: jest.fn().mockResolvedValue(undefined),
    } as unknown as ThreadSyncDeps;
    const update = jest.fn().mockResolvedValue({});
    const openai: ThreadSyncClient = {
      req: { user: { id: 'user-123' } },
      beta: { threads: { messages: { update } } },
    };
    const text = (value: string) => [{ type: 'text', text: { value, annotations: [] } }];

    const result = await syncMessages(deps, {
      openai,
      endpoint: 'assistants',
      thread_id: 'thread_1',
      dbMessages: [{ messageId: 'db-reply', role: 'assistant', content: text('one') }],
      apiMessages: [
        {
          id: 'msg_a',
          role: 'assistant',
          created_at: 1,
          content: text('one'),
          metadata: { messageId: 'db-reply' },
        },
        { id: 'msg_b', role: 'assistant', created_at: 2, content: text('two') },
        {
          id: 'msg_c',
          role: 'assistant',
          created_at: 3,
          content: [],
          metadata: { messageId: 'db-reply' },
        },
      ],
      conversationId: 'convo-123',
    });

    expect(result).toHaveLength(1);
    expect(saveMessage).toHaveBeenCalledTimes(1);
    expect(saveMessage.mock.calls[0][1].content).toHaveLength(2);
    expect(update).toHaveBeenCalledWith('msg_b', {
      thread_id: 'thread_1',
      metadata: { messageId: 'db-reply' },
    });
  });
});

describe('syncMessages run reply', () => {
  const replyId = '0b6f6c1e-5d4a-4c8e-9f3b-2a7d8e1c4b5f';
  const text = (value: string) => [{ type: 'text', text: { value, annotations: [] } }];
  const user: ThreadMessage = {
    id: 'msg_user',
    role: 'user',
    created_at: 1,
    content: text('prompt'),
    metadata: { messageId: 'db-user' },
  };
  const runMessage = (id: string, value: string, run_id = 'run_1'): ThreadMessage => ({
    id,
    role: 'assistant',
    created_at: 2,
    run_id,
    content: text(value),
    assistant_id: 'asst_1',
  });
  /** The copy a cancelled run kept as it streamed. */
  const kept = { messageId: replyId, conversationId: 'convo-123', unfinished: true };

  function setup(stored?: Record<string, unknown>) {
    const saveMessage = jest.fn(
      async (
        _ctx: unknown,
        message: Record<string, unknown>,
        options?: { insertOnly?: boolean },
      ) => (options?.insertOnly && stored ? stored : { ...message }),
    );
    const deps = {
      saveMessage,
      saveConvo: jest.fn().mockResolvedValue(null),
      stampConvoLastResponse: jest.fn().mockResolvedValue(null),
      addThreadMetadata: jest.fn().mockResolvedValue(undefined),
    } as unknown as ThreadSyncDeps;
    const update = jest.fn().mockResolvedValue({});
    const openai: ThreadSyncClient = {
      req: { user: { id: 'user-123' } },
      beta: { threads: { messages: { update } } },
    };
    return { deps, saveMessage, update, openai };
  }

  it('saves the reply under the id the client shows, without overwriting a stored row', async () => {
    const { deps, saveMessage, update, openai } = setup();

    const result = await syncMessages(deps, {
      openai,
      endpoint: 'assistants',
      thread_id: 'thread_1',
      dbMessages: [{ messageId: 'db-user', isCreatedByUser: true }],
      apiMessages: [user, runMessage('msg_reply', 'achunk-001')],
      conversationId: 'convo-123',
      reply: { messageId: replyId, runId: 'run_1' },
    });

    expect(result.map((message) => message.messageId)).toEqual(['db-user', replyId]);
    expect(result[1].parentMessageId).toBe('db-user');
    expect(saveMessage).toHaveBeenCalledTimes(1);
    expect(saveMessage.mock.calls[0][1]).toMatchObject({
      messageId: replyId,
      unfinished: false,
      isUserSubmitted: false,
    });
    expect(saveMessage.mock.calls[0][2]).toEqual({ insertOnly: true });
    expect(update).toHaveBeenCalledWith('msg_reply', {
      thread_id: 'thread_1',
      metadata: { messageId: replyId },
    });
    expect(deps.stampConvoLastResponse).toHaveBeenCalledWith('user-123', 'convo-123', replyId);
  });

  it.each([
    ['was read with the conversation', true],
    ['landed after the conversation was read', false],
  ])('replaces the copy a cancelled run kept that %s', async (_label, read) => {
    const { deps, saveMessage, openai } = setup(kept);

    const result = await syncMessages(deps, {
      openai,
      endpoint: 'assistants',
      thread_id: 'thread_1',
      dbMessages: [
        { messageId: 'db-user', isCreatedByUser: true },
        ...(read ? [{ ...kept, content: text('achunk-001') }] : []),
      ],
      apiMessages: [user, runMessage('msg_reply', 'achunk-001 achunk-002')],
      conversationId: 'convo-123',
      reply: { messageId: replyId, runId: 'run_1' },
    });

    expect(result.map((message) => message.messageId)).toEqual(['db-user', replyId]);
    expect(saveMessage).toHaveBeenCalledTimes(2);
    expect(saveMessage.mock.calls[0][2]).toEqual({ insertOnly: true });
    expect(saveMessage.mock.calls[1][2]).toBeUndefined();
    expect(saveMessage.mock.calls[1][1]).toMatchObject({
      messageId: replyId,
      parentMessageId: 'db-user',
      unfinished: false,
      content: text('achunk-001 achunk-002'),
    });
  });

  it('leaves a row of another conversation under the reply id alone', async () => {
    const { deps, saveMessage, openai } = setup({ ...kept, conversationId: 'convo-other' });

    await syncMessages(deps, {
      openai,
      endpoint: 'assistants',
      thread_id: 'thread_1',
      dbMessages: [{ messageId: 'db-user', isCreatedByUser: true }],
      apiMessages: [user, runMessage('msg_reply', 'achunk-001')],
      conversationId: 'convo-123',
      reply: { messageId: replyId, runId: 'run_1' },
    });

    expect(saveMessage).toHaveBeenCalledTimes(1);
    expect(deps.stampConvoLastResponse).not.toHaveBeenCalled();
  });

  it('saves every provider message of the run as one reply', async () => {
    const { deps, saveMessage, openai } = setup();

    const result = await syncMessages(deps, {
      openai,
      endpoint: 'assistants',
      thread_id: 'thread_1',
      dbMessages: [{ messageId: 'db-user', isCreatedByUser: true }],
      apiMessages: [user, runMessage('msg_one', 'one'), runMessage('msg_two', 'two')],
      conversationId: 'convo-123',
      reply: { messageId: replyId, runId: 'run_1' },
    });

    expect(result.map((message) => message.messageId)).toEqual(['db-user', replyId]);
    expect(saveMessage).toHaveBeenCalledTimes(1);
    expect(saveMessage.mock.calls[0][1].content).toEqual([...text('one'), ...text('two')]);
    expect(deps.addThreadMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: replyId,
        messages: [{ id: 'msg_one' }, { id: 'msg_two' }],
      }),
    );
  });

  it('keeps the kept reply of an earlier run as it is stored', async () => {
    const { deps, saveMessage, openai } = setup();
    const earlier = { messageId: 'kept-earlier', unfinished: true, content: text('achunk-001') };

    const result = await syncMessages(deps, {
      openai,
      endpoint: 'assistants',
      thread_id: 'thread_1',
      dbMessages: [{ messageId: 'db-user', isCreatedByUser: true }, earlier],
      apiMessages: [
        user,
        {
          ...runMessage('msg_earlier', 'achunk-001', 'run_0'),
          metadata: { messageId: earlier.messageId },
        },
        runMessage('msg_reply', 'second', 'run_1'),
      ],
      conversationId: 'convo-123',
      reply: { messageId: replyId, runId: 'run_1' },
    });

    expect(result.map((message) => message.messageId)).toEqual([
      'db-user',
      'kept-earlier',
      replyId,
    ]);
    expect(saveMessage).toHaveBeenCalledTimes(1);
    expect(saveMessage.mock.calls[0][1].messageId).toBe(replyId);
  });

  it.each([
    ['its provider message', ['msg_earlier']],
    ['its provider messages', ['msg_earlier', 'msg_earlier_2']],
  ])('finds the kept reply of an earlier run that could not tag %s', async (_label, ids) => {
    const { deps, saveMessage, openai } = setup();
    const earlier = {
      messageId: 'kept-earlier',
      parentMessageId: 'db-user',
      unfinished: true,
      content: text('achunk-001'),
    };

    const result = await syncMessages(deps, {
      openai,
      endpoint: 'assistants',
      thread_id: 'thread_1',
      dbMessages: [{ messageId: 'db-user', isCreatedByUser: true }, earlier],
      apiMessages: [
        user,
        ...ids.map((id) => runMessage(id, 'achunk-001 achunk-002', 'run_0')),
        runMessage('msg_reply', 'second', 'run_1'),
      ],
      conversationId: 'convo-123',
      reply: { messageId: replyId, runId: 'run_1' },
    });

    expect(result.map((message) => message.messageId)).toEqual([
      'db-user',
      'kept-earlier',
      replyId,
    ]);
    expect(saveMessage).toHaveBeenCalledTimes(1);
    expect(saveMessage.mock.calls[0][1].parentMessageId).toBe('kept-earlier');
  });

  it('gives the reply a new id when the one it was named by is not a UUID', async () => {
    const { deps, saveMessage, openai } = setup();

    const result = await syncMessages(deps, {
      openai,
      endpoint: 'assistants',
      thread_id: 'thread_1',
      dbMessages: [{ messageId: 'db-user', isCreatedByUser: true }],
      apiMessages: [user, runMessage('msg_reply', 'achunk-001')],
      conversationId: 'convo-123',
      reply: { messageId: '', runId: 'run_1' },
    });

    expect(result[1].messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(saveMessage.mock.calls[0][2]).toBeUndefined();
  });
});

import { ContentTypes } from 'librechat-data-provider';
import type { ThreadSyncDeps, ThreadSyncClient, ThreadMessage, ThreadRunStep } from './threads';
import { foldRun, syncMessages } from './threads';

const text = (value: string) => ({ type: 'text', text: { value, annotations: [] } });

const message = (id: string, created_at: number, value: string, role = 'assistant') =>
  ({
    id,
    role,
    created_at,
    content: [text(value)],
    metadata: role === 'user' ? { messageId: 'db-user' } : {},
    ...(role === 'assistant' ? { run_id: 'run_1', assistant_id: 'asst_run' } : {}),
  }) as ThreadMessage;

const messageStep = (messageId: string, created_at: number): ThreadRunStep => ({
  created_at,
  assistant_id: 'asst_run',
  step_details: { type: 'message_creation', message_creation: { message_id: messageId } },
});

const codeCall = { id: 'call_code', type: 'code_interpreter', code_interpreter: { input: '1' } };
const toolStep = (created_at: number): ThreadRunStep => ({
  created_at,
  assistant_id: 'asst_run',
  step_details: { type: 'tool_calls', tool_calls: [codeCall] },
});
const toolPart = { type: ContentTypes.TOOL_CALL, tool_call: { ...codeCall, progress: 2 } };

/** A thread listed newest first, as the API lists it: a prompt, then a run that wrote `FIRST `,
 *  called a tool and wrote `SECOND`. */
const thread = () => [
  message('msg_b', 3, 'SECOND'),
  message('msg_a', 1, 'FIRST '),
  message('msg_u', 0, 'go', 'user'),
];
const runSteps = () => [messageStep('msg_b', 3), toolStep(2), messageStep('msg_a', 1)];

describe('foldRun', () => {
  it('folds the run into one reply in step order, in place of the messages it carries', () => {
    const folded = foldRun({
      messages: thread(),
      steps: runSteps(),
      run_id: 'run_1',
      messageId: 'reply-id',
    });

    expect(folded.map(({ id }) => id)).toEqual(['msg_u', 'msg_b']);
    expect(folded[1]).toEqual({
      id: 'msg_b',
      role: 'assistant',
      created_at: 3,
      content: [text('FIRST '), toolPart, text('SECOND')],
      assistant_id: 'asst_run',
      run_id: 'run_1',
      metadata: { messageId: 'reply-id' },
      aggregateMessages: [{ id: 'msg_a' }, { id: 'msg_b' }],
    });
  });

  it('leaves a message of the run in the thread when its step was not read back', () => {
    const folded = foldRun({
      messages: thread(),
      steps: [messageStep('msg_b', 3), toolStep(2)],
      run_id: 'run_1',
    });

    expect(folded.map(({ id }) => id)).toEqual(['msg_u', 'msg_a', 'msg_b']);
    expect(folded[2].content).toEqual([toolPart, text('SECOND')]);
    expect(folded[2].aggregateMessages).toEqual([{ id: 'msg_b' }]);
  });

  it('adds a reply after the thread for a run that only called tools', () => {
    const messages = [message('msg_u', 0, 'go', 'user')];
    const folded = foldRun({ messages, steps: [toolStep(2)], run_id: 'run_1' });

    expect(folded).toHaveLength(2);
    expect(folded[0]).toBe(messages[0]);
    expect(folded[1].id).not.toMatch(/^msg_/);
    expect(folded[1].content).toEqual([toolPart]);
    expect(folded[1].assistant_id).toBe('asst_run');
    expect(folded[1].aggregateMessages).toBeUndefined();
  });
});

describe('syncMessages with a folded run', () => {
  function sync(apiMessages: ThreadMessage[]) {
    const saveMessage = jest.fn(async (_ctx: unknown, row: Record<string, unknown>) => row);
    const deps = {
      saveMessage,
      saveConvo: jest.fn().mockResolvedValue(null),
      stampConvoLastResponse: jest.fn().mockResolvedValue(null),
      addThreadMetadata: jest.fn().mockResolvedValue(undefined),
    } as unknown as ThreadSyncDeps;
    const openai: ThreadSyncClient = {
      req: { user: { id: 'user-123' } },
      beta: { threads: { messages: { update: jest.fn().mockResolvedValue({}) } } },
    };
    const synced = syncMessages(deps, {
      openai,
      endpoint: 'assistants',
      thread_id: 'thread_1',
      dbMessages: [{ messageId: 'db-user', role: 'user' }],
      apiMessages,
      conversationId: 'convo-123',
    });
    return { synced, saveMessage, deps, openai };
  }

  it('saves the reply once and tags every provider message it carries', async () => {
    const { synced, saveMessage, deps } = sync(
      foldRun({ messages: thread(), steps: runSteps(), run_id: 'run_1' }),
    );

    const [, reply] = await synced;
    expect(saveMessage).toHaveBeenCalledTimes(1);
    expect(saveMessage.mock.calls[0][1]).toMatchObject({
      messageId: reply.messageId,
      parentMessageId: 'db-user',
      model: 'asst_run',
      content: [text('FIRST '), toolPart, text('SECOND')],
    });
    expect(deps.addThreadMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: reply.messageId,
        messages: [{ id: 'msg_a' }, { id: 'msg_b' }],
      }),
    );
  });

  it('tags the carried messages when the reply continues an earlier assistant message', async () => {
    const earlier = { ...message('msg_x', 0.5, 'EARLIER '), run_id: 'run_0' };
    const { synced, saveMessage, deps } = sync(
      foldRun({ messages: [...thread(), earlier], steps: runSteps(), run_id: 'run_1' }),
    );

    const [, reply] = await synced;
    expect(saveMessage.mock.calls[0][1].content).toEqual([
      text('EARLIER '),
      text('FIRST '),
      toolPart,
      text('SECOND'),
    ]);
    expect(deps.addThreadMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: reply.messageId,
        messages: [{ id: 'msg_x' }, { id: 'msg_a' }, { id: 'msg_b' }],
      }),
    );
  });
});

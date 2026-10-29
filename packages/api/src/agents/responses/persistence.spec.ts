import { formatAgentMessages } from '@librechat/agents';
import { Constants, ContentTypes } from 'librechat-data-provider';
import { ToolMessage } from '@librechat/agents/langchain/messages';
import type { StoredResponseMessage } from './persistence';
import type { Response } from './types';
import {
  selectStoredResponse,
  selectResponseHistory,
  buildResponseInputChain,
  projectResponseMessage,
  resolveResponseContinuation,
} from './persistence';

describe('Responses assistant history projection', () => {
  it('marks paused output unfinished and explicitly clears that flag on terminal publication', () => {
    expect(projectResponseMessage({ output: [], status: 'in_progress' }).unfinished).toBe(true);
    expect(projectResponseMessage({ output: [], status: 'completed' }).unfinished).toBe(false);
    expect(projectResponseMessage({ output: [] })).not.toHaveProperty('unfinished');
  });
  const response: Pick<Response, 'output'> = {
    output: [
      {
        type: 'function_call',
        id: 'fc_server',
        call_id: 'call-server',
        name: 'lookup',
        arguments: '{"key":"a"}',
        status: 'completed',
      },
      {
        type: 'function_call_output',
        id: 'fco_server',
        call_id: 'call-server',
        output: '{"result":"server-only-result"}',
        status: 'completed',
      },
      {
        type: 'function_call',
        id: 'fc_client',
        call_id: 'call-client',
        name: 'client_action',
        arguments: '{}',
        status: 'completed',
      },
      {
        type: 'message',
        id: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Done.', annotations: [], logprobs: [] }],
      },
    ],
  };
  it('retains exact server results, not unanswered client calls, in the normal browser message shape', () => {
    const projected = projectResponseMessage(response);
    expect(projected).toEqual({
      text: 'Done.',
      content: [
        {
          type: ContentTypes.TOOL_CALL,
          tool_call: {
            id: 'call-server',
            name: 'lookup',
            args: '{"key":"a"}',
            output: '{"result":"server-only-result"}',
          },
        },
        { type: ContentTypes.TEXT, text: 'Done.' },
      ],
    });
    expect(JSON.stringify(projected)).not.toContain('client_action');
  });
  it('round-trips stored content into an actual SDK ToolMessage on continuation', () => {
    const projected = projectResponseMessage(response);
    const { messages } = formatAgentMessages(
      [
        { role: 'user', content: 'Look up a key' },
        { role: 'assistant', content: projected.content },
        { role: 'user', content: 'What exactly did the lookup return?' },
      ],
      undefined,
      new Set(['lookup']),
    );
    const toolMessages = messages.filter((message) => message instanceof ToolMessage);
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].content).toBe('{"result":"server-only-result"}');
  });
  it('preserves empty server results instead of making the call look unanswered', () => {
    const projected = projectResponseMessage({
      output: [
        response.output[0],
        {
          type: 'function_call_output',
          id: 'fco_empty',
          call_id: 'call-server',
          output: '',
          status: 'completed',
        },
      ],
    });
    expect(projected.content).toEqual([
      expect.objectContaining({ tool_call: expect.objectContaining({ output: '' }) }),
    ]);
  });
});

describe('Responses persistence references', () => {
  const messages: StoredResponseMessage[] = [
    { messageId: 'u1', parentMessageId: String(Constants.NO_PARENT), isCreatedByUser: true },
    { messageId: 'resp_first', parentMessageId: 'u1', text: 'first answer' },
    { messageId: 'u2', parentMessageId: 'resp_first', isCreatedByUser: true },
    { messageId: 'resp_second', parentMessageId: 'u2', text: 'second answer' },
    { messageId: 'branch-user', parentMessageId: 'resp_first', isCreatedByUser: true },
    { messageId: 'resp_branch', parentMessageId: 'branch-user', text: 'branch answer' },
  ];

  it('gives a new conversation a UI-compatible root parent', async () => {
    const getMessage = jest.fn();
    const result = await resolveResponseContinuation(undefined, 'owner', {
      getMessage,
    });
    expect(result.conversationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(result.parentMessageId).toBe(Constants.NO_PARENT);
    expect(getMessage).not.toHaveBeenCalled();
  });

  it('resolves a returned response ID using an owner-scoped message lookup', async () => {
    const getMessage = jest.fn().mockResolvedValue({
      messageId: 'resp_first',
      conversationId: 'conversation',
      isCreatedByUser: false,
    });
    await expect(
      resolveResponseContinuation('resp_first', 'owner', { getMessage }),
    ).resolves.toEqual({
      conversationId: 'conversation',
      parentMessageId: 'resp_first',
    });
    expect(getMessage).toHaveBeenCalledWith({ user: 'owner', messageId: 'resp_first' });
  });

  it('does not resolve a foreign response into its conversation', async () => {
    const getMessage = jest.fn().mockResolvedValue(null);
    await expect(
      resolveResponseContinuation('resp_foreign', 'owner', { getMessage }),
    ).resolves.toEqual({
      conversationId: 'resp_foreign',
      parentMessageId: Constants.NO_PARENT,
    });
  });

  it('does not accept a user message as a response reference', async () => {
    const getMessage = jest.fn().mockResolvedValue({
      messageId: 'resp_user',
      conversationId: 'conversation',
      isCreatedByUser: true,
    });
    expect(await resolveResponseContinuation('resp_user', 'owner', { getMessage })).toEqual({
      conversationId: 'resp_user',
      parentMessageId: Constants.NO_PARENT,
    });
  });

  it('propagates database failures rather than starting a new conversation', async () => {
    const getMessage = jest.fn().mockRejectedValue(new Error('database unavailable'));
    await expect(
      resolveResponseContinuation('resp_first', 'owner', { getMessage }),
    ).rejects.toThrow('Response storage is unavailable');
  });

  it('links legacy conversation-ID continuation to its last assistant reply', async () => {
    const getMessage = jest.fn().mockResolvedValue(null);
    const continuation = await resolveResponseContinuation('conversation', 'owner', { getMessage });
    expect(continuation.conversationId).toBe('conversation');
    expect(
      buildResponseInputChain([], continuation.parentMessageId, messages).parentMessageId,
    ).toBe('resp_branch');
  });

  it('preserves old null-parent history when a new reply continues an old response', () => {
    const legacy = messages.slice(0, 2).map((message) => ({ ...message, parentMessageId: null }));
    expect(selectResponseHistory([...legacy, ...messages.slice(2, 4)], 'resp_second')).toEqual([
      ...legacy,
      ...messages.slice(2, 4),
    ]);
  });

  it('replays only the selected response ancestry, without subsequent or sibling turns', () => {
    expect(
      selectResponseHistory(messages, 'resp_second').map((message) => message.messageId),
    ).toEqual(['u1', 'resp_first', 'u2', 'resp_second']);
    expect(
      selectResponseHistory(messages, 'resp_first').map((message) => message.messageId),
    ).toEqual(['u1', 'resp_first']);
    expect(
      selectResponseHistory(messages, 'resp_branch').map((message) => message.messageId),
    ).toEqual(['u1', 'resp_first', 'branch-user', 'resp_branch']);
  });

  it('does not load history for an unknown response or user message', () => {
    expect(selectResponseHistory(messages, 'resp_missing')).toEqual([]);
    expect(
      selectResponseHistory([{ messageId: 'resp_user', isCreatedByUser: true }], 'resp_user'),
    ).toEqual([]);
  });

  it('detects cyclic or incomplete message ancestry', () => {
    expect(() =>
      selectResponseHistory(
        [{ messageId: 'resp_cycle', parentMessageId: 'resp_cycle' }],
        'resp_cycle',
      ),
    ).toThrow('cycle');
    expect(() =>
      selectResponseHistory(
        [{ messageId: 'resp_broken', parentMessageId: 'missing' }],
        'resp_broken',
      ),
    ).toThrow('incomplete');
  });

  it('retains legacy conversation-ID history and bounds legacy null-parent response history', () => {
    expect(selectResponseHistory(messages, 'legacy-conversation')).toBe(messages);
    const legacy = messages.map((message) => ({ ...message, parentMessageId: null }));
    expect(selectResponseHistory(legacy, 'resp_first')).toEqual(legacy.slice(0, 2));
  });

  it('builds user and assistant parent links without mutating inputs', () => {
    const input = [
      { role: 'user', messageId: 'u1' },
      { role: 'user', messageId: 'u2' },
    ];
    expect(buildResponseInputChain(input, 'resp_previous')).toEqual({
      messages: [
        { role: 'user', messageId: 'u1', parentMessageId: 'resp_previous' },
        { role: 'user', messageId: 'u2', parentMessageId: 'u1' },
      ],
      parentMessageId: 'u2',
    });
    expect(input[0]).not.toHaveProperty('parentMessageId');
  });

  it('assigns missing user IDs and does not persist client tool or system input as a user', () => {
    const chain = buildResponseInputChain(
      [{ role: 'system' }, { role: 'user' }],
      String(Constants.NO_PARENT),
    );
    expect(chain.messages).toHaveLength(1);
    expect(chain.messages[0].parentMessageId).toBe(Constants.NO_PARENT);
    expect(chain.parentMessageId).toBe(chain.messages[0].messageId);
  });

  it('retrieves exactly the requested response rather than the entire conversation', () => {
    expect(selectStoredResponse(messages, 'resp_first')).toEqual([messages[1]]);
    expect(selectStoredResponse(messages, 'resp_missing')).toEqual([]);
    expect(selectStoredResponse(messages, 'legacy-conversation')).toEqual([messages[5]]);
  });
});

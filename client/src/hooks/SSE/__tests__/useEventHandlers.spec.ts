import { Constants, ContentTypes } from 'librechat-data-provider';
import { mergeErrorMessages, buildRecoveryPreset } from '@librechat/chat';
import type {
  TMessageContentParts,
  EventSubmission,
  TConversation,
  TMessage,
} from 'librechat-data-provider';
import type { TResData } from '~/common';
import { getFailedCodeDecisionRequest } from '~/hooks/Agents/codeDecision';
import { stripStreamedIndexStamps, getPartKeyIndex } from '~/utils';
import buildDefaultConvo from '~/utils/buildDefaultConvo';
import { resolveErrorTurn } from '~/hooks/SSE/turns';

describe('resolveErrorTurn', () => {
  const userMessage = {
    messageId: 'user-1',
    conversationId: 'conversation-1',
    parentMessageId: Constants.NO_PARENT,
    isCreatedByUser: true,
    text: 'Look up the issue',
    sender: 'User',
  } as TMessage;
  const initialResponse = {
    messageId: 'user-1_',
    parentMessageId: 'user-1',
    conversationId: 'conversation-1',
    isCreatedByUser: false,
    text: '',
    sender: 'Lia',
    endpoint: 'agents',
    model: 'agent_1',
  } as TMessage;
  const submission = {
    messages: [],
    userMessage,
    initialResponse,
    conversation: { conversationId: 'conversation-1' },
  } as unknown as EventSubmission;
  const streamedParts = [
    { type: ContentTypes.THINK, think: 'Checking the issue' },
    { type: ContentTypes.TEXT, text: 'Let me try the GitHub CLI from the workspace.' },
    {
      type: ContentTypes.TOOL_CALL,
      tool_call: { id: 'call-1', name: 'execute_code', args: '{}', progress: 1 },
    },
  ] as TMessageContentParts[];
  const streamedResponse = { ...initialResponse, content: streamedParts };
  const startFailureText = JSON.stringify({ code: 'code_workspace_unavailable', reason: 'locked' });
  const startFailure = {
    text: startFailureText,
    metadata: { streamStartFailed: true },
  } as unknown as TResData;

  it('keeps a failed regeneration under its existing user turn when no content streamed', () => {
    const regenerateSubmission = {
      ...submission,
      isRegenerate: true,
      userMessage: {
        ...userMessage,
        messageId: 'temporary-user-id',
        overrideParentMessageId: userMessage.messageId,
      },
      initialResponse: { ...initialResponse, messageId: 'response-id_' },
    } as EventSubmission;
    const siblings = [
      { ...initialResponse, messageId: 'previous-sibling' },
      { ...initialResponse, messageId: 'response-id' },
    ];

    const failedSubmission = {
      ...regenerateSubmission,
      regenerateMessages: [userMessage, ...siblings],
    };
    const { errorResponse } = resolveErrorTurn({
      data: {
        text: 'Model spec mismatch',
        metadata: { streamStartFailed: true },
      } as unknown as TResData,
      submission: failedSubmission,
      getMessages: () => [userMessage, siblings[0], regenerateSubmission.initialResponse],
      isNewConversationRoute: false,
    });

    expect(errorResponse.messageId).toBe('response-id_');
    expect(errorResponse.parentMessageId).toBe(userMessage.messageId);
    expect(errorResponse.text).toBe('Model spec mismatch');
    expect(
      mergeErrorMessages({ ...failedSubmission, errorMessage: errorResponse }).map(
        (message) => message.messageId,
      ),
    ).toEqual(['user-1', 'previous-sibling', 'response-id', 'response-id_']);

    const addressed = resolveErrorTurn({
      data: {
        conversationId: 'conversation-1',
        messageId: 'response-id_',
        isCreatedByUser: false,
        text: 'Model spec mismatch',
      } as unknown as TResData,
      submission: failedSubmission,
      getMessages: () => [userMessage, regenerateSubmission.initialResponse],
      isNewConversationRoute: false,
    });
    expect(addressed.errorResponse.parentMessageId).toBe(userMessage.messageId);
  });

  it.each([
    ['transport failure', undefined],
    [
      'server-addressed failure',
      {
        conversationId: 'conversation-1',
        messageId: 'response-id_',
        isCreatedByUser: false,
        text: 'Model spec mismatch',
      },
    ],
  ])('keeps a partially streamed regeneration on its original branch after a %s', (_name, data) => {
    const regenerateSubmission = {
      ...submission,
      isRegenerate: true,
      userMessage: {
        ...userMessage,
        messageId: 'temporary-user-id',
        overrideParentMessageId: userMessage.messageId,
      },
      initialResponse: { ...initialResponse, messageId: 'response-id_' },
    } as EventSubmission;
    const streamed = { ...regenerateSubmission.initialResponse, content: streamedParts };

    const { errorResponse } = resolveErrorTurn({
      data: data as TResData | undefined,
      submission: regenerateSubmission,
      getMessages: () => [userMessage, streamed],
      isNewConversationRoute: false,
    });

    expect(errorResponse.messageId).toBe('response-id_');
    expect(errorResponse.parentMessageId).toBe(userMessage.messageId);
    expect(errorResponse.content?.at(-1)?.type).toBe(ContentTypes.ERROR);
  });

  it('keeps what the run streamed and takes the failure as one more part', () => {
    const { conversationId, errorResponse, recover } = resolveErrorTurn({
      data: startFailure,
      submission,
      getMessages: () => [userMessage, streamedResponse],
      isNewConversationRoute: false,
    });

    expect(conversationId).toBe('conversation-1');
    expect(recover).toBe(false);
    expect(errorResponse.content).toEqual([
      ...streamedParts,
      { type: ContentTypes.ERROR, error: startFailureText },
    ]);
    expect(errorResponse.error).toBeUndefined();
    expect(errorResponse.text).toBe('');
    expect(errorResponse.messageId).toBe('user-1_');
    expect(errorResponse.parentMessageId).toBe('user-1');
    expect(errorResponse.metadata).toEqual({ streamStartFailed: true });
  });

  it('drops holes, keeps empty slots, and keeps the identity every part streamed under', () => {
    const openedThink = { type: ContentTypes.THINK, think: '' };
    const openedText = { type: ContentTypes.TEXT, text: '' };
    const { errorResponse } = resolveErrorTurn({
      data: startFailure,
      submission,
      getMessages: () => [
        userMessage,
        {
          ...initialResponse,
          content: [
            openedThink,
            streamedParts[0],
            undefined,
            streamedParts[1],
            streamedParts[2],
            openedText,
          ],
        } as TMessage,
      ],
      isNewConversationRoute: false,
    });

    const content = errorResponse.content ?? [];
    expect(stripStreamedIndexStamps(content)).toEqual([
      openedThink,
      ...streamedParts,
      openedText,
      { type: ContentTypes.ERROR, error: startFailureText },
    ]);
    expect(content.map((part, idx) => getPartKeyIndex(part, idx))).toEqual([0, 1, 3, 4, 5, 6]);
  });

  it('keeps the comparison lanes when one side streamed before the failure', () => {
    const lanes = [
      { type: '', agentId: 'agent_a', groupId: 1 },
      { type: ContentTypes.TEXT, text: 'From the added agent', agentId: 'agent_b', groupId: 1 },
    ];
    const { errorResponse } = resolveErrorTurn({
      data: startFailure,
      submission,
      getMessages: () => [
        userMessage,
        { ...initialResponse, content: lanes } as unknown as TMessage,
      ],
      isNewConversationRoute: false,
    });

    expect(errorResponse.content).toEqual([
      ...lanes,
      { type: ContentTypes.ERROR, error: startFailureText },
    ]);
  });

  it('is the whole row when a comparison run failed before either lane streamed', () => {
    const { errorResponse } = resolveErrorTurn({
      data: startFailure,
      submission,
      getMessages: () => [
        userMessage,
        {
          ...initialResponse,
          content: [
            { type: '', agentId: 'agent_a', groupId: 1 },
            { type: '', agentId: 'agent_b', groupId: 1 },
          ],
        } as unknown as TMessage,
      ],
      isNewConversationRoute: false,
    });

    expect(errorResponse.content).toBeUndefined();
    expect(errorResponse.error).toBe(true);
    expect(errorResponse.text).toBe(startFailureText);
  });

  it('is the whole row when nothing streamed', () => {
    const { errorResponse } = resolveErrorTurn({
      data: startFailure,
      submission,
      getMessages: () => [userMessage, initialResponse],
      isNewConversationRoute: false,
    });

    expect(errorResponse.content).toBeUndefined();
    expect(errorResponse.error).toBe(true);
    expect(errorResponse.text).toBe(startFailureText);
    expect(errorResponse.messageId).toBe('user-1_');
    expect(errorResponse.parentMessageId).toBe('user-1');
  });

  it('never takes a user row at the tail for the failed response', () => {
    const { errorResponse } = resolveErrorTurn({
      data: startFailure,
      submission,
      getMessages: () => [
        { ...userMessage, content: [{ type: ContentTypes.TEXT, text: 'Look up the issue' }] },
      ],
      isNewConversationRoute: false,
    });

    expect(errorResponse.content).toBeUndefined();
    expect(errorResponse.error).toBe(true);
  });

  it('records a lost connection as a part of the streamed response and rebuilds the chat', () => {
    const { conversationId, errorResponse, recover } = resolveErrorTurn({
      data: undefined,
      submission,
      getMessages: () => [userMessage, streamedResponse],
      isNewConversationRoute: false,
    });

    expect(conversationId).toBe('conversation-1');
    expect(recover).toBe(true);
    expect(errorResponse.content).toEqual([
      ...streamedParts,
      {
        type: ContentTypes.ERROR,
        error: 'Error connecting to server, try refreshing the page.',
      },
    ]);
  });

  it("keeps the streamed row's envelope when a server failure carries its own", () => {
    const streamedAt = '2026-09-15T13:00:00.000Z';
    const { errorResponse } = resolveErrorTurn({
      data: {
        conversationId: 'conversation-1',
        messageId: 'user-1_',
        isCreatedByUser: false,
        sender: 'System',
        model: null,
        iconURL: null,
        createdAt: '2026-09-15T13:05:00.000Z',
        text: startFailureText,
        metadata: { streamStartFailed: true },
      } as unknown as TResData,
      submission,
      getMessages: () => [
        userMessage,
        { ...streamedResponse, iconURL: 'lia.png', createdAt: streamedAt, metadata: { seed: 1 } },
      ],
      isNewConversationRoute: false,
    });

    expect(errorResponse).toEqual(
      expect.objectContaining({
        sender: 'Lia',
        model: 'agent_1',
        iconURL: 'lia.png',
        createdAt: streamedAt,
        metadata: { seed: 1, streamStartFailed: true },
      }),
    );
    expect(errorResponse.content?.at(-1)).toEqual({
      type: ContentTypes.ERROR,
      error: startFailureText,
    });
  });

  it('keeps the streamed parts under a failure the server addressed to the conversation', () => {
    const serverText = JSON.stringify({ type: 'invalid_request' });
    const data = {
      conversationId: 'conversation-1',
      messageId: 'user-1_',
      isCreatedByUser: false,
      sender: 'Lia',
      text: serverText,
    } as unknown as TResData;

    const fromChat = resolveErrorTurn({
      data,
      submission,
      getMessages: () => [userMessage, streamedResponse],
      isNewConversationRoute: false,
    });
    const fromNewChat = resolveErrorTurn({
      data,
      submission,
      getMessages: () => [userMessage, streamedResponse],
      isNewConversationRoute: true,
    });

    expect(fromChat.recover).toBe(false);
    expect(fromNewChat.recover).toBe(true);
    expect(fromChat.errorResponse.content).toEqual([
      ...streamedParts,
      { type: ContentTypes.ERROR, error: serverText },
    ]);
    expect(fromChat.errorResponse.parentMessageId).toBe('user-1');
  });
});

describe('first-send workspace error recovery', () => {
  const selection = { environmentId: 'machine', workspaceId: 'repo' };
  const submission = {
    conversation: { conversationId: 'new', endpoint: 'agents', agent_id: 'agent' },
    userMessage: { conversationId: 'generated-id', messageId: 'user' },
    initialResponse: { conversationId: 'generated-id', messageId: 'response' },
    codeWorkspaces: [selection],
  } as EventSubmission;

  it('preserves a legacy implicit choice in the recovery preset and reconciles its real id', () => {
    const preset = buildRecoveryPreset(
      submission.conversation,
      undefined,
      'generated-id',
      submission,
    );
    expect(preset.codeEnvironmentMode).toBe('attached');
    expect(preset.codeWorkspaces).toEqual([selection]);
    const rebuilt = buildDefaultConvo({
      conversation: {
        conversationId: 'generated-id',
        codeEnvironmentMode: preset.codeEnvironmentMode,
        codeWorkspaces: preset.codeWorkspaces,
      } as TConversation,
      lastConversationSetup: preset as TConversation,
      endpoint: 'agents' as never,
      models: [],
    });
    expect(rebuilt.codeEnvironmentMode).toBe('attached');
    expect(rebuilt.codeWorkspaces).toEqual([selection]);
    expect(getFailedCodeDecisionRequest(submission)).toEqual({
      conversationId: 'generated-id',
      attempted: { codeEnvironmentMode: 'attached', codeWorkspaces: [selection] },
    });
  });

  it('uses a structured error conversation id when the snapshot and messages are still new', () => {
    const first = {
      ...submission,
      userMessage: { ...submission.userMessage, conversationId: 'new' },
      initialResponse: { ...submission.initialResponse, conversationId: 'new' },
    } as EventSubmission;
    expect(getFailedCodeDecisionRequest(first, 'server-id')?.conversationId).toBe('server-id');
    expect(getFailedCodeDecisionRequest(first, '_local-error')).toBeUndefined();
    expect(getFailedCodeDecisionRequest(first)).toBeUndefined();
  });

  it('preserves an explicit without-attached first send while the authoritative read runs', () => {
    const unattached = {
      ...submission,
      codeEnvironmentMode: 'without_attached',
      codeWorkspaces: undefined,
    } as EventSubmission;
    expect(
      buildRecoveryPreset(unattached.conversation, undefined, 'generated-id', unattached)
        .codeEnvironmentMode,
    ).toBe('without_attached');
    expect(getFailedCodeDecisionRequest(unattached)?.attempted.codeEnvironmentMode).toBe(
      'without_attached',
    );
  });
});

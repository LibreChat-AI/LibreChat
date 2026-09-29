import { Constants, ContentTypes } from 'librechat-data-provider';
import type {
  TMessageContentParts,
  EventSubmission,
  TConversation,
  TMessage,
} from 'librechat-data-provider';
import type { TResData } from '~/common';
import {
  buildCreatedInitialResponse,
  getExistingConversationAbortMessages,
  isInitialNewConversationSubmission,
  keepLocalCodeApprovalMode,
  buildRecoveryPreset,
  mergeErrorMessages,
  mergeRegenerateFinalMessages,
  resolveErrorTurn,
  startedAsNewConversation,
} from '~/hooks/SSE/useEventHandlers';
import { getFailedCodeDecisionRequest } from '~/hooks/Agents/codeDecision';
import { stripStreamedIndexStamps, getPartKeyIndex } from '~/utils';
import buildDefaultConvo from '~/utils/buildDefaultConvo';

describe('buildCreatedInitialResponse', () => {
  const userMessage = {
    messageId: 'server-user-message',
    conversationId: 'conversation-1',
    isCreatedByUser: true,
    text: 'Hello',
    sender: 'User',
  } as TMessage;

  const initialResponse = {
    messageId: 'prelim-response',
    parentMessageId: 'original-user-message',
    conversationId: 'conversation-1',
    isCreatedByUser: false,
    text: '',
    sender: 'Assistant',
  } as TMessage;

  it('uses the created user message id for new turns', () => {
    expect(
      buildCreatedInitialResponse({
        initialResponse,
        userMessage,
        isRegenerate: false,
      }),
    ).toEqual(
      expect.objectContaining({
        messageId: 'server-user-message_',
        parentMessageId: 'server-user-message',
      }),
    );
  });

  it('preserves the regenerated prelim response id and parent', () => {
    expect(
      buildCreatedInitialResponse({
        initialResponse,
        userMessage,
        isRegenerate: true,
      }),
    ).toEqual(
      expect.objectContaining({
        messageId: 'prelim-response',
        parentMessageId: 'original-user-message',
      }),
    );
  });
});

describe('isInitialNewConversationSubmission', () => {
  it('treats a root user message as an optimistic new chat', () => {
    expect(
      isInitialNewConversationSubmission({
        userMessage: {
          messageId: 'user-1',
          parentMessageId: Constants.NO_PARENT,
        } as TMessage,
      } as EventSubmission),
    ).toBe(true);
  });

  it('does not treat follow-up turns as optimistic new chats', () => {
    expect(
      isInitialNewConversationSubmission({
        userMessage: {
          messageId: 'user-2',
          parentMessageId: 'assistant-1',
        } as TMessage,
      } as EventSubmission),
    ).toBe(false);
  });
});

describe('startedAsNewConversation', () => {
  const rootUserMessage = {
    messageId: 'user-1',
    parentMessageId: Constants.NO_PARENT,
  } as TMessage;

  it('treats an unsaved conversation as a new chat', () => {
    for (const conversationId of [undefined, Constants.NEW_CONVO, Constants.PENDING_CONVO]) {
      expect(
        startedAsNewConversation({
          conversation: { conversationId },
          userMessage: rootUserMessage,
        } as EventSubmission),
      ).toBe(true);
    }
  });

  it('treats a first turn without a saved id as a new chat', () => {
    expect(
      startedAsNewConversation({
        conversation: {},
        userMessage: rootUserMessage,
      } as EventSubmission),
    ).toBe(true);
  });

  it('does not treat a regenerated first reply of a saved conversation as a new chat', () => {
    expect(
      startedAsNewConversation({
        conversation: { conversationId: 'conversation-1' },
        userMessage: rootUserMessage,
        isRegenerate: true,
      } as EventSubmission),
    ).toBe(false);
  });

  it('does not treat a resubmitted first message of a saved conversation as a new chat', () => {
    expect(
      startedAsNewConversation({
        conversation: { conversationId: 'conversation-1' },
        userMessage: rootUserMessage,
        isEdited: true,
      } as EventSubmission),
    ).toBe(false);
  });

  it('does not treat a follow-up turn of a saved conversation as a new chat', () => {
    expect(
      startedAsNewConversation({
        conversation: { conversationId: 'conversation-1' },
        userMessage: { messageId: 'user-2', parentMessageId: 'assistant-1' } as TMessage,
      } as EventSubmission),
    ).toBe(false);
  });
});

describe('mergeRegenerateFinalMessages', () => {
  const userMessage = (messageId: string, parentMessageId: string = Constants.NO_PARENT) =>
    ({
      messageId,
      parentMessageId,
      conversationId: 'conversation-1',
      isCreatedByUser: true,
      sender: 'User',
      text: messageId,
    }) as TMessage;

  const assistantMessage = (messageId: string, parentMessageId: string) =>
    ({
      messageId,
      parentMessageId,
      conversationId: 'conversation-1',
      isCreatedByUser: false,
      sender: 'Assistant',
      text: messageId,
    }) as TMessage;

  it('keeps the original branch siblings when a non-tail regenerate finalizes', () => {
    const rootUser = userMessage('user-1');
    const originalResponse = assistantMessage('assistant-1', rootUser.messageId);
    const followUpUser = userMessage('user-2', originalResponse.messageId);
    const followUpResponse = assistantMessage('assistant-2', followUpUser.messageId);
    const finalResponse = assistantMessage('assistant-3', rootUser.messageId);

    expect(
      mergeRegenerateFinalMessages({
        messages: [rootUser, originalResponse, followUpUser, followUpResponse],
        responseMessage: finalResponse,
        initialResponseId: 'assistant-1_',
      }).map((message) => message.messageId),
    ).toEqual([
      rootUser.messageId,
      originalResponse.messageId,
      followUpUser.messageId,
      followUpResponse.messageId,
      finalResponse.messageId,
    ]);
  });

  it('replaces the streamed preliminary response when it is present', () => {
    const rootUser = userMessage('user-1');
    const preliminaryResponse = assistantMessage('assistant-1_', rootUser.messageId);
    const finalResponse = assistantMessage('assistant-3', rootUser.messageId);

    expect(
      mergeRegenerateFinalMessages({
        messages: [rootUser, preliminaryResponse],
        responseMessage: finalResponse,
        initialResponseId: preliminaryResponse.messageId,
      }).map((message) => message.messageId),
    ).toEqual([rootUser.messageId, finalResponse.messageId]);
  });
});

describe('getExistingConversationAbortMessages', () => {
  const message = (messageId: string) =>
    ({
      messageId,
      conversationId: 'conversation-1',
      text: messageId,
    }) as TMessage;

  it('restores the full pre-regenerate branch on early abort', () => {
    const originalMessages = [message('user-1'), message('assistant-1'), message('user-2')];
    const scopedRegenerateMessages = [message('user-1')];
    const currentStreamMessages = [message('user-1'), message('assistant-1_')];

    expect(
      getExistingConversationAbortMessages({
        messages: scopedRegenerateMessages,
        currentMessages: currentStreamMessages,
        regenerateMessages: originalMessages,
        isRegenerate: true,
      }).map(({ messageId }) => messageId),
    ).toEqual(['user-1', 'assistant-1', 'user-2']);
  });

  it('keeps the existing non-regenerate abort rollback behavior', () => {
    const submissionMessages = [message('user-1')];
    const currentMessages = [message('user-1'), message('assistant-1')];

    expect(
      getExistingConversationAbortMessages({
        messages: submissionMessages,
        currentMessages,
      }).map(({ messageId }) => messageId),
    ).toEqual(['user-1']);
  });
});

describe('mergeErrorMessages', () => {
  const message = (messageId: string, isCreatedByUser = false) =>
    ({
      messageId,
      conversationId: 'conversation-1',
      isCreatedByUser,
      text: messageId,
    }) as TMessage;

  it('adds the request and error for a normal submission', () => {
    const userMessage = message('user-1', true);
    const errorMessage = message('assistant-error');

    expect(
      mergeErrorMessages({
        messages: [message('previous-response')],
        userMessage,
        errorMessage,
      }).map(({ messageId }) => messageId),
    ).toEqual(['previous-response', 'user-1', 'assistant-error']);
  });

  it('preserves regeneration history without duplicating its user', () => {
    const userMessage = message('user-1', true);
    const originalResponse = message('assistant-1');
    const laterUser = message('user-2', true);
    const laterResponse = message('assistant-2');
    const errorMessage = message('assistant-1_');

    expect(
      mergeErrorMessages({
        messages: [userMessage],
        regenerateMessages: [userMessage, originalResponse, laterUser, laterResponse],
        userMessage,
        errorMessage,
        isRegenerate: true,
      }).map(({ messageId }) => messageId),
    ).toEqual(['user-1', 'assistant-1', 'user-2', 'assistant-2', 'assistant-1_']);
  });

  it('replaces an edited response error that intentionally reuses its id', () => {
    const userMessage = message('user-1', true);
    const originalResponse = message('assistant-1');
    const errorMessage = { ...originalResponse, text: 'Regeneration failed', error: true };

    const merged = mergeErrorMessages({
      messages: [userMessage],
      regenerateMessages: [userMessage, originalResponse],
      userMessage,
      errorMessage,
      isRegenerate: true,
    });

    expect(merged.map(({ messageId }) => messageId)).toEqual(['user-1', 'assistant-1']);
    expect(merged[1]).toEqual(errorMessage);
  });
});

describe('keepLocalCodeApprovalMode', () => {
  const server = { conversationId: 'conversation-1', codeApprovalMode: 'ask' } as TConversation;
  const local = {
    conversationId: 'conversation-1',
    codeApprovalMode: 'acceptEdits',
  } as TConversation;

  it('keeps a locally picked mode over the server copy', () => {
    expect(keepLocalCodeApprovalMode(server, local, 'conversation-1').codeApprovalMode).toBe(
      'acceptEdits',
    );
  });

  it('lets the server copy win when nothing was picked locally', () => {
    const unset = { conversationId: 'conversation-1' } as TConversation;
    expect(keepLocalCodeApprovalMode(server, unset, 'conversation-1')).toBe(server);
    expect(keepLocalCodeApprovalMode(server, null, 'conversation-1')).toBe(server);
  });

  it('ignores the mode of a conversation the user navigated to mid-run', () => {
    const elsewhere = { conversationId: 'conversation-2', codeApprovalMode: 'fullAccess' };
    expect(keepLocalCodeApprovalMode(server, elsewhere as TConversation, 'conversation-1')).toBe(
      server,
    );
  });

  it('follows a new chat to the id the server assigned', () => {
    const assigned = { conversationId: 'server-id', codeApprovalMode: 'acceptEdits' };
    expect(
      keepLocalCodeApprovalMode(
        { conversationId: 'server-id' } as TConversation,
        assigned as TConversation,
        'server-id',
      ).codeApprovalMode,
    ).toBe('acceptEdits');
    expect(keepLocalCodeApprovalMode(server, assigned as TConversation, Constants.NEW_CONVO)).toBe(
      server,
    );
  });
});

describe('buildRecoveryPreset', () => {
  const sent = {
    conversationId: 'conversation-1',
    endpoint: 'agents',
    agent_id: 'agent-1',
    codeApprovalMode: 'ask',
  } as TConversation;

  it('carries the mode the detail cache holds for the rebuilt conversation', () => {
    const cached = { ...sent, codeApprovalMode: 'acceptEdits' } as TConversation;
    const preset = buildRecoveryPreset(sent, cached, 'conversation-1');
    expect(preset.codeApprovalMode).toBe('acceptEdits');
    expect(preset.agent_id).toBe('agent-1');
  });

  it('falls back to the sent mode when no record exists', () => {
    expect(buildRecoveryPreset(sent, undefined, '_fresh').codeApprovalMode).toBe('ask');
  });
});

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

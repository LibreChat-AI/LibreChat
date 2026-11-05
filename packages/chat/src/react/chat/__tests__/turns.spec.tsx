/**
 * @jest-environment jsdom
 */
import React from 'react';
import { createStore, Provider } from 'jotai';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  QueryKeys,
  Constants,
  Providers,
  EModelEndpoint,
  CODE_ENVIRONMENT_DECISION_VERSION,
} from 'librechat-data-provider';
import type { Agent, TMessage, TSubmission, TConversation } from 'librechat-data-provider';
import type { ChatTurnsParams, TurnServices } from '../host';
import type { ExtendedFile } from '../../../core';
import {
  getReasoningStateKey,
  pendingQuotesByConvoId,
  pendingManualSkillsByConvoId,
  pendingReasoningOverrideFamily,
} from '../../composer';
import {
  submissionStartFamily,
  showStopButtonByIndex,
  launchedConversationFamily,
} from '../../generation';
import { createTurnServices, createTurnCodeInputs } from '../__fixtures__/services';
import { siblingIdxFamily, siblingKey } from '../../thread';
import { activeUsageResponseIdFamily } from '../../usage';
import { isSubmittingFamily } from '../../submission';
import { useTurns } from '../turns';

const conversationId = 'conversation-1';

const user: TMessage = {
  messageId: 'user-1',
  parentMessageId: Constants.NO_PARENT as string,
  conversationId,
  text: 'Hello',
  sender: 'User',
  isCreatedByUser: true,
  manualSkills: ['skill-a'],
  quotes: ['quote-a'],
};

const response: TMessage = {
  messageId: 'response-1',
  parentMessageId: 'user-1',
  conversationId,
  text: 'Hi',
  sender: 'Assistant',
  isCreatedByUser: false,
  createdAt: '2026-10-28T00:00:00.000Z',
};

const agentsConversation: TConversation = {
  conversationId,
  endpoint: EModelEndpoint.agents,
  agent_id: 'agent-1',
  title: null,
  createdAt: '2026-10-28T00:00:00.000Z',
  updatedAt: '2026-10-28T00:00:00.000Z',
};

const reasoning = { key: 'reasoning_effort', value: 'high' } as NonNullable<
  TMessage['reasoningOverride']
>;

function setup({
  conversation = agentsConversation,
  messages = [user, response] as TMessage[] | null,
  latestMessage = response,
  files = new Map<string, ExtendedFile>(),
  services = createTurnServices(),
  agent,
  isSubmitting = false,
  revalidating = false,
}: {
  conversation?: TConversation | null;
  /** `null` stands for history that has not loaded. */
  messages?: TMessage[] | null;
  latestMessage?: TMessage | null;
  files?: Map<string, ExtendedFile>;
  services?: TurnServices;
  /** The saved agent cached for the conversation's `agent_id`. */
  agent?: Partial<Agent>;
  isSubmitting?: boolean;
  /** The cached history is mid-refetch and older than a locally written tail. */
  revalidating?: boolean;
} = {}) {
  const store = createStore();
  const queryClient = new QueryClient();
  if (agent != null) {
    queryClient.setQueryData([QueryKeys.agent, conversation?.agent_id], agent);
  }
  if (revalidating) {
    const key = [QueryKeys.messages, conversationId];
    queryClient.setQueryData(key, messages ?? [], { updatedAt: Date.now() - 60_000 });
    void queryClient.invalidateQueries({ queryKey: key, refetchType: 'none' });
    const query = queryClient.getQueryCache().find(key);
    query?.setState({ fetchStatus: 'fetching' });
  }
  let submission: TSubmission | null = null;
  let current = conversation;
  const written: TMessage[][] = [];
  const params: ChatTurnsParams = {
    index: 0,
    files,
    setFiles: jest.fn(),
    getMessages: () => messages ?? undefined,
    setMessages: (next) => written.push(next),
    isSubmitting,
    conversation,
    latestMessage,
    setSubmission: (next) => {
      submission = typeof next === 'function' ? next(submission) : next;
    },
    setConversation: (next) => {
      current = typeof next === 'function' ? next(current) : next;
    },
  };
  const { result } = renderHook(() => useTurns(params, services), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <Provider store={store}>{children}</Provider>
      </QueryClientProvider>
    ),
  });
  return {
    store,
    params,
    services,
    written,
    turns: result.current,
    submission: () => submission,
    conversation: () => current,
  };
}

describe('useTurns', () => {
  it('publishes the turn and marks the pane submitting', () => {
    const chat = setup();

    expect(chat.turns.ask({ text: '  Next  ' })).toBeUndefined();

    const submission = chat.submission();
    expect(submission?.userMessage).toMatchObject({ text: 'Next', parentMessageId: 'response-1' });
    expect(chat.written).toHaveLength(1);
    expect(chat.written[0].map((message) => message.messageId)).toEqual([
      'user-1',
      'response-1',
      submission?.userMessage.messageId,
      submission?.initialResponse?.messageId,
    ]);
    expect(chat.store.get(isSubmittingFamily(0))).toBe(true);
    expect(chat.store.get(activeUsageResponseIdFamily(conversationId))).toBe(
      submission?.initialResponse?.messageId,
    );
    expect(chat.store.get(launchedConversationFamily(0))).toBe(submission?.conversation);
  });

  it('leaves all turn state untouched until the host permits the send', () => {
    const canSubmit = jest.fn(() => false);
    const readCodeInputs = jest.fn(() => createTurnCodeInputs());
    const getRouteProjectId = jest.fn(() => null);
    const files = new Map<string, ExtendedFile>([
      ['temp-1', { file_id: 'file-1', temp_file_id: 'temp-1', progress: 1, size: 1 }],
    ]);
    const chat = setup({
      files,
      services: createTurnServices({ canSubmit, readCodeInputs, getRouteProjectId }),
      agent: { provider: EModelEndpoint.openAI, model: 'gpt-5' },
    });
    const reasoningKey = getReasoningStateKey(conversationId, 0);
    chat.store.set(pendingManualSkillsByConvoId(conversationId), ['queued-skill']);
    chat.store.set(pendingQuotesByConvoId(conversationId), ['queued-quote']);
    chat.store.set(pendingReasoningOverrideFamily(reasoningKey), reasoning);
    chat.store.set(showStopButtonByIndex(0), true);
    const start = chat.store.get(submissionStartFamily(0));
    const launched = chat.store.get(launchedConversationFamily(0));
    const activeUsage = chat.store.get(activeUsageResponseIdFamily(conversationId));
    const cacheWrites = jest.fn();
    const stopObserving = chat.store.sub(launchedConversationFamily(0), cacheWrites);

    expect(chat.turns.ask({ text: 'Next' })).toBe(false);
    expect(canSubmit).toHaveBeenCalledWith(agentsConversation);
    expect(readCodeInputs).not.toHaveBeenCalled();
    expect(getRouteProjectId).not.toHaveBeenCalled();
    expect(chat.submission()).toBeNull();
    expect(chat.conversation()).toBe(agentsConversation);
    expect(chat.written).toEqual([]);
    expect(cacheWrites).not.toHaveBeenCalled();
    expect(chat.services.openNewChat).not.toHaveBeenCalled();
    expect(chat.services.releaseFiles).not.toHaveBeenCalled();
    expect(chat.services.clearFilesToDelete).not.toHaveBeenCalled();
    expect(chat.params.setFiles).not.toHaveBeenCalled();
    expect(chat.store.get(isSubmittingFamily(0))).toBe(false);
    expect(chat.store.get(showStopButtonByIndex(0))).toBe(true);
    expect(chat.store.get(submissionStartFamily(0))).toBe(start);
    expect(chat.store.get(launchedConversationFamily(0))).toBe(launched);
    expect(chat.store.get(activeUsageResponseIdFamily(conversationId))).toBe(activeUsage);
    expect(chat.store.get(pendingManualSkillsByConvoId(conversationId))).toEqual(['queued-skill']);
    expect(chat.store.get(pendingQuotesByConvoId(conversationId))).toEqual(['queued-quote']);
    expect(chat.store.get(pendingReasoningOverrideFamily(reasoningKey))).toEqual(reasoning);

    canSubmit.mockReturnValue(true);
    expect(chat.turns.ask({ text: 'Next' })).toBeUndefined();
    expect(readCodeInputs).toHaveBeenCalledTimes(1);
    expect(chat.written).toHaveLength(1);
    expect(chat.submission()?.userMessage).toMatchObject({
      text: 'Next',
      manualSkills: ['queued-skill'],
      quotes: ['queued-quote'],
      reasoningOverride: reasoning,
    });
    expect(chat.store.get(isSubmittingFamily(0))).toBe(true);
    expect(chat.services.releaseFiles).toHaveBeenCalled();
    expect(chat.services.clearFilesToDelete).toHaveBeenCalled();
    stopObserving();
  });

  it('refuses a second send inside the same task', () => {
    const chat = setup();

    chat.turns.ask({ text: 'first' });

    expect(chat.turns.ask({ text: 'second' })).toBe(false);
    expect(chat.written).toHaveLength(1);
  });

  it.each<[string, Parameters<typeof setup>[0]]>([
    ['while submitting', { isSubmitting: true }],
    ['before the history loads', { messages: null }],
    ['while the history revalidates', { revalidating: true }],
    [
      'while a code workspace recovery is pending',
      {
        services: createTurnServices({
          readCodeInputs: () => createTurnCodeInputs({ recoveryPending: true }),
        }),
      },
    ],
    [
      'onto a preliminary response',
      { latestMessage: { ...response, messageId: 'pending_', createdAt: undefined } },
    ],
  ])('refuses to send %s', (_label, options) => {
    const chat = setup(options);

    expect(chat.turns.ask({ text: 'Next' })).toBe(false);
    expect(chat.submission()).toBeNull();
    expect(chat.written).toHaveLength(0);
  });

  it('refuses an empty draft but sends attached files alone', () => {
    const files = new Map<string, ExtendedFile>([
      ['temp-1', { file_id: 'file-1', temp_file_id: 'temp-1', progress: 1, size: 1 }],
    ]);
    expect(setup().turns.ask({ text: '   ' })).toBe(false);

    const chat = setup({ files });
    chat.turns.ask({ text: '' });

    expect(chat.submission()?.userMessage.files).toEqual([
      expect.objectContaining({ file_id: 'file-1' }),
    ]);
    expect(chat.services.releaseFiles).toHaveBeenCalledWith(['temp-1', 'file-1', 'temp-1']);
    expect(chat.params.setFiles).toHaveBeenCalledWith(new Map());
    expect(chat.services.clearFilesToDelete).toHaveBeenCalled();
  });

  it('drains queued skills, quotes and reasoning into a fresh send', () => {
    // A saved OpenAI agent on a reasoning model, whose effort control accepts "high".
    const chat = setup({ agent: { provider: EModelEndpoint.openAI, model: 'gpt-5' } });
    const reasoningKey = getReasoningStateKey(conversationId, 0);
    chat.store.set(pendingManualSkillsByConvoId(conversationId), ['skill-b']);
    chat.store.set(pendingQuotesByConvoId(conversationId), ['quote-b']);
    chat.store.set(pendingReasoningOverrideFamily(reasoningKey), reasoning);

    chat.turns.ask({ text: 'Next' });

    expect(chat.submission()?.userMessage).toMatchObject({
      manualSkills: ['skill-b'],
      quotes: ['quote-b'],
      reasoningOverride: reasoning,
    });
    expect(chat.store.get(pendingManualSkillsByConvoId(conversationId))).toEqual([]);
    expect(chat.store.get(pendingQuotesByConvoId(conversationId))).toEqual([]);
    expect(chat.store.get(pendingReasoningOverrideFamily(reasoningKey))).toBeUndefined();
  });

  it('puts a drained reasoning choice back when the capabilities are not known yet', () => {
    // An OpenRouter-style custom endpoint whose per-model efforts were never fetched.
    const chat = setup({
      conversation: {
        ...agentsConversation,
        endpoint: EModelEndpoint.custom,
        model: 'openai/gpt-5',
      },
      services: createTurnServices({
        getEndpointsConfig: () => ({
          [EModelEndpoint.custom]: {
            type: EModelEndpoint.custom,
            userProvide: false,
            order: 0,
            customParams: { defaultParamsEndpoint: Providers.OPENROUTER },
          },
        }),
      }),
    });
    const reasoningKey = getReasoningStateKey(conversationId, 0);
    chat.store.set(pendingReasoningOverrideFamily(reasoningKey), reasoning);

    chat.turns.ask({ text: 'Next' });

    expect(chat.submission()?.userMessage.reasoningOverride).toBeUndefined();
    expect(chat.store.get(pendingReasoningOverrideFamily(reasoningKey))).toEqual(reasoning);
  });

  it('keeps queued quotes out of an Assistants send', () => {
    const chat = setup({
      conversation: {
        ...agentsConversation,
        endpoint: EModelEndpoint.assistants,
        assistant_id: 'a',
      },
    });
    chat.store.set(pendingQuotesByConvoId(conversationId), ['quote-b']);

    chat.turns.ask({ text: 'Next' });

    expect(chat.submission()?.userMessage.quotes).toBeUndefined();
    expect(chat.store.get(pendingQuotesByConvoId(conversationId))).toEqual(['quote-b']);
    expect(chat.store.get(isSubmittingFamily(0))).toBe(false);
  });

  it('opens the new-chat route for a send that starts a chat', () => {
    const conversation = { ...agentsConversation, conversationId: Constants.NEW_CONVO as string };
    const chat = setup({
      conversation,
      messages: [],
      latestMessage: null,
      services: createTurnServices({ getRouteProjectId: () => 'a'.repeat(24) }),
    });

    chat.turns.ask({ text: 'Hello' });

    expect(chat.services.openNewChat).toHaveBeenCalledWith(`/c/new?projectId=${'a'.repeat(24)}`);
    expect(chat.submission()?.conversation.chatProjectId).toBe('a'.repeat(24));
  });

  it('records the submitted code decision on the pane conversation', () => {
    const chat = setup({
      services: createTurnServices({
        // The agent's metadata is unknown, so a workspace is required; the chat runs without one.
        readCodeInputs: () =>
          createTurnCodeInputs(
            {
              conversation: { ...agentsConversation, agent_id: 'agent_saved' },
              canRunCode: true,
              capabilities: ['execute_code', 'stateful_code_sessions'],
              startupConfig: { codeEnvironmentDecisionVersion: CODE_ENVIRONMENT_DECISION_VERSION },
            },
            { ...agentsConversation, codeEnvironmentMode: 'without_attached' },
          ),
      }),
    });

    chat.turns.ask({ text: 'Next' });

    expect(chat.conversation()?.codeEnvironmentMode).toBe('without_attached');
  });

  it('regenerates a response with the replayed user message and focuses it', () => {
    const chat = setup();
    chat.store.set(pendingManualSkillsByConvoId(conversationId), ['queued']);
    /** An older sibling is on screen: the regeneration must bring the new one into view. */
    chat.store.set(siblingIdxFamily(siblingKey('user-1')), 1);

    chat.turns.regenerate(response);

    expect(chat.submission()).toMatchObject({
      isRegenerate: true,
      userMessage: {
        text: 'Hello',
        overrideParentMessageId: 'user-1',
        manualSkills: ['skill-a'],
        quotes: ['quote-a'],
      },
    });
    expect(chat.written[0].map((message) => message.messageId)).toEqual(['user-1', 'response-1_']);
    expect(chat.store.get(siblingIdxFamily(siblingKey('user-1')))).toBe(0);
    expect(chat.store.get(pendingManualSkillsByConvoId(conversationId))).toEqual(['queued']);
  });
});

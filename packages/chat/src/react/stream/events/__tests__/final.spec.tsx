/**
 * @jest-environment jsdom
 */
import { useState } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { Constants, createPayload, EModelEndpoint, QueryKeys } from 'librechat-data-provider';
import type { EventSubmission, TConversation, TMessage } from 'librechat-data-provider';
import type { EventHandlerContext } from '../context';
import { buildMinimalResumeSubmission, buildTurn } from '../../../../core';
import { createEventServices } from '../../__fixtures__/events';
import useFinalHandler from '../final';

const original = {
  conversationId: 'saved',
  endpoint: 'Provider A' as EModelEndpoint,
  endpointType: EModelEndpoint.custom,
  model: 'model-a',
  spec: 'spec-a',
  iconURL: '/a.svg',
  modelLabel: 'Model A',
  promptPrefix: 'Instructions A',
  temperature: 0.2,
  title: 'New Chat',
  createdAt: '2026-11-21T12:00:00Z',
  updatedAt: '2026-11-21T12:00:00Z',
} satisfies TConversation;

const selection = {
  endpoint: 'Provider B' as EModelEndpoint,
  endpointType: EModelEndpoint.custom,
  model: 'model-b',
  spec: 'spec-b',
  iconURL: '/b.svg',
  modelLabel: 'Model B',
  promptPrefix: 'Instructions B',
  temperature: 0.7,
};

const request: TMessage = {
  messageId: 'request',
  parentMessageId: 'previous',
  conversationId: original.conversationId,
  text: 'Hello',
  sender: 'User',
  isCreatedByUser: true,
};
const response: TMessage = {
  messageId: 'response',
  parentMessageId: request.messageId,
  conversationId: original.conversationId,
  text: 'Reply from A',
  model: original.model,
  sender: 'Assistant',
  isCreatedByUser: false,
};
const server = {
  ...original,
  title: 'Generated title',
  messages: [request.messageId, response.messageId],
  lastResponseAt: '2026-11-21T12:01:00Z',
  lastResponseMessageId: response.messageId,
};
const submission: EventSubmission = {
  conversation: original,
  endpointOption: { endpoint: original.endpoint },
  userMessage: request,
  initialResponse: { ...response, text: '' },
  messages: [],
  isTemporary: false,
};
const finalFrame = { conversation: server, requestMessage: request, responseMessage: response };

function setup(initial = original as TConversation) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { cacheTime: Infinity } } });
  const setMessages = jest.fn();
  const services = createEventServices();
  const context: EventHandlerContext = {
    queryClient,
    services,
    setMessages,
    getMessages: () => [request, submission.initialResponse],
    runIndex: 0,
    isAddedRequest: false,
    setCompleted: jest.fn(),
    setIsSubmitting: jest.fn(),
    setShowStopButton: jest.fn(),
    setSubmissionStart: jest.fn(),
    lastAnnouncementTimeRef: { current: 0 },
    restorePendingContext: jest.fn(),
    reconcileFailedCodeDecision: jest.fn(),
    recoverConversation: jest.fn(),
    attachmentHandler: jest.fn(),
    preserveSubagentAtomsForNewConvoIdRef: { current: null },
  };
  const hook = renderHook(() => {
    const [conversation, setConversation] = useState<TConversation | null>(initial);
    const finish = useFinalHandler({ ...context, setConversation });
    return { conversation, setConversation, finish };
  });
  return { ...hook, setMessages, queryClient };
}

it.each(['original submission', 'reattached stream'])(
  'keeps the next target coherent after finalizing the %s',
  (origin) => {
    const { result, setMessages, queryClient } = setup();
    act(() => result.current.setConversation({ ...original, ...selection }));

    const completed =
      origin === 'reattached stream'
        ? {
            ...buildMinimalResumeSubmission({
              messages: [],
              streamId: original.conversationId,
              conversationId: original.conversationId,
              isTemporary: false,
              generationProtocolVersion: 1,
            }),
            initialResponse: submission.initialResponse,
          }
        : submission;
    act(() => result.current.finish(finalFrame, completed));

    expect(result.current.conversation).toMatchObject({
      ...selection,
      title: server.title,
      messages: server.messages,
      lastResponseAt: server.lastResponseAt,
      lastResponseMessageId: server.lastResponseMessageId,
    });
    expect(setMessages).toHaveBeenCalledWith([request, response]);
    expect(
      queryClient.getQueryData([QueryKeys.conversation, original.conversationId]),
    ).toMatchObject(server);

    const next = buildTurn({
      conversation: result.current.conversation,
      conversationId: original.conversationId,
      latestMessage: response,
      text: 'Next question',
      params: { text: 'Next question' },
      options: {},
      endpointsConfig: { [selection.endpoint]: { type: EModelEndpoint.custom, order: 0 } },
      canClearFiles: false,
      routeProjectId: null,
      isTemporary: false,
      ephemeralAgent: null,
      getSender: () => 'Assistant',
      userKey: undefined,
      manualSkills: [],
      quotes: [],
      reasoningOverride: undefined,
      code: { approvalMode: undefined, environmentMode: undefined, workspaces: undefined },
    });
    expect(createPayload(next.submission).payload).toMatchObject({
      endpoint: selection.endpoint,
      model: selection.model,
      spec: selection.spec,
      promptPrefix: selection.promptPrefix,
    });
  },
);

it.each([
  { spec: 'same-model-other-spec' },
  { spec: null, iconURL: null, modelLabel: null },
  { endpoint: selection.endpoint },
  { endpoint: EModelEndpoint.agents, agent_id: 'agent-b', model: undefined, spec: null },
])('preserves a switch even when the model string does not identify it: %j', (target) => {
  const { result } = setup();
  act(() => result.current.setConversation({ ...original, ...target }));
  act(() => result.current.finish(finalFrame, submission));
  expect(result.current.conversation).toMatchObject({ ...original, ...server, ...target });
});

it('accepts the server target when the local selection has not changed', () => {
  const { result } = setup();
  act(() =>
    result.current.finish({ ...finalFrame, conversation: { ...server, ...selection } }, submission),
  );
  expect(result.current.conversation).toEqual({
    ...server,
    ...selection,
    titleSetByUser: undefined,
    titleRevision: undefined,
  });
});

it('keeps the selection when finalizing the first turn assigns its conversation id', () => {
  const draft = { ...original, conversationId: String(Constants.NEW_CONVO) };
  const { result } = setup({ ...draft, ...selection });
  act(() =>
    result.current.finish(finalFrame, {
      ...submission,
      conversation: { ...draft, conversationId: null },
      userMessage: {
        ...request,
        parentMessageId: String(Constants.NO_PARENT),
        conversationId: null,
      },
    }),
  );
  expect(result.current.conversation).toMatchObject({
    ...selection,
    conversationId: server.conversationId,
  });
});

it('does not replace another conversation or borrow its target', () => {
  const other = { ...original, ...selection, conversationId: 'other' };
  const { result, queryClient } = setup(other);
  act(() => result.current.finish(finalFrame, submission));
  expect(result.current.conversation).toBe(other);
  expect(queryClient.getQueryData([QueryKeys.conversation, original.conversationId])).toMatchObject(
    server,
  );
});

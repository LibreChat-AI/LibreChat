/**
 * @jest-environment jsdom
 */
import { getDefaultStore } from 'jotai';
import { QueryClient } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { ContentTypes, Constants, EModelEndpoint } from 'librechat-data-provider';
import type { TMessage, TSubmission, EventSubmission } from 'librechat-data-provider';
import type { EventHandlerContext } from '../context';
import type { EventServices } from '../../services';
import { createEventServices } from '../../__fixtures__/events';
import { submissionByIndex } from '../../../submission';
import useAbortHandlers from '../abort';

const conversationId = 'b5d5b1c6-4f2e-4d7a-9b77-0d3c8a6a2f10';
const NEW_CONVO = Constants.NEW_CONVO as string;
const request: TMessage = {
  messageId: 'request',
  parentMessageId: Constants.NO_PARENT as string,
  conversationId,
  text: 'Tell me a story',
  sender: 'User',
  isCreatedByUser: true,
};
const response: TMessage = {
  messageId: 'response',
  parentMessageId: request.messageId,
  conversationId,
  text: '',
  content: [{ type: ContentTypes.TEXT, text: 'Once upon a time' }],
  sender: 'Assistant',
  isCreatedByUser: false,
};
const submission: EventSubmission = {
  conversation: { conversationId: NEW_CONVO, endpoint: EModelEndpoint.assistants },
  endpointOption: { endpoint: EModelEndpoint.assistants },
  userMessage: request,
  initialResponse: { ...response, content: [] },
  messages: [],
  isTemporary: false,
};

/** The slice of a fetch `Response` the stop reads; this test environment has no `Response`. */
const answer = (status: number, type: string, body?: unknown) =>
  ({
    status,
    statusText: status === 500 ? 'Internal Server Error' : 'OK',
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? type : null) },
    json: async () => body,
  }) as Response;

const failures: Array<[string, () => Promise<Response>]> = [
  ['answers with an error', async () => answer(500, 'text/html; charset=utf-8')],
  [
    'never reaches the server',
    async () => {
      throw new TypeError('Failed to fetch');
    },
  ],
];

/** The Assistants stop, as the pane's stream calls it when it closes on a run. */
function setup(stop: () => Promise<Response>, shows: boolean) {
  const base = createEventServices();
  const services: EventServices = {
    ...base,
    navigation: { ...base.navigation, shows: jest.fn(() => shows) },
    transport: { abortRun: jest.fn(stop) },
  };
  const context: EventHandlerContext = {
    queryClient: new QueryClient(),
    services,
    setMessages: jest.fn(),
    getMessages: () => [request, response],
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
  const finalHandler = jest.fn();
  const { result } = renderHook(() => useAbortHandlers(context, finalHandler));
  const abort = (id: string) =>
    act(() => result.current.abortConversation(id, submission, [request, response]));
  return { abort, context, services, finalHandler };
}

describe('an Assistants stop that fails', () => {
  afterEach(() => {
    getDefaultStore().set(submissionByIndex(0), null);
  });

  it.each(failures)(
    'settles a pane that has moved on and writes nothing to it when the stop %s',
    async (_, stop) => {
      const { abort, context, services, finalHandler } = setup(stop, false);
      await abort(conversationId);

      expect(services.navigation.shows).toHaveBeenCalledWith(conversationId);
      expect(context.setMessages).not.toHaveBeenCalled();
      expect(context.recoverConversation).not.toHaveBeenCalled();
      expect(finalHandler).not.toHaveBeenCalled();
      expect(context.setShowStopButton).toHaveBeenCalledWith(false);
      expect(context.setIsSubmitting).toHaveBeenLastCalledWith(false);
    },
  );

  it.each(failures)(
    'keeps what streamed and adds the failure while the pane still shows the run, when the stop %s',
    async (_, stop) => {
      const { abort, context } = setup(stop, true);
      await abort(conversationId);

      const [written] = (context.setMessages as jest.Mock).mock.calls[0] as [TMessage[]];
      expect(written.map((message) => message.messageId)).toEqual(['request', 'response']);
      expect(written[1].content?.[0]).toEqual(response.content?.[0]);
      expect(written[1].content?.[1]).toMatchObject({ type: ContentTypes.ERROR });
      expect(context.recoverConversation).toHaveBeenCalledWith(conversationId, submission);
      expect(context.setIsSubmitting).toHaveBeenLastCalledWith(false);
    },
  );

  it('leaves the controls of a run the pane started since to that run', async () => {
    const resumed = { conversation: { conversationId: 'other' } } as TSubmission;
    getDefaultStore().set(submissionByIndex(0), resumed);
    const { abort, context } = setup(failures[0][1], false);
    await abort(conversationId);

    expect(context.setIsSubmitting).not.toHaveBeenCalled();
    expect(context.setShowStopButton).not.toHaveBeenCalled();
    expect(context.setMessages).not.toHaveBeenCalled();
    expect(context.recoverConversation).not.toHaveBeenCalled();
  });

  it('recovers a run the server never named, which no pane can be told apart by', async () => {
    const { abort, context, services } = setup(failures[0][1], false);
    await abort(NEW_CONVO);

    expect(services.navigation.shows).not.toHaveBeenCalled();
    expect(context.recoverConversation).toHaveBeenCalledWith(NEW_CONVO, submission);
    expect(context.setIsSubmitting).toHaveBeenLastCalledWith(false);
  });

  it('settles from the final answer of a stop that succeeds, wherever the pane is', async () => {
    const final = { final: true, conversation: { conversationId }, runMessages: [] };
    const { abort, context, services, finalHandler } = setup(
      async () => answer(200, 'application/json; charset=utf-8', final),
      false,
    );
    await abort(conversationId);

    expect(finalHandler).toHaveBeenCalledWith(final, submission);
    expect(services.navigation.shows).not.toHaveBeenCalled();
    expect(context.setMessages).not.toHaveBeenCalled();
  });
});

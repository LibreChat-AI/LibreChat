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

const JSON_TYPE = 'application/json; charset=utf-8';
const statusTexts: Record<number, string> = {
  200: 'OK',
  401: 'Unauthorized',
  403: 'Forbidden',
  409: 'Conflict',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/** The slice of a fetch `Response` the stop reads; this test environment has no `Response`. */
const answer = (status: number, type: string, body?: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: statusTexts[status] ?? '',
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? type : null) },
    json: async () => body,
  }) as Response;

/** How the stop fails, and the failure the turn then shows. */
const failures: Array<[string, () => Promise<Response>, string]> = [
  [
    'answers with an error',
    async () => answer(500, 'text/html; charset=utf-8'),
    'Unexpected response from server; Status: 500 Internal Server Error',
  ],
  /** The stop route's JSON refusals of a named run: a lapsed session, a banned account, an
   *  account being deleted. Their bodies are errors, never the turn's messages. */
  [
    'is refused for a lapsed session',
    async () => answer(401, JSON_TYPE, { message: 'Unauthorized' }),
    'Unexpected response from server; Status: 401 Unauthorized',
  ],
  [
    'is refused for a banned account',
    async () =>
      answer(403, JSON_TYPE, {
        message: 'Your account has been temporarily banned due to violations of our service.',
      }),
    'Unexpected response from server; Status: 403 Forbidden',
  ],
  [
    'is refused while the account is being deleted',
    async () =>
      answer(409, JSON_TYPE, {
        message: 'Account deletion is in progress',
        code: 'ACCOUNT_DELETION_IN_PROGRESS',
      }),
    'Unexpected response from server; Status: 409 Conflict',
  ],
  [
    'is refused when the server cannot admit it',
    async () =>
      answer(503, JSON_TYPE, {
        message: 'Generation admission could not be verified',
        code: 'GENERATION_ADMISSION_UNAVAILABLE',
      }),
    'Unexpected response from server; Status: 503 Service Unavailable',
  ],
  [
    'never reaches the server',
    async () => {
      throw new TypeError('Failed to fetch');
    },
    'Failed to fetch',
  ],
];

/** The Assistants stop, as the pane's stream calls it when it closes on a run showing `shown`. */
function setup(
  stop: () => Promise<Response>,
  shows: boolean,
  shown: TMessage[] = [request, response],
) {
  const base = createEventServices();
  const services: EventServices = {
    ...base,
    navigation: { ...base.navigation, shows: jest.fn(() => shows) },
    transport: { abortRun: jest.fn(stop) },
  };
  /** The pane reads back what was last written to it. */
  let messages = shown;
  const context: EventHandlerContext = {
    queryClient: new QueryClient(),
    services,
    setMessages: jest.fn((next: TMessage[]) => {
      messages = next;
    }),
    getMessages: () => messages,
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
  const abort = (id: string) => act(() => result.current.abortConversation(id, submission, shown));
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
    async (_, stop, failure) => {
      const { abort, context } = setup(stop, true);
      await abort(conversationId);

      expect(context.setMessages).toHaveBeenCalledTimes(1);
      const [written] = (context.setMessages as jest.Mock).mock.calls[0] as [TMessage[]];
      expect(written.map((message) => message.messageId)).toEqual(['request', 'response']);
      expect(written[1].content).toEqual([
        response.content?.[0],
        { type: ContentTypes.ERROR, error: failure },
      ]);
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

  /** Stop is offered once the server names the run, so a run it never named was stopped by
   *  leaving it: for a new chat, or for another chat. */
  it.each(['', NEW_CONVO])(
    'settles a run the server never named (%j) without writing to the pane or opening a chat',
    async (id) => {
      const { abort, context, services, finalHandler } = setup(
        async () => answer(400, JSON_TYPE, { message: 'Invalid conversationId' }),
        true,
        [request, submission.initialResponse],
      );
      await abort(id);

      expect(services.transport.abortRun).toHaveBeenCalledWith({
        endpoint: EModelEndpoint.assistants,
        abortKey: `${id}:${submission.initialResponse.messageId}`,
      });
      expect(services.navigation.shows).not.toHaveBeenCalled();
      expect(context.setMessages).not.toHaveBeenCalled();
      expect(context.recoverConversation).not.toHaveBeenCalled();
      expect(finalHandler).not.toHaveBeenCalled();
      expect(context.setShowStopButton).toHaveBeenCalledWith(false);
      expect(context.setIsSubmitting).toHaveBeenLastCalledWith(false);
    },
  );

  it('settles from the final answer of a stop that succeeds, wherever the pane is', async () => {
    const final = { final: true, conversation: { conversationId }, runMessages: [] };
    const { abort, context, services, finalHandler } = setup(
      async () => answer(200, JSON_TYPE, final),
      false,
    );
    await abort(conversationId);

    expect(finalHandler).toHaveBeenCalledWith(final, submission);
    expect(services.navigation.shows).not.toHaveBeenCalled();
    expect(context.setMessages).not.toHaveBeenCalled();
  });
});

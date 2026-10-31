/**
 * @jest-environment jsdom
 */
import React from 'react';
import { getDefaultStore } from 'jotai';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  TMessage,
  ChatEvent,
  ChatFrame,
  TSubmission,
  ChatTransport,
} from 'librechat-data-provider';
import type { LegacyStreamServices } from '../services';
import type { StreamHost } from '../host';
import {
  removeUsageAtoms,
  liveTokensFamily,
  branchTotalsFamily,
  pendingUsageFamily,
  activeUsageResponseIdFamily,
} from '../../usage';
import { normalizeFrame } from '../../../core/transport/frames';
import { createEventServices } from '../__fixtures__/events';
import { StreamHostProvider } from '../host';
import { useLegacyStream } from '../legacy';

const mockSyncHandler = jest.fn();
const mockFinalHandler = jest.fn();
const mockContentHandler = jest.fn();
const mockErrorHandler = jest.fn();
const mockAbortConversation = jest.fn(async () => undefined);

jest.mock('../events/handlers', () => ({
  useEventHandlers: () => ({
    errorHandler: mockErrorHandler,
    finalHandler: mockFinalHandler,
    createdHandler: jest.fn(),
    attachmentHandler: jest.fn(),
    stepHandler: jest.fn(),
    titleHandler: jest.fn(),
    contentHandler: mockContentHandler,
    syncHandler: mockSyncHandler,
    resetContentHandler: jest.fn(),
    syncStepMessage: jest.fn(),
    prunePtcTraces: jest.fn(),
    clearStepMaps: jest.fn(),
    flushPendingDeltas: jest.fn(),
    cancelPendingDeltaFlush: jest.fn(),
    abortConversation: mockAbortConversation,
    messageHandler: jest.fn(),
  }),
}));

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  createPayload: () => ({ payload: { model: 'gpt-4o' }, server: '/api/agents/chat' }),
}));

const CONV_ID = 'conv-abc-123';
let emit: (event: ChatEvent) => void = () => undefined;
const transport = {
  send: jest.fn((_request, { onEvent }: { onEvent: (event: ChatEvent) => void }) => {
    emit = onEvent;
  }),
} as unknown as ChatTransport;
const legacyServices: LegacyStreamServices = {
  transport,
  refreshBalance: jest.fn(),
  reopenTermsOnRefusal: () => null,
  clearComposerDrafts: jest.fn(),
};
const unused = (): never => {
  throw new Error('not used by the legacy stream');
};
const host: StreamHost = {
  useResumableServices: unused,
  useLegacyServices: () => legacyServices,
  useTransport: () => null,
  useQueuedTurnReceipts: unused,
  useActiveJobs: unused,
  extendActiveJobsGrace: unused,
  useStreamStatus: unused,
  useResumeSettings: unused,
  useEventServices: () => createEventServices(),
};
const queryClient = new QueryClient();
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}>
    <StreamHostProvider host={host}>{children}</StreamHostProvider>
  </QueryClientProvider>
);

const buildSubmission = (endpoint = 'agents'): TSubmission =>
  ({
    conversation: { conversationId: CONV_ID },
    userMessage: {
      messageId: 'msg-1',
      conversationId: CONV_ID,
      text: 'Hello',
      isCreatedByUser: true,
      sender: 'User',
      parentMessageId: '00000000-0000-0000-0000-000000000000',
    },
    messages: [],
    isTemporary: false,
    initialResponse: {
      messageId: 'resp-1',
      conversationId: CONV_ID,
      text: '',
      isCreatedByUser: false,
      sender: 'Assistant',
    },
    endpointOption: { endpoint },
  }) as unknown as TSubmission;

const buildChatHelpers = () => ({
  setMessages: jest.fn(),
  getMessages: jest.fn<TMessage[], []>(() => []),
  setConversation: jest.fn(),
  setIsSubmitting: jest.fn(),
  newConversation: jest.fn(),
});

const lastCall = (mock: jest.Mock) => mock.mock.calls[mock.mock.calls.length - 1];

const emitFrame = (frame: object) => {
  const event = normalizeFrame(frame as ChatFrame);
  if (event) emit(event);
};

beforeEach(() => {
  jest.clearAllMocks();
  removeUsageAtoms(CONV_ID);
});

describe('useLegacyStream', () => {
  it('binds a created response before any output or usage', async () => {
    const submission = buildSubmission();
    const { unmount } = renderHook(() => useLegacyStream(submission, buildChatHelpers()), {
      wrapper,
    });
    await act(async () => {
      emitFrame({
        created: true,
        message: { ...submission.userMessage, messageId: 'created-user-id' },
      });
    });
    const store = getDefaultStore();
    expect(store.get(activeUsageResponseIdFamily(CONV_ID))).toBe('created-user-id_');
    expect(store.get(pendingUsageFamily(CONV_ID)).eventCount).toBe(0);
    unmount();
  });

  it.each(['final', 'cancel', 'error'])(
    'keeps Assistants sync identity consistent through content, usage, and %s',
    async (terminal) => {
      const submission = buildSubmission('assistants');
      const helpers = buildChatHelpers();
      const { unmount } = renderHook(() => useLegacyStream(submission, helpers), { wrapper });
      const synced = {
        messageId: 'assistant-server-id',
        parentMessageId: 'server-user',
        conversationId: CONV_ID,
        isCreatedByUser: false,
        text: '',
      };
      await act(async () => {
        emitFrame({
          sync: true,
          requestMessage: { ...submission.userMessage, messageId: 'server-user' },
          responseMessage: synced,
        });
      });
      const store = getDefaultStore();
      expect(store.get(activeUsageResponseIdFamily(CONV_ID))).toBe(synced.messageId);
      expect(lastCall(mockSyncHandler)?.[1].initialResponse.messageId).toBe(synced.messageId);
      await act(async () => {
        emitFrame({ type: 'text', index: 0, text: { value: 'x'.repeat(400) } });
        emitFrame({
          event: 'on_token_usage',
          data: {
            input_tokens: 5,
            output_tokens: 100,
            cost: 0.01,
            runId: 'assistant-usage',
            seq: 1,
          },
        });
      });
      expect(lastCall(mockContentHandler)?.[0].submission.initialResponse.messageId).toBe(
        synced.messageId,
      );
      expect(lastCall(mockContentHandler)?.[0].submission.userMessage.messageId).toBe(
        'server-user',
      );
      expect(store.get(activeUsageResponseIdFamily(CONV_ID))).toBe(synced.messageId);
      expect(store.get(pendingUsageFamily(CONV_ID)).eventCount).toBe(1);
      helpers.getMessages.mockReturnValue([synced as TMessage]);
      if (terminal === 'final') {
        await act(async () =>
          emitFrame({
            final: true,
            responseMessage: synced,
            conversation: { conversationId: CONV_ID },
          }),
        );
        expect(lastCall(mockFinalHandler)?.[1].initialResponse.messageId).toBe(synced.messageId);
      } else if (terminal === 'cancel') {
        await act(async () => emit({ type: 'abort' }));
      } else {
        await act(async () => emit({ type: 'error', data: { message: 'Stream ended' } }));
      }
      expect(store.get(activeUsageResponseIdFamily(CONV_ID))).toBeNull();
      expect(store.get(pendingUsageFamily(CONV_ID)).eventCount).toBe(0);
      if (terminal !== 'error') {
        expect(store.get(branchTotalsFamily(CONV_ID)).tailId).toBe(synced.messageId);
        expect(store.get(branchTotalsFamily(CONV_ID)).lastTurnUsage?.output).toBe(100);
      }
      unmount();
    },
  );

  it('retains authoritative legacy text response ownership for subsequent usage events', async () => {
    const submission = buildSubmission();
    const { unmount } = renderHook(() => useLegacyStream(submission, buildChatHelpers()), {
      wrapper,
    });
    await act(async () => {
      emitFrame({
        message: true,
        messageId: 'server-text-id',
        parentMessageId: 'msg-1',
        text: 'a'.repeat(400),
      });
    });
    const store = getDefaultStore();
    expect(store.get(activeUsageResponseIdFamily(CONV_ID))).toBe('server-text-id');
    expect(store.get(liveTokensFamily(CONV_ID))).toBe(100);
    await act(async () => {
      emitFrame({
        event: 'on_token_usage',
        data: { input_tokens: 5, output_tokens: 100, runId: 'legacy-call', seq: 1 },
      });
    });
    expect(store.get(activeUsageResponseIdFamily(CONV_ID))).toBe('server-text-id');
    expect(store.get(pendingUsageFamily(CONV_ID)).eventCount).toBe(1);
    await act(async () => {
      emitFrame({
        final: true,
        responseMessage: {
          messageId: 'server-text-id',
          parentMessageId: 'msg-1',
          conversationId: CONV_ID,
          isCreatedByUser: false,
          text: 'done',
        },
        conversation: { conversationId: CONV_ID },
      });
    });
    expect(store.get(activeUsageResponseIdFamily(CONV_ID))).toBeNull();
    expect(store.get(pendingUsageFamily(CONV_ID)).eventCount).toBe(0);
    unmount();
  });

  it('shows the terms refusal text from the host and refreshes the balance after an error', async () => {
    const submission = buildSubmission();
    const reopen = jest
      .spyOn(legacyServices, 'reopenTermsOnRefusal')
      .mockReturnValue('Accept the terms');
    const { unmount } = renderHook(() => useLegacyStream(submission, buildChatHelpers()), {
      wrapper,
    });
    await act(async () => emit({ type: 'error', data: { message: 'terms' } }));
    expect(reopen).toHaveBeenCalledWith({ message: 'terms' });
    expect(legacyServices.refreshBalance).toHaveBeenCalled();
    expect(lastCall(mockErrorHandler)?.[0].data).toEqual({ text: 'Accept the terms' });
    unmount();
  });
});

/**
 * @jest-environment jsdom
 */
import React from 'react';
import { Provider } from 'jotai';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TAttachment, EventSubmission } from 'librechat-data-provider';
import type { StreamHost } from '../../host';
import { createEventServices } from '../../__fixtures__/events';
import { StreamHostProvider } from '../../host';
import { useEventHandlers } from '../handlers';

const mockResetSubagentAtoms = jest.fn();
const mockResetPtcAtoms = jest.fn();

jest.mock('../../step', () => ({
  useStepHandler: () => ({
    stepHandler: jest.fn(),
    clearStepMaps: jest.fn(),
    resetSubagentAtoms: mockResetSubagentAtoms,
    resetPtcAtoms: mockResetPtcAtoms,
    prunePtcTraces: jest.fn(),
    syncStepMessage: jest.fn(),
    cancelPendingDeltaFlush: jest.fn(),
    flushPendingDeltas: jest.fn(),
  }),
}));

let routeConversationId = 'saved';
const services = createEventServices();
const unused = (): never => {
  throw new Error('not used by the event handlers');
};
const host: StreamHost = {
  useResumableServices: unused,
  useLegacyStream: unused,
  useTransport: () => null,
  useQueuedTurnReceipts: unused,
  useActiveJobs: unused,
  extendActiveJobsGrace: unused,
  useStreamStatus: unused,
  useResumeSettings: unused,
  useParentSubagentIndex: unused,
  useEventServices: () => ({
    ...services,
    navigation: { ...services.navigation, conversationId: routeConversationId },
  }),
};

const queryClient = new QueryClient();
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <Provider>
    <QueryClientProvider client={queryClient}>
      <StreamHostProvider host={host}>{children}</StreamHostProvider>
    </QueryClientProvider>
  </Provider>
);

describe('useEventHandlers live-state cleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    routeConversationId = 'saved';
  });

  it('preserves the selected task only for navigation, not host teardown', () => {
    const { rerender, unmount } = renderHook(
      () =>
        useEventHandlers({
          getMessages: () => [],
          setMessages: jest.fn(),
          setCompleted: jest.fn(),
          setConversation: jest.fn(),
          setIsSubmitting: jest.fn(),
          setShowStopButton: jest.fn(),
          newConversation: jest.fn(),
        }),
      { wrapper },
    );
    expect(mockResetSubagentAtoms).not.toHaveBeenCalled();
    routeConversationId = 'other';
    rerender();
    expect(mockResetSubagentAtoms).toHaveBeenCalledTimes(1);
    expect(mockResetSubagentAtoms).toHaveBeenCalledWith({ preserveSelectedTask: true });
    expect(mockResetPtcAtoms).toHaveBeenCalledTimes(1);
    unmount();
    expect(mockResetSubagentAtoms).toHaveBeenCalledTimes(2);
    expect(mockResetSubagentAtoms).toHaveBeenLastCalledWith();
    expect(mockResetPtcAtoms).toHaveBeenCalledTimes(2);
  });

  it('routes streamed attachments and image files through the host file services', () => {
    const { result } = renderHook(
      () =>
        useEventHandlers({
          getMessages: () => [],
          setMessages: jest.fn(),
          setCompleted: jest.fn(),
          setIsSubmitting: jest.fn(),
          setShowStopButton: jest.fn(),
        }),
      { wrapper },
    );
    const attachment = {
      file_id: 'file-1',
      messageId: 'response-1',
      conversationId: 'saved',
    } as TAttachment;
    result.current.attachmentHandler({
      data: attachment,
      submission: { initialResponse: { messageId: 'response-1' } } as EventSubmission,
    });
    expect(services.files.onAttachment).toHaveBeenCalledWith(attachment);
  });
});

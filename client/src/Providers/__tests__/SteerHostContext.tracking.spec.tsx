import { act, renderHook } from '@testing-library/react';
import { appSteerHost } from '../SteerHostContext';

const mockTrack = jest.fn();
const mockMutate = jest.fn();
const mockMutateAsync = jest.fn();
const sessionId = 'd79706cc-4ddf-4cf7-b99a-333755af9be8';
const submissionId = '1b7ff690-8b9b-4af6-b68d-9cab4a5f2f21';

jest.mock('../TrackingContext', () => ({
  useProductTracking: () => mockTrack,
  useProductTrackingContext: () => () => ({ sessionId }),
}));
jest.mock('~/data-provider', () => ({
  useSteerMessageMutation: () => ({ mutate: mockMutate, mutateAsync: mockMutateAsync }),
  useEnqueueAgentQueuedTurnMutation: () => ({ mutate: mockMutate }),
}));

beforeEach(() => jest.clearAllMocks());

it('captures steer identity without content and does not wait for delivery', () => {
  mockTrack.mockReturnValue(new Promise(() => undefined));
  const { result } = renderHook(() => appSteerHost.useSteerMessage());
  const request = {
    conversationId: 'conversation',
    clientSteerId: 'local-existing',
    generationCreatedAt: 123,
    text: 'private steer',
  };
  act(() => result.current(request));
  expect(mockMutate).toHaveBeenCalledWith(request, expect.any(Object));
  expect(mockTrack).toHaveBeenCalledWith(
    {
      name: 'librechat.chat.message.steered',
      feature: 'chat',
      conversationId: 'conversation',
      clientSteerId: 'local-existing',
      generationCreatedAt: 123,
    },
    { sessionId },
  );
  expect(JSON.stringify(mockTrack.mock.calls)).not.toContain('private steer');
});

it('correlates queue rejection without creating a replacement session', () => {
  const onError = jest.fn();
  const { result } = renderHook(() => appSteerHost.useEnqueueQueuedTurn());
  const request = {
    conversationId: 'conversation',
    parentMessageId: 'parent',
    clientRequestId: submissionId,
    text: 'private queued prompt',
  };
  act(() => result.current(request, { onError }));
  const error = { response: { status: 409 }, message: 'private diagnostics' };
  act(() => mockMutate.mock.calls[0][1].onError(error));
  expect(onError).toHaveBeenCalledWith(error);
  expect(mockTrack).toHaveBeenCalledWith(
    {
      name: 'librechat.chat.submission.failed',
      feature: 'chat',
      conversationId: 'conversation',
      submissionId,
      reason: 'rejected',
    },
    { submissionId },
  );
  expect(JSON.stringify(mockTrack.mock.calls)).not.toContain('private');
});

it('reports a server error on queue as unconfirmed, not rejected', () => {
  const { result } = renderHook(() => appSteerHost.useEnqueueQueuedTurn());
  act(() =>
    result.current({
      conversationId: 'conversation',
      parentMessageId: 'parent',
      clientRequestId: submissionId,
      text: 'queued prompt',
    }),
  );
  act(() => mockMutate.mock.calls[0][1].onError({ response: { status: 503 } }));
  expect(mockTrack).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'librechat.chat.submission.failed', reason: 'unconfirmed' }),
    { submissionId },
  );
});

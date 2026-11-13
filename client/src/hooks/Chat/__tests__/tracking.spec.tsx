import { act, renderHook } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TSubmission } from 'librechat-data-provider';
import useChatProductTracking, { useProductSubmissionFailure } from '../tracking';
import { TrackingProvider } from '~/Providers/TrackingContext';

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { productTracking: { enabled: true } } }),
}));

it('retains submission correlation without exporting messages or custom labels', async () => {
  localStorage.clear();
  const track = jest.fn();
  const { result } = renderHook(
    () => ({
      submit: useChatProductTracking(),
      fail: useProductSubmissionFailure(),
    }),
    {
      wrapper: ({ children }) => <TrackingProvider track={track}>{children}</TrackingProvider>,
    },
  );
  const submission: TSubmission = {
    clientRequestId: 'a0fd2102-6d24-46ed-8e91-afaf88c8a617',
    userMessage: {
      messageId: 'private-message',
      conversationId: 'conversation',
      sender: 'User',
      text: 'private-prompt',
      isCreatedByUser: true,
      parentMessageId: 'private-parent',
    },
    initialResponse: {
      messageId: 'private-response-message',
      conversationId: 'conversation',
      sender: 'private-label',
      text: 'private-answer',
      isCreatedByUser: false,
      parentMessageId: 'private-message',
    },
    isTemporary: false,
    messages: [],
    conversation: {
      agent_id: 'private-endpoint__private-model___private-label',
      model: 'private-model',
    },
    endpointOption: { endpoint: EModelEndpoint.agents },
  };
  await act(async () => {
    submission.productTrackingContext = result.current.submit(submission, 'send');
  });
  await act(async () => result.current.fail(submission, 'unconfirmed'));
  expect(track).toHaveBeenCalledTimes(2);
  for (const [fact, context] of track.mock.calls) {
    expect(fact).toMatchObject({
      submissionId: submission.clientRequestId,
      conversationId: 'conversation',
      model: 'custom',
    });
    expect(context.submissionId).toBe(submission.clientRequestId);
    expect(fact).not.toHaveProperty('messageId');
    expect(fact).not.toHaveProperty('responseMessageId');
    expect(fact.agentId).toBeUndefined();
  }
  expect(JSON.stringify(track.mock.calls)).not.toContain('private-');
});

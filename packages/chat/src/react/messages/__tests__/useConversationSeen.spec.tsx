/**
 * @jest-environment jsdom
 */
import { QueryKeys } from 'librechat-data-provider';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ConversationSeenSource, SeenReply } from '../host';
import useConversationSeen from '../useConversationSeen';

const CONVO_ID = 'convo-seen';
const RESPONDED_AT = '2026-11-03T10:00:00.000Z';

function setup(reply: SeenReply | undefined, { proven = true, submitting = false } = {}) {
  const queryClient = new QueryClient();
  queryClient.setQueryData([QueryKeys.messages, CONVO_ID], []);
  const markSeen = jest.fn();
  const consumeFocusSuppression = jest.fn(() => false);
  const source: ConversationSeenSource = {
    readReply: (conversationId) => (conversationId === CONVO_ID ? reply : undefined),
    hasReplyProof: (_conversationId, _stamp, from) => proven && from === 'server',
    markSeen,
    consumeFocusSuppression,
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const view = renderHook(
    ({ id, isSubmitting }: { id: string; isSubmitting: boolean }) =>
      useConversationSeen(source, id, isSubmitting, undefined, () => true),
    { initialProps: { id: CONVO_ID, isSubmitting: submitting }, wrapper },
  );
  return { ...view, markSeen, consumeFocusSuppression, queryClient };
}

const unseenReply: SeenReply = {
  lastResponseAt: RESPONDED_AT,
  lastResponseMessageId: 'reply-1',
  unseen: true,
};

describe('useConversationSeen', () => {
  let hasFocus: jest.SpyInstance;

  beforeEach(() => {
    hasFocus = jest.spyOn(document, 'hasFocus').mockReturnValue(true);
  });

  afterEach(() => hasFocus.mockRestore());

  it('acknowledges the stamped reply through the source once the end is in view', async () => {
    const { result, markSeen } = setup(unseenReply);

    act(() => result.current(true));

    await waitFor(() =>
      expect(markSeen).toHaveBeenCalledWith({
        conversationId: CONVO_ID,
        lastResponseAt: RESPONDED_AT,
      }),
    );
  });

  it('writes nothing for a conversation the source reads as caught up', async () => {
    const { result, markSeen } = setup({ ...unseenReply, unseen: false });

    act(() => result.current(true));
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));

    expect(markSeen).not.toHaveBeenCalled();
  });

  it('does not read a notification-click focus as the reader returning', async () => {
    hasFocus.mockReturnValue(false);
    const { result, markSeen, consumeFocusSuppression } = setup(unseenReply);
    act(() => result.current(true));

    consumeFocusSuppression.mockReturnValueOnce(true);
    hasFocus.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));

    expect(consumeFocusSuppression).toHaveBeenCalledTimes(1);
    expect(markSeen).not.toHaveBeenCalled();
  });

  it('acknowledges on a genuine refocus of a conversation left open at its end', async () => {
    hasFocus.mockReturnValue(false);
    const { result, markSeen } = setup(unseenReply);
    act(() => result.current(true));
    expect(markSeen).not.toHaveBeenCalled();

    hasFocus.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(markSeen).toHaveBeenCalledTimes(1));
  });

  it("forgets the previous conversation's position when another opens", async () => {
    const { result, rerender, markSeen } = setup(unseenReply);
    act(() => result.current(true));
    await waitFor(() => expect(markSeen).toHaveBeenCalledTimes(1));

    rerender({ id: 'convo-next', isSubmitting: false });
    rerender({ id: CONVO_ID, isSubmitting: false });
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));

    /** Returning re-arms the attempt, but nothing reported the end in view since. */
    expect(markSeen).toHaveBeenCalledTimes(1);
  });

  it('revalidates history for a reply no fetch has shown yet', () => {
    const { result, queryClient } = setup(unseenReply, { proven: false });
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

    act(() => result.current(true));

    expect(invalidate).toHaveBeenCalledWith([QueryKeys.messages, CONVO_ID]);
  });

  it('leaves history alone under a run in flight and revalidates once it ends', async () => {
    const { result, rerender, queryClient } = setup(unseenReply, {
      proven: false,
      submitting: true,
    });
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

    act(() => result.current(true));
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
    expect(invalidate).not.toHaveBeenCalled();

    rerender({ id: CONVO_ID, isSubmitting: false });

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith([QueryKeys.messages, CONVO_ID]));
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});

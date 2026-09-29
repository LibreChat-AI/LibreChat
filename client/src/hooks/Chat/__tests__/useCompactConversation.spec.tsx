import { getDefaultStore } from 'jotai';
import { ContentTypes } from 'librechat-data-provider';
import { renderHook, act } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import useCompactConversation, { compactingConversationAtom } from '../useCompactConversation';

const mockAsk = jest.fn();
let mockContext: {
  index: number;
  isSubmitting: boolean;
  conversation: { conversationId: string; endpoint: string } | null;
};
let mockLatestMessage: TMessage | null;

jest.mock('~/Providers', () => ({
  useChatContext: () => ({ ...mockContext, ask: mockAsk }),
}));
jest.mock('~/hooks/Messages/useLatestMessage', () => ({
  useLatestMessage: () => mockLatestMessage,
}));

type ContentPart = NonNullable<TMessage['content']>[number];

const summaryPart = (overrides: Record<string, unknown> = {}): ContentPart =>
  ({
    type: ContentTypes.SUMMARY,
    content: [{ type: ContentTypes.TEXT, text: 'checkpoint' }],
    boundary: { messageId: 'step_summary', contentIndex: 0 },
    ...overrides,
  }) as ContentPart;

const leaf = (overrides: Partial<TMessage> = {}): TMessage =>
  ({
    messageId: 'a1',
    parentMessageId: 'u1',
    conversationId: 'convo-1',
    isCreatedByUser: false,
    text: 'answer',
    ...overrides,
  }) as TMessage;

describe('useCompactConversation', () => {
  beforeEach(() => {
    mockAsk.mockClear();
    mockContext = {
      index: 0,
      isSubmitting: false,
      conversation: { conversationId: 'convo-1', endpoint: 'openAI' },
    };
    mockLatestMessage = leaf();
    getDefaultStore().set(compactingConversationAtom, null);
  });

  it('drops a marker left by a compaction that finished while the view was away', () => {
    getDefaultStore().set(compactingConversationAtom, 'convo-1');
    const hook = renderHook(() => useCompactConversation());
    expect(hook.result.current.isCompacting).toBe(false);

    /** The next ordinary turn in the same conversation is not a compaction. */
    mockContext.isSubmitting = true;
    hook.rerender();
    expect(hook.result.current.isCompacting).toBe(false);
  });

  it('keeps the marker when it mounts into a compaction still streaming', () => {
    getDefaultStore().set(compactingConversationAtom, 'convo-1');
    mockContext.isSubmitting = true;
    const hook = renderHook(() => useCompactConversation());
    expect(hook.result.current.isCompacting).toBe(true);

    mockContext.isSubmitting = false;
    hook.rerender();
    expect(hook.result.current.isCompacting).toBe(false);
    expect(getDefaultStore().get(compactingConversationAtom)).toBeNull();
  });

  it('submits a compaction anchored on the leaf itself', () => {
    const { result } = renderHook(() => useCompactConversation());

    expect(result.current.canCompact).toBe(true);
    act(() => result.current.compact());

    /** The server compacts up to `parentMessageId`, so it must be the leaf,
     *  not the leaf's own parent, or the latest reply is left out. */
    expect(mockAsk).toHaveBeenCalledWith(
      { text: '', conversationId: 'convo-1', messageId: 'a1', parentMessageId: 'a1' },
      { compact: true },
    );
  });

  it.each([
    [
      'a new conversation',
      () => (mockContext.conversation = { conversationId: 'new', endpoint: 'openAI' }),
    ],
    ['a submission in flight', () => (mockContext.isSubmitting = true)],
    ['no leaf', () => (mockLatestMessage = null)],
    [
      'a leaf that is already a finished compaction',
      () => (mockLatestMessage = leaf({ text: '', content: [summaryPart()] })),
    ],
  ])('cannot compact with %s', (_label, arrange) => {
    arrange();
    const { result } = renderHook(() => useCompactConversation());

    expect(result.current.canCompact).toBe(false);
    act(() => result.current.compact());
    expect(mockAsk).not.toHaveBeenCalled();
  });

  it.each([
    ['still streaming', summaryPart({ summarizing: true })],
    ['failed', summaryPart({ failed: true })],
    ['stored without a boundary', summaryPart({ boundary: undefined })],
  ])('lets an interrupted compaction (summary %s) be retried', (_label, part) => {
    mockLatestMessage = leaf({ text: '', content: [part] });
    const { result } = renderHook(() => useCompactConversation());

    expect(result.current.canCompact).toBe(true);
  });

  it('reports compacting only for the conversation it submitted, until the turn settles', () => {
    const hook = renderHook(() => useCompactConversation());
    act(() => hook.result.current.compact());

    mockContext.isSubmitting = true;
    hook.rerender();
    expect(hook.result.current.isCompacting).toBe(true);

    mockContext.conversation = { conversationId: 'convo-2', endpoint: 'openAI' };
    hook.rerender();
    expect(hook.result.current.isCompacting).toBe(false);

    mockContext.conversation = { conversationId: 'convo-1', endpoint: 'openAI' };
    mockContext.isSubmitting = false;
    hook.rerender();
    expect(hook.result.current.isCompacting).toBe(false);
    mockContext.isSubmitting = true;
    hook.rerender();
    expect(hook.result.current.isCompacting).toBe(false);
  });
});

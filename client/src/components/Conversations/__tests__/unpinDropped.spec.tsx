import { renderHook, waitFor } from '@testing-library/react';
import type {
  AssignDroppedConversation,
  ConversationDragItem,
  UnpinDroppedConversation,
} from '../dnd';
import { useAssignDroppedConversation, useUnpinDroppedConversation } from '../dnd';

const mockPin = jest.fn();
const mockAssign = jest.fn();

const mockShowToast = jest.fn();

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: mockShowToast }),
}));

let mockPendingAssignment: { token: number; projectId: string | null } | undefined;

jest.mock('~/data-provider/Projects/mutations', () => ({
  getPendingAssignment: () => mockPendingAssignment,
}));

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ getQueryData: () => undefined }),
}));

jest.mock('~/data-provider', () => ({
  useAssignConversationToProjectMutation: () => ({ mutateAsync: mockAssign }),
  usePinConversationMutation: () => ({ mutate: mockPin }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

/** Only the two ids the drop reads; the response also carries the conversation. */
type AssignResponse = { previousProjectId: string | null; projectId: string | null };

const item = (pinned: boolean, conversationId = 'c1'): ConversationDragItem => ({
  conversationId,
  chatProjectId: null,
  pinned,
});

/* Dropping a chat on the Chats section asks for an ordinary chat, and a pinned
 * one is not that. */
describe('useUnpinDroppedConversation', () => {
  beforeEach(() => {
    mockPin.mockReset();
    mockAssign.mockReset();
  });

  it('unpins the dropped conversation', () => {
    const { result } = renderHook(() => useUnpinDroppedConversation());

    result.current(item(true));

    expect(mockPin).toHaveBeenCalledWith(
      { conversationId: 'c1', pinned: false },
      expect.anything(),
    );
  });

  it('leaves a chat that is not pinned alone', () => {
    const { result } = renderHook(() => useUnpinDroppedConversation());

    result.current(item(false));

    expect(mockPin).not.toHaveBeenCalled();
  });

  /* A favorite row's drag item carries no conversation at all. */
  it('ignores a drag item with no conversation', () => {
    const { result } = renderHook(() => useUnpinDroppedConversation());

    result.current(item(true, ''));

    expect(mockPin).not.toHaveBeenCalled();
  });
});

/* What the Chats section does with a chat that is both pinned and filed in a
 * project: it asks for both halves, and the caller decides their order. */
describe('a drop on Chats, filing and unpinning together', () => {
  beforeEach(() => {
    mockPin.mockReset();
    mockAssign.mockReset();
    mockShowToast.mockReset();
    mockPendingAssignment = undefined;
  });

  /* The drop handler the Chats section installs, kept in one place so the two
   * cases below exercise the same sequence the component runs. */
  const drop = async (
    assign: AssignDroppedConversation,
    unpin: UnpinDroppedConversation,
    dragged: ConversationDragItem,
  ) => {
    const filed = await assign(dragged, null);
    if (filed) {
      unpin(dragged);
    }
  };

  it('unpins only once the project write has landed', async () => {
    let settle: ((result: AssignResponse) => void) | undefined;
    mockAssign.mockImplementation(
      () =>
        new Promise<AssignResponse>((resolve) => {
          settle = resolve;
        }),
    );
    const { result } = renderHook(() => ({
      assign: useAssignDroppedConversation(),
      unpin: useUnpinDroppedConversation(),
    }));

    const dropped = { conversationId: 'c1', chatProjectId: 'p1', pinned: true };
    const running = drop(result.current.assign, result.current.unpin, dropped);

    expect(mockAssign).toHaveBeenCalledWith({ conversationId: 'c1', projectId: null });
    expect(mockPin).not.toHaveBeenCalled();

    settle?.({ previousProjectId: 'p1', projectId: null });
    await running;

    expect(mockPin).toHaveBeenCalledWith(
      { conversationId: 'c1', pinned: false },
      expect.anything(),
    );
  });

  /* A chat left in its project must not also leave the Pinned section: the row
   * would then be in neither place the user can see it. */
  it('keeps the chat pinned when the project write fails', async () => {
    mockAssign.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => ({
      assign: useAssignDroppedConversation(),
      unpin: useUnpinDroppedConversation(),
    }));

    await drop(result.current.assign, result.current.unpin, {
      conversationId: 'c1',
      chatProjectId: 'p1',
      pinned: true,
    });

    await waitFor(() => expect(mockAssign).toHaveBeenCalled());
    expect(mockPin).not.toHaveBeenCalled();
  });

  /* A write already in flight cannot answer for this drop: it can still fail,
   * and the path that started it may own no unpin at all — the row menu unfiles
   * a chat without unpinning it. The drop issues its own write and waits for
   * that one, which the per-conversation queue runs after the first. */
  it('issues its own write rather than trusting one already in flight', async () => {
    mockPendingAssignment = { token: 1, projectId: null };
    mockAssign.mockResolvedValue({ previousProjectId: 'p1', projectId: null });
    const { result } = renderHook(() => ({
      assign: useAssignDroppedConversation(),
      unpin: useUnpinDroppedConversation(),
    }));

    await drop(result.current.assign, result.current.unpin, {
      conversationId: 'c1',
      chatProjectId: 'p1',
      pinned: true,
    });

    expect(mockAssign).toHaveBeenCalledWith({ conversationId: 'c1', projectId: null });
    expect(mockPin).toHaveBeenCalledWith(
      { conversationId: 'c1', pinned: false },
      expect.anything(),
    );
  });

  /* The same drop, when that in-flight write fails: the chat is still in its
   * project, so it keeps its pin too. */
  it('keeps the chat pinned when the write it waited for fails', async () => {
    mockPendingAssignment = { token: 1, projectId: null };
    mockAssign.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => ({
      assign: useAssignDroppedConversation(),
      unpin: useUnpinDroppedConversation(),
    }));

    await drop(result.current.assign, result.current.unpin, {
      conversationId: 'c1',
      chatProjectId: 'p1',
      pinned: true,
    });

    expect(mockAssign).toHaveBeenCalled();
    expect(mockPin).not.toHaveBeenCalled();
  });
  /* A chat this tab believes is already out of every project still gets the
   * write: the belief can be a snapshot another tab has moved on from, and
   * unpinning on it would leave the chat in a project and out of both lists.
   * The notice belongs to a move that happened, so a write that changed
   * nothing stays quiet. */
  it('confirms the removal with the server and announces only a real move', async () => {
    mockAssign.mockResolvedValue({ previousProjectId: null, projectId: null });
    const { result } = renderHook(() => ({
      assign: useAssignDroppedConversation(),
      unpin: useUnpinDroppedConversation(),
    }));

    await drop(result.current.assign, result.current.unpin, {
      conversationId: 'c1',
      chatProjectId: null,
      pinned: true,
    });

    expect(mockAssign).toHaveBeenCalledWith({ conversationId: 'c1', projectId: null });
    expect(mockShowToast).not.toHaveBeenCalled();
    expect(mockPin).toHaveBeenCalledWith(
      { conversationId: 'c1', pinned: false },
      expect.anything(),
    );
  });
});

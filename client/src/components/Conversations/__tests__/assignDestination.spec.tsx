import { QueryKeys } from 'librechat-data-provider';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ConversationDragItem } from '../dnd';
import { useEffectiveProjectId } from '../dnd';

type PendingAssignment = { token: number; projectId: string | null } | undefined;

let mockPending: PendingAssignment;

jest.mock('~/data-provider/Projects/mutations', () => ({
  getPendingAssignment: () => mockPending,
}));

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: jest.fn() }),
}));

jest.mock('~/data-provider', () => ({
  useAssignConversationToProjectMutation: () => ({ mutateAsync: jest.fn() }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

/** A drag item as the row reports it: `chatProjectId` is whatever the list that
 *  rendered the row believed when the drag began. */
const item = (conversationId: string, chatProjectId: string | null): ConversationDragItem => ({
  conversationId,
  chatProjectId,
  pinned: false,
});

const setup = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useEffectiveProjectId(), { wrapper });
  return { queryClient, effectiveProjectId: result.current };
};

describe('useEffectiveProjectId', () => {
  beforeEach(() => {
    mockPending = undefined;
  });

  it('falls back to the row when nothing is pending or cached', () => {
    const { effectiveProjectId } = setup();
    expect(effectiveProjectId(item('c1', 'project-a'))).toBe('project-a');
  });

  it('prefers a pending write over everything else', () => {
    mockPending = { token: 1, projectId: 'project-b' };
    const { queryClient, effectiveProjectId } = setup();
    queryClient.setQueryData([QueryKeys.conversation, 'c1'], { chatProjectId: 'project-a' });

    expect(effectiveProjectId(item('c1', 'project-a'))).toBe('project-b');
  });

  it('honours a pending move back to the root list', () => {
    mockPending = { token: 1, projectId: null };
    const { effectiveProjectId } = setup();
    expect(effectiveProjectId(item('c1', 'project-a'))).toBe(null);
  });

  /* The mutation writes this cache synchronously on success, so it is right the
   * moment the write lands rather than once the lists refresh. */
  it('uses the conversation cache once nothing is pending', () => {
    const { queryClient, effectiveProjectId } = setup();
    queryClient.setQueryData([QueryKeys.conversation, 'c1'], { chatProjectId: 'project-b' });

    /* Two lists render this conversation and refresh independently, so a stale
     * row must not be believed over what the write already confirmed. */
    expect(effectiveProjectId(item('c1', 'project-a'))).toBe('project-b');
    expect(effectiveProjectId(item('c1', null))).toBe('project-b');
  });

  it('reports the root list from the cache as a real value, not a miss', () => {
    const { queryClient, effectiveProjectId } = setup();
    queryClient.setQueryData([QueryKeys.conversation, 'c1'], { chatProjectId: null });

    expect(effectiveProjectId(item('c1', 'project-a'))).toBe(null);
  });

  it('leaves other conversations alone', () => {
    const { queryClient, effectiveProjectId } = setup();
    queryClient.setQueryData([QueryKeys.conversation, 'c1'], { chatProjectId: 'project-b' });

    expect(effectiveProjectId(item('c2', 'project-a'))).toBe('project-a');
  });
});

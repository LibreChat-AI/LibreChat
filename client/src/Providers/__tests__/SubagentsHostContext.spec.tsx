import { renderHook } from '@testing-library/react';
import { ForkOptions } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import { appSubagentsHost } from '../SubagentsHostContext';

const mockThreadRefetch = jest.fn();
const mockPartRefetch = jest.fn();
const mockUseSubagentThreadQuery = jest.fn();
const mockForkMutate = jest.fn();
const mockNavigate = jest.fn();
const mockNavigateToConvo = jest.fn();
const mockMediaQuery = jest.fn();
let mockRemScale = 1;

jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider'),
  useSubagentThreadQuery: (...args: unknown[]) => {
    mockUseSubagentThreadQuery(...args);
    return {
      data: undefined,
      isLoading: false,
      isError: false,
      isPreviousData: false,
      isReadinessPending: false,
      refetch: mockThreadRefetch,
    };
  },
  useToolCallPartQuery: () => ({ data: undefined, isError: false, refetch: mockPartRefetch }),
  useForkConvoMutation: () => ({ mutate: mockForkMutate, isLoading: false }),
}));

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

jest.mock('~/hooks/Conversations/useNavigateToConvo', () => ({
  __esModule: true,
  default: () => ({ navigateToConvo: mockNavigateToConvo }),
}));

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useRemScale: () => mockRemScale,
  useMediaQuery: (query: string) => mockMediaQuery(query),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockRemScale = 1;
});

describe('appSubagentsHost reads', () => {
  /** The thread panel revalidates in an effect that depends on `refetch`; a callback that
   *  changed every render would refetch on every fetch-state render instead of once. */
  it('hands back the thread query refetch itself, stable across renders', () => {
    const { result, rerender } = renderHook(() =>
      appSubagentsHost.useThread('parent', 'thread', 'task', { keepPreviousData: true }),
    );
    const first = result.current.refetch;
    rerender();
    expect(result.current.refetch).toBe(first);
    expect(first).toBe(mockThreadRefetch);
  });

  it('hands back the stored tool part refetch itself, stable across renders', () => {
    const { result, rerender } = renderHook(() =>
      appSubagentsHost.useToolCallPart(
        { conversationId: 'c', messageId: 'm', partIndex: 0 },
        { enabled: true },
      ),
    );
    const first = result.current.refetch;
    rerender();
    expect(result.current.refetch).toBe(first);
    expect(first).toBe(mockPartRefetch);
  });

  /** A plain read keeps the query's own readiness schedule: it passes no options at all. */
  it('reads a thread without options when the panel asks for none', () => {
    renderHook(() => appSubagentsHost.useThread('parent', 'thread', 'task', {}));
    expect(mockUseSubagentThreadQuery).toHaveBeenCalledWith('parent', 'thread', 'task');
    expect(mockUseSubagentThreadQuery.mock.calls[0]).toHaveLength(3);
  });

  it('forwards the selected task view options', () => {
    renderHook(() =>
      appSubagentsHost.useThread('parent', 'thread', 'task', {
        keepPreviousData: true,
        refetchInterval: 2000,
      }),
    );
    expect(mockUseSubagentThreadQuery).toHaveBeenCalledWith('parent', 'thread', 'task', {
      keepPreviousData: true,
      refetchInterval: 2000,
    });
  });
});

describe('appSubagentsHost writes and navigation', () => {
  /** A child thread is view-only on the server, so continuing it forks the direct path to
   *  the selected task's reply into a conversation of the reader's own. */
  it('continues a thread as a direct-path fork of the task reply', () => {
    const { result } = renderHook(() => appSubagentsHost.useContinueChat({}));
    result.current.mutate({ conversationId: 'child-thread', messageId: 'task:assistant' });
    expect(mockForkMutate).toHaveBeenCalledTimes(1);
    expect(mockForkMutate).toHaveBeenCalledWith({
      conversationId: 'child-thread',
      messageId: 'task:assistant',
      option: ForkOptions.DIRECT_PATH,
    });
  });

  it('opens the parent conversation by its encoded chat path', () => {
    const { result } = renderHook(() => appSubagentsHost.useNavigation());
    result.current.openConversationId('parent conversation/1');
    expect(mockNavigate).toHaveBeenCalledWith('/c/parent%20conversation%2F1');
  });

  it('opens a forked conversation the way the chat list does', () => {
    const conversation: TConversation = {
      conversationId: 'continued-chat',
      title: 'Continued',
      endpoint: null,
      createdAt: '2026-11-03T00:00:00.000Z',
      updatedAt: '2026-11-03T00:00:00.000Z',
    };
    const { result } = renderHook(() => appSubagentsHost.useNavigation());
    result.current.openConversation(conversation);
    expect(mockNavigateToConvo).toHaveBeenCalledWith(conversation);
  });
});

describe('appSubagentsHost layout', () => {
  /** The panel turns into a modal sheet at the artifacts breakpoint, measured in the units
   *  the layout uses: 868 px at the default rem scale, wider when the reader scales text up. */
  it.each([
    [1, '(max-width: 868px)'],
    [1.25, '(max-width: 1085px)'],
  ])('measures the sheet breakpoint at rem scale %s', (scale, query) => {
    mockRemScale = scale;
    mockMediaQuery.mockReturnValue(true);
    const { result } = renderHook(() => appSubagentsHost.useSheetLayout());
    expect(mockMediaQuery).toHaveBeenCalledWith(query);
    expect(result.current).toBe(true);
  });

  it('is a side region when the viewport is wider than the sheet breakpoint', () => {
    mockMediaQuery.mockReturnValue(false);
    const { result } = renderHook(() => appSubagentsHost.useSheetLayout());
    expect(result.current).toBe(false);
  });
});

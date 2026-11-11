import type { SubagentsHost } from '../react/subagents/host';

/** A subagents host for specs: no slots, idle reads, inert mutations and navigation, a region
 *  layout, no footer, no approval scope, with the members a spec needs overridden. */
export function createSubagentsHost(overrides: Partial<SubagentsHost> = {}): SubagentsHost {
  return {
    renderSteer: () => null,
    useRetainedControl: () => ({ isFetching: false, isError: false, refetch: () => undefined }),
    useTaskContent: () => ({ isError: false, isUnavailable: false, refetch: () => undefined }),
    useAgentsMap: () => undefined,
    useChildPartsHost: (host) => host,
    useThread: () => ({
      isLoading: false,
      isError: false,
      isPreviousData: false,
      isReadinessPending: false,
      refetch: () => undefined,
    }),
    loadThread: () => Promise.reject(new Error('loadThread is not faked in this spec')),
    useControl: () => ({ mutate: () => undefined, isLoading: false }),
    useContinueChat: () => ({ mutate: () => undefined, isLoading: false }),
    useToolCallPart: () => ({ isError: false, refetch: () => undefined }),
    useNavigation: () => ({
      openConversation: () => undefined,
      openConversationId: () => undefined,
    }),
    useSheetLayout: () => false,
    useClearsFooter: () => false,
    renderApprovalScope: ({ children }) => children,
    ...overrides,
  };
}

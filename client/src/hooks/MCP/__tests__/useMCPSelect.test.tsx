import React from 'react';
import { Provider, createStore } from 'jotai';
import { renderHook, act, waitFor } from '@testing-library/react';
import { Constants, LocalStorageKeys } from 'librechat-data-provider';
import { RecoilRoot, useRecoilState, useRecoilValue, useSetRecoilState } from 'recoil';
import { MCPServerDefinition } from '../useMCPServerManager';
import { ephemeralAgentByConvoId } from '~/store';
import { setTimestamp } from '~/utils/timestamps';
import { useMCPSelect } from '../useMCPSelect';

// Mock dependencies
jest.mock('~/utils/timestamps', () => ({
  setTimestamp: jest.fn(),
}));

jest.mock('lodash/isEqual', () => jest.fn((a, b) => JSON.stringify(a) === JSON.stringify(b)));

// Mutable startup config so tests can vary `interface.defaultPinnedTools`
let mockStartupConfig:
  | {
      interface?: { defaultPinnedTools?: string[] };
      modelSpecs?: { list?: Array<{ name: string; mcpServers?: string[] }> };
    }
  | undefined;

jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider'),
  useGetStartupConfig: jest.fn(() => ({ data: mockStartupConfig })),
}));

// Helper to create MCPServerDefinition objects
const createMCPServers = (serverNames: string[]): MCPServerDefinition[] => {
  return serverNames.map((serverName) => ({
    serverName,
    config: {
      type: 'sse',
      url: 'http://mcp',
    },
    effectivePermissions: 15, // All permissions (VIEW=1, EDIT=2, DELETE=4, SHARE=8)
  }));
};

const createWrapper = (mcpServers: string[] = []) => {
  // Create a new Jotai store for each test to ensure clean state
  const store = createStore();
  const servers = createMCPServers(mcpServers);

  const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <RecoilRoot>
      <Provider store={store}>{children}</Provider>
    </RecoilRoot>
  );
  return { Wrapper, servers };
};

describe('useMCPSelect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    mockStartupConfig = undefined;
  });

  describe('Basic Functionality', () => {
    it('should initialize with default values', () => {
      const { Wrapper, servers } = createWrapper();
      const { result } = renderHook(() => useMCPSelect({ servers, ownsChatSelection: true }), {
        wrapper: Wrapper,
      });

      expect(result.current.mcpValues).toEqual([]);
      expect(result.current.isPinned).toBe(true); // Default value from mcpPinnedAtom is true
      expect(typeof result.current.setMCPValues).toBe('function');
      expect(typeof result.current.setIsPinned).toBe('function');
    });

    it('should use conversationId when provided', () => {
      const conversationId = 'test-convo-123';
      const { Wrapper, servers } = createWrapper();
      const { result } = renderHook(
        () => useMCPSelect({ conversationId, servers, ownsChatSelection: true }),
        {
          wrapper: Wrapper,
        },
      );

      expect(result.current.mcpValues).toEqual([]);
    });

    it('should use NEW_CONVO constant when conversationId is null', () => {
      const { Wrapper, servers } = createWrapper();
      const { result } = renderHook(
        () => useMCPSelect({ conversationId: null, servers, ownsChatSelection: true }),
        {
          wrapper: Wrapper,
        },
      );

      expect(result.current.mcpValues).toEqual([]);
    });
  });

  describe('State Updates', () => {
    it('should update mcpValues when setMCPValues is called', async () => {
      const { Wrapper, servers } = createWrapper(['value1', 'value2']);
      const { result } = renderHook(() => useMCPSelect({ servers, ownsChatSelection: true }), {
        wrapper: Wrapper,
      });

      const newValues = ['value1', 'value2'];

      act(() => {
        result.current.setMCPValues(newValues);
      });

      await waitFor(() => {
        expect(result.current.mcpValues).toEqual(newValues);
      });
    });

    it('should not update mcpValues if non-array is passed', () => {
      const { Wrapper, servers } = createWrapper();
      const { result } = renderHook(() => useMCPSelect({ servers, ownsChatSelection: true }), {
        wrapper: Wrapper,
      });

      act(() => {
        // @ts-ignore - Testing invalid input
        result.current.setMCPValues('not-an-array');
      });

      expect(result.current.mcpValues).toEqual([]);
    });

    it('should update isPinned state', () => {
      const { Wrapper, servers } = createWrapper();
      const { result } = renderHook(() => useMCPSelect({ servers, ownsChatSelection: true }), {
        wrapper: Wrapper,
      });

      // Default is true
      expect(result.current.isPinned).toBe(true);

      // Toggle to false
      act(() => {
        result.current.setIsPinned(false);
      });

      expect(result.current.isPinned).toBe(false);

      // Toggle back to true
      act(() => {
        result.current.setIsPinned(true);
      });

      expect(result.current.isPinned).toBe(true);
    });
  });

  describe('Timestamp Management', () => {
    it('should set timestamp when mcpValues is updated with values', async () => {
      const conversationId = 'test-convo';
      const { Wrapper, servers } = createWrapper();
      const { result } = renderHook(
        () => useMCPSelect({ conversationId, servers, ownsChatSelection: true }),
        {
          wrapper: Wrapper,
        },
      );

      const newValues = ['value1', 'value2'];

      act(() => {
        result.current.setMCPValues(newValues);
      });

      await waitFor(() => {
        const expectedKey = `${LocalStorageKeys.LAST_MCP_}${conversationId}`;
        expect(setTimestamp).toHaveBeenCalledWith(expectedKey);
      });
    });

    it('should not set timestamp when mcpValues is empty', async () => {
      const { Wrapper, servers } = createWrapper();
      const { result } = renderHook(() => useMCPSelect({ servers, ownsChatSelection: true }), {
        wrapper: Wrapper,
      });

      act(() => {
        result.current.setMCPValues([]);
      });

      await waitFor(() => {
        expect(setTimestamp).not.toHaveBeenCalled();
      });
    });
  });

  describe('Race Conditions and Infinite Loops Prevention', () => {
    it('should not create infinite loop when syncing between Jotai and Recoil states', async () => {
      const { Wrapper, servers } = createWrapper();
      const { result, rerender } = renderHook(
        () => useMCPSelect({ servers, ownsChatSelection: true }),
        {
          wrapper: Wrapper,
        },
      );

      let renderCount = 0;
      const maxRenders = 10;

      // Track renders to detect infinite loops
      const trackRender = () => {
        renderCount++;
        if (renderCount > maxRenders) {
          throw new Error('Potential infinite loop detected');
        }
      };

      // Set initial value
      act(() => {
        trackRender();
        result.current.setMCPValues(['initial']);
      });

      // Trigger multiple rerenders
      for (let i = 0; i < 3; i++) {
        rerender();
        trackRender();
      }

      // Should not exceed max renders
      expect(renderCount).toBeLessThanOrEqual(maxRenders);
    });

    it('should handle rapid consecutive updates without race conditions', async () => {
      const { Wrapper, servers } = createWrapper();
      const { result } = renderHook(() => useMCPSelect({ servers, ownsChatSelection: true }), {
        wrapper: Wrapper,
      });

      const updates = [
        ['value1'],
        ['value1', 'value2'],
        ['value1', 'value2', 'value3'],
        ['value4'],
        [],
      ];

      // Rapid fire updates
      act(() => {
        updates.forEach((update) => {
          result.current.setMCPValues(update);
        });
      });

      await waitFor(() => {
        // Should settle on the last update
        expect(result.current.mcpValues).toEqual([]);
      });
    });

    it('should maintain stable setter function reference', () => {
      const { Wrapper, servers } = createWrapper();
      const { result, rerender } = renderHook(
        () => useMCPSelect({ servers, ownsChatSelection: true }),
        {
          wrapper: Wrapper,
        },
      );

      const firstSetMCPValues = result.current.setMCPValues;

      // Trigger multiple rerenders
      rerender();
      rerender();
      rerender();

      // Setter should remain the same reference (memoized)
      expect(result.current.setMCPValues).toBe(firstSetMCPValues);
    });

    it('should handle switching conversation IDs without issues', async () => {
      const { Wrapper, servers } = createWrapper(['convo1-value', 'convo2-value']);
      const { result, rerender } = renderHook(
        ({ conversationId }) => useMCPSelect({ conversationId, servers, ownsChatSelection: true }),
        {
          wrapper: Wrapper,
          initialProps: { conversationId: 'convo1' },
        },
      );

      // Set values for first conversation
      act(() => {
        result.current.setMCPValues(['convo1-value']);
      });

      await waitFor(() => {
        expect(result.current.mcpValues).toEqual(['convo1-value']);
      });

      // Switch to different conversation
      rerender({ conversationId: 'convo2' });

      // Should have different state for new conversation
      expect(result.current.mcpValues).toEqual([]);

      // Set values for second conversation
      act(() => {
        result.current.setMCPValues(['convo2-value']);
      });

      await waitFor(() => {
        expect(result.current.mcpValues).toEqual(['convo2-value']);
      });

      // Switch back to first conversation
      rerender({ conversationId: 'convo1' });

      // Should maintain separate state
      await waitFor(() => {
        expect(result.current.mcpValues).toEqual(['convo1-value']);
      });
    });
  });

  describe('Ephemeral Agent Synchronization', () => {
    it('should sync mcpValues when ephemeralAgent is updated externally', async () => {
      // Create a shared wrapper for both hooks to share the same Recoil/Jotai context
      const { Wrapper, servers } = createWrapper(['external-value1', 'external-value2']);

      // Create a component that uses both hooks to ensure they share state
      const TestComponent = () => {
        const mcpHook = useMCPSelect({ servers, ownsChatSelection: true });
        const [ephemeralAgent, setEphemeralAgent] = useRecoilState(
          ephemeralAgentByConvoId(Constants.NEW_CONVO),
        );
        return { mcpHook, ephemeralAgent, setEphemeralAgent };
      };

      const { result } = renderHook(() => TestComponent(), { wrapper: Wrapper });

      // Simulate external update to ephemeralAgent (e.g., from another component)
      const externalMcpValues = ['external-value1', 'external-value2'];
      act(() => {
        result.current.setEphemeralAgent({
          mcp: externalMcpValues,
        });
      });

      // The hook should sync with the external update
      await waitFor(() => {
        expect(result.current.mcpHook.mcpValues).toEqual(externalMcpValues);
      });
    });

    it('should filter out MCPs not in configured servers', async () => {
      const { Wrapper, servers } = createWrapper(['server1', 'server2']);

      const TestComponent = () => {
        const mcpHook = useMCPSelect({ servers, ownsChatSelection: true });
        const setEphemeralAgent = useSetRecoilState(ephemeralAgentByConvoId(Constants.NEW_CONVO));
        return { mcpHook, setEphemeralAgent };
      };

      const { result } = renderHook(() => TestComponent(), { wrapper: Wrapper });

      act(() => {
        result.current.setEphemeralAgent({
          mcp: ['server1', 'removed-server', 'server2'],
        });
      });

      await waitFor(() => {
        expect(result.current.mcpHook.mcpValues).toEqual(['server1', 'server2']);
      });
    });

    it('should clear all MCPs when none are in configured servers', async () => {
      const { Wrapper, servers } = createWrapper(['server1', 'server2']);

      const TestComponent = () => {
        const mcpHook = useMCPSelect({ servers, ownsChatSelection: true });
        const setEphemeralAgent = useSetRecoilState(ephemeralAgentByConvoId(Constants.NEW_CONVO));
        return { mcpHook, setEphemeralAgent };
      };

      const { result } = renderHook(() => TestComponent(), { wrapper: Wrapper });

      act(() => {
        result.current.setEphemeralAgent({
          mcp: ['removed1', 'removed2', 'removed3'],
        });
      });

      await waitFor(() => {
        expect(result.current.mcpHook.mcpValues).toEqual([]);
      });
    });

    it('should keep all MCPs when all are in configured servers', async () => {
      const { Wrapper, servers } = createWrapper(['server1', 'server2', 'server3']);

      const TestComponent = () => {
        const mcpHook = useMCPSelect({ servers, ownsChatSelection: true });
        const setEphemeralAgent = useSetRecoilState(ephemeralAgentByConvoId(Constants.NEW_CONVO));
        return { mcpHook, setEphemeralAgent };
      };

      const { result } = renderHook(() => TestComponent(), { wrapper: Wrapper });

      act(() => {
        result.current.setEphemeralAgent({
          mcp: ['server1', 'server2'],
        });
      });

      await waitFor(() => {
        expect(result.current.mcpHook.mcpValues).toEqual(['server1', 'server2']);
      });
    });

    it('should update ephemeralAgent when mcpValues changes through hook', async () => {
      // Create a shared wrapper for both hooks
      const { Wrapper, servers } = createWrapper(['hook-value1', 'hook-value2']);

      // Create a component that uses both the hook and accesses Recoil state
      const TestComponent = () => {
        const mcpHook = useMCPSelect({ servers, ownsChatSelection: true });
        const ephemeralAgent = useRecoilValue(ephemeralAgentByConvoId(Constants.NEW_CONVO));
        return { mcpHook, ephemeralAgent };
      };

      const { result } = renderHook(() => TestComponent(), { wrapper: Wrapper });

      const newValues = ['hook-value1', 'hook-value2'];

      act(() => {
        result.current.mcpHook.setMCPValues(newValues);
      });

      // Verify both mcpValues and ephemeralAgent are updated
      await waitFor(() => {
        expect(result.current.mcpHook.mcpValues).toEqual(newValues);
        expect(result.current.ephemeralAgent?.mcp).toEqual(newValues);
      });
    });

    it('should clear mcpValues when ephemeralAgent.mcp is set to empty array', async () => {
      // Create a shared wrapper
      const { Wrapper, servers } = createWrapper(['initial-value']);

      // Create a component that uses both hooks
      const TestComponent = () => {
        const mcpHook = useMCPSelect({ servers, ownsChatSelection: true });
        const setEphemeralAgent = useSetRecoilState(ephemeralAgentByConvoId(Constants.NEW_CONVO));
        return { mcpHook, setEphemeralAgent };
      };

      const { result } = renderHook(() => TestComponent(), { wrapper: Wrapper });

      // Set initial values
      act(() => {
        result.current.mcpHook.setMCPValues(['initial-value']);
      });

      await waitFor(() => {
        expect(result.current.mcpHook.mcpValues).toEqual(['initial-value']);
      });

      // Set empty array externally (e.g., spec with no MCP servers)
      act(() => {
        result.current.setEphemeralAgent({
          mcp: [],
        });
      });

      // Jotai atom should be cleared — an explicit empty mcp array means
      // the spec (or reset) has no MCP servers, so the visual selection must clear
      await waitFor(() => {
        expect(result.current.mcpHook.mcpValues).toEqual([]);
      });
    });

    it('should handle ephemeralAgent being reset to null', async () => {
      // Create a shared wrapper
      const { Wrapper, servers } = createWrapper(['server1', 'server2']);

      // Create a component that uses both hooks
      const TestComponent = () => {
        const mcpHook = useMCPSelect({ servers, ownsChatSelection: true });
        const setEphemeralAgent = useSetRecoilState(ephemeralAgentByConvoId(Constants.NEW_CONVO));
        return { mcpHook, setEphemeralAgent };
      };

      const { result } = renderHook(() => TestComponent(), { wrapper: Wrapper });

      // Set initial values
      act(() => {
        result.current.mcpHook.setMCPValues(['server1', 'server2']);
      });

      await waitFor(() => {
        expect(result.current.mcpHook.mcpValues).toEqual(['server1', 'server2']);
      });

      // Reset ephemeralAgent to null (simulating non-spec reset)
      act(() => {
        result.current.setEphemeralAgent(null);
      });

      // mcpValues should remain unchanged since null ephemeral agent
      // doesn't trigger the sync effect (mcps.length === 0)
      await waitFor(() => {
        expect(result.current.mcpHook.mcpValues).toEqual(['server1', 'server2']);
      });
    });

    it('should properly sync non-empty arrays from ephemeralAgent', async () => {
      // Additional test to ensure non-empty arrays DO sync
      const { Wrapper, servers } = createWrapper([
        'value1',
        'value2',
        'value3',
        'value4',
        'value5',
      ]);

      const TestComponent = () => {
        const mcpHook = useMCPSelect({ servers, ownsChatSelection: true });
        const setEphemeralAgent = useSetRecoilState(ephemeralAgentByConvoId(Constants.NEW_CONVO));
        return { mcpHook, setEphemeralAgent };
      };

      const { result } = renderHook(() => TestComponent(), { wrapper: Wrapper });

      // Set initial values through ephemeralAgent with non-empty array
      const initialValues = ['value1', 'value2'];
      act(() => {
        result.current.setEphemeralAgent({
          mcp: initialValues,
        });
      });

      // Should sync since it's non-empty
      await waitFor(() => {
        expect(result.current.mcpHook.mcpValues).toEqual(initialValues);
      });

      // Update with different non-empty values
      const updatedValues = ['value3', 'value4', 'value5'];
      act(() => {
        result.current.setEphemeralAgent({
          mcp: updatedValues,
        });
      });

      // Should sync the new values
      await waitFor(() => {
        expect(result.current.mcpHook.mcpValues).toEqual(updatedValues);
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle undefined conversationId', () => {
      const { Wrapper, servers } = createWrapper(['test']);
      const { result } = renderHook(
        () => useMCPSelect({ conversationId: undefined, servers, ownsChatSelection: true }),
        {
          wrapper: Wrapper,
        },
      );

      expect(result.current.mcpValues).toEqual([]);

      act(() => {
        result.current.setMCPValues(['test']);
      });

      expect(() => result.current).not.toThrow();
    });

    it('should handle empty string conversationId', () => {
      const { Wrapper, servers } = createWrapper();
      const { result } = renderHook(
        () => useMCPSelect({ conversationId: '', servers, ownsChatSelection: true }),
        {
          wrapper: Wrapper,
        },
      );

      expect(result.current.mcpValues).toEqual([]);
    });

    it('should handle very large arrays without performance issues', async () => {
      const largeArray = Array.from({ length: 1000 }, (_, i) => `value-${i}`);
      const { Wrapper, servers } = createWrapper(largeArray);
      const { result } = renderHook(() => useMCPSelect({ servers, ownsChatSelection: true }), {
        wrapper: Wrapper,
      });

      const startTime = performance.now();

      act(() => {
        result.current.setMCPValues(largeArray);
      });

      const endTime = performance.now();
      const executionTime = endTime - startTime;

      // Should complete within reasonable time (< 100ms)
      expect(executionTime).toBeLessThan(100);

      await waitFor(() => {
        expect(result.current.mcpValues).toEqual(largeArray);
      });
    });

    it('should cleanup properly on unmount', () => {
      const { Wrapper, servers } = createWrapper();
      const { unmount } = renderHook(() => useMCPSelect({ servers, ownsChatSelection: true }), {
        wrapper: Wrapper,
      });

      // Should unmount without errors
      expect(() => unmount()).not.toThrow();
    });
  });

  describe('Environment-Keyed Storage (storageContextKey)', () => {
    it('should use storageContextKey as atom key for new conversations', async () => {
      const { Wrapper, servers } = createWrapper(['server1', 'server2']);
      const storageContextKey = '__defaults__';

      // Hook A: new conversation with storageContextKey
      const { result: resultA } = renderHook(
        () =>
          useMCPSelect({
            conversationId: null,
            storageContextKey,
            servers,
            ownsChatSelection: true,
          }),
        { wrapper: Wrapper },
      );

      act(() => {
        resultA.current.setMCPValues(['server1']);
      });

      await waitFor(() => {
        expect(resultA.current.mcpValues).toEqual(['server1']);
      });

      // Hook B: new conversation WITHOUT storageContextKey (different environment)
      const { result: resultB } = renderHook(
        () => useMCPSelect({ conversationId: null, servers, ownsChatSelection: true }),
        { wrapper: Wrapper },
      );

      // Should NOT see server1 since it's a different atom (NEW_CONVO vs __defaults__)
      expect(resultB.current.mcpValues).toEqual([]);
    });

    it('should use conversationId as atom key for existing conversations even with storageContextKey', async () => {
      const conversationId = 'existing-convo-123';
      const { Wrapper, servers } = createWrapper(['server1', 'server2']);
      const storageContextKey = '__defaults__';

      const { result } = renderHook(
        () => useMCPSelect({ conversationId, storageContextKey, servers, ownsChatSelection: true }),
        { wrapper: Wrapper },
      );

      act(() => {
        result.current.setMCPValues(['server1', 'server2']);
      });

      await waitFor(() => {
        expect(result.current.mcpValues).toEqual(['server1', 'server2']);
      });

      // Verify timestamp was written to the conversation key, not the environment key
      const convoKey = `${LocalStorageKeys.LAST_MCP_}${conversationId}`;
      expect(setTimestamp).toHaveBeenCalledWith(convoKey);
    });

    it('should dual-write to environment key when storageContextKey is provided', async () => {
      const { Wrapper, servers } = createWrapper(['server1', 'server2']);
      const storageContextKey = '__defaults__';

      const { result } = renderHook(
        () =>
          useMCPSelect({
            conversationId: null,
            storageContextKey,
            servers,
            ownsChatSelection: true,
          }),
        { wrapper: Wrapper },
      );

      act(() => {
        result.current.setMCPValues(['server1', 'server2']);
      });

      await waitFor(() => {
        // Verify dual-write to environment key
        const envKey = `${LocalStorageKeys.LAST_MCP_}${storageContextKey}`;
        expect(localStorage.getItem(envKey)).toEqual(JSON.stringify(['server1', 'server2']));
        expect(setTimestamp).toHaveBeenCalledWith(envKey);
      });
    });

    it('should NOT dual-write when storageContextKey is undefined', async () => {
      const conversationId = 'convo-no-specs';
      const { Wrapper, servers } = createWrapper(['server1']);

      const { result } = renderHook(
        () => useMCPSelect({ conversationId, servers, ownsChatSelection: true }),
        {
          wrapper: Wrapper,
        },
      );

      act(() => {
        result.current.setMCPValues(['server1']);
      });

      await waitFor(() => {
        expect(result.current.mcpValues).toEqual(['server1']);
      });

      // Only the conversation-keyed timestamp should be set, no environment key
      const envKey = `${LocalStorageKeys.LAST_MCP_}__defaults__`;
      expect(localStorage.getItem(envKey)).toBeNull();
    });

    it('should isolate per-conversation state from environment defaults', async () => {
      const { Wrapper, servers } = createWrapper(['server1', 'server2', 'server3']);
      const storageContextKey = '__defaults__';

      // Set environment defaults via new conversation
      const { result: newConvoResult } = renderHook(
        () =>
          useMCPSelect({
            conversationId: null,
            storageContextKey,
            servers,
            ownsChatSelection: true,
          }),
        { wrapper: Wrapper },
      );

      act(() => {
        newConvoResult.current.setMCPValues(['server1', 'server2']);
      });

      await waitFor(() => {
        expect(newConvoResult.current.mcpValues).toEqual(['server1', 'server2']);
      });

      // Existing conversation should have its own isolated state
      const { result: existingResult } = renderHook(
        () =>
          useMCPSelect({
            conversationId: 'existing-convo',
            storageContextKey,
            servers,
            ownsChatSelection: true,
          }),
        { wrapper: Wrapper },
      );

      // Should start empty (its own atom), not inherit from defaults
      expect(existingResult.current.mcpValues).toEqual([]);

      // Set different value for existing conversation
      act(() => {
        existingResult.current.setMCPValues(['server3']);
      });

      await waitFor(() => {
        expect(existingResult.current.mcpValues).toEqual(['server3']);
      });

      // New conversation defaults should be unchanged
      expect(newConvoResult.current.mcpValues).toEqual(['server1', 'server2']);
    });
  });

  describe('Spec/Non-Spec Context Switching', () => {
    it('should clear MCP when ephemeral agent switches to empty mcp (spec with no MCP)', async () => {
      const { Wrapper, servers } = createWrapper(['server1', 'server2']);
      const storageContextKey = '__defaults__';

      const TestComponent = ({ ctxKey }: { ctxKey?: string }) => {
        const mcpHook = useMCPSelect({
          conversationId: null,
          storageContextKey: ctxKey,
          servers,
          ownsChatSelection: true,
        });
        const setEphemeralAgent = useSetRecoilState(ephemeralAgentByConvoId(Constants.NEW_CONVO));
        return { mcpHook, setEphemeralAgent };
      };

      // Start in non-spec context with some servers selected
      const { result } = renderHook(() => TestComponent({ ctxKey: storageContextKey }), {
        wrapper: Wrapper,
      });

      act(() => {
        result.current.mcpHook.setMCPValues(['server1', 'server2']);
      });

      await waitFor(() => {
        expect(result.current.mcpHook.mcpValues).toEqual(['server1', 'server2']);
      });

      // Simulate switching to a spec with no MCP — ephemeral agent gets mcp: []
      act(() => {
        result.current.setEphemeralAgent({ mcp: [] });
      });

      // MCP values should clear since the spec explicitly has no MCP servers
      await waitFor(() => {
        expect(result.current.mcpHook.mcpValues).toEqual([]);
      });
    });

    it('should handle ephemeral agent with spec MCP servers syncing to Jotai atom', async () => {
      const { Wrapper, servers } = createWrapper(['spec-server1', 'spec-server2']);

      const TestComponent = () => {
        const mcpHook = useMCPSelect({ conversationId: null, servers, ownsChatSelection: true });
        const setEphemeralAgent = useSetRecoilState(ephemeralAgentByConvoId(Constants.NEW_CONVO));
        return { mcpHook, setEphemeralAgent };
      };

      const { result } = renderHook(() => TestComponent(), { wrapper: Wrapper });

      // Simulate spec application setting ephemeral agent MCP
      act(() => {
        result.current.setEphemeralAgent({
          mcp: ['spec-server1', 'spec-server2'],
          execute_code: true,
        });
      });

      await waitFor(() => {
        expect(result.current.mcpHook.mcpValues).toEqual(['spec-server1', 'spec-server2']);
      });
    });

    it('should handle null ephemeral agent reset (non-spec with specs configured)', async () => {
      const { Wrapper, servers } = createWrapper(['server1', 'server2']);

      const TestComponent = () => {
        const mcpHook = useMCPSelect({ servers, ownsChatSelection: true });
        const setEphemeralAgent = useSetRecoilState(ephemeralAgentByConvoId(Constants.NEW_CONVO));
        return { mcpHook, setEphemeralAgent };
      };

      const { result } = renderHook(() => TestComponent(), { wrapper: Wrapper });

      // Set values from a spec
      act(() => {
        result.current.setEphemeralAgent({ mcp: ['server1', 'server2'] });
      });

      await waitFor(() => {
        expect(result.current.mcpHook.mcpValues).toEqual(['server1', 'server2']);
      });

      // Reset ephemeral agent to null (switching to non-spec)
      act(() => {
        result.current.setEphemeralAgent(null);
      });

      // mcpValues should remain unchanged — null ephemeral agent doesn't trigger sync
      // (BadgeRowContext will fill from localStorage defaults separately)
      await waitFor(() => {
        expect(result.current.mcpHook.mcpValues).toEqual(['server1', 'server2']);
      });
    });
  });

  describe('Chat-hidden servers (chatMenu: false)', () => {
    it('clears a persisted selection once the catalog reports every server hidden', async () => {
      const { Wrapper } = createWrapper();
      const storageKey = `${LocalStorageKeys.LAST_MCP_}${Constants.NEW_CONVO}`;
      localStorage.setItem(storageKey, JSON.stringify(['hidden-server']));

      const { result } = renderHook(
        () =>
          useMCPSelect({
            servers: [],
            allServers: createMCPServers(['hidden-server']),
            ownsChatSelection: true,
          }),
        { wrapper: Wrapper },
      );

      await waitFor(() => {
        expect(result.current.mcpValues).toEqual([]);
      });
    });

    it('clears the ephemeral agent too, so the request stops carrying the server', async () => {
      const { Wrapper } = createWrapper();

      const TestComponent = () => {
        const mcpHook = useMCPSelect({
          ownsChatSelection: true,
          servers: createMCPServers(['visible']),
          allServers: createMCPServers(['visible', 'hidden-server']),
        });
        const setEphemeralAgent = useSetRecoilState(ephemeralAgentByConvoId(Constants.NEW_CONVO));
        const ephemeralAgent = useRecoilValue(ephemeralAgentByConvoId(Constants.NEW_CONVO));
        return { mcpHook, ephemeralAgent, setEphemeralAgent };
      };

      const { result } = renderHook(() => TestComponent(), { wrapper: Wrapper });

      act(() => {
        result.current.setEphemeralAgent({ mcp: ['visible', 'hidden-server'] });
      });

      await waitFor(() => {
        expect(result.current.ephemeralAgent?.mcp).toEqual(['visible']);
        expect(result.current.mcpHook.mcpValues).toEqual(['visible']);
      });
    });

    it('keeps a server a model spec pins, even though the menu hides it', async () => {
      mockStartupConfig = {
        modelSpecs: { list: [{ name: 'pins-hidden', mcpServers: ['spec-server'] }] },
      };
      const { Wrapper } = createWrapper();

      const TestComponent = () => {
        const mcpHook = useMCPSelect({
          ownsChatSelection: true,
          servers: createMCPServers(['visible']),
          allServers: createMCPServers(['visible', 'spec-server', 'stale-hidden']),
          specName: 'pins-hidden',
        });
        const setEphemeralAgent = useSetRecoilState(ephemeralAgentByConvoId(Constants.NEW_CONVO));
        const ephemeralAgent = useRecoilValue(ephemeralAgentByConvoId(Constants.NEW_CONVO));
        return { mcpHook, ephemeralAgent, setEphemeralAgent };
      };

      const { result } = renderHook(() => TestComponent(), { wrapper: Wrapper });

      act(() => {
        result.current.setEphemeralAgent({
          mcp: ['visible', 'spec-server', 'stale-hidden'],
        });
      });

      await waitFor(() => {
        expect(result.current.ephemeralAgent?.mcp).toEqual(['visible', 'spec-server']);
        expect(result.current.mcpHook.mcpValues).toEqual(['visible', 'spec-server']);
      });
    });

    it("lets a catalog-only instance leave the picker instance's selection alone", async () => {
      mockStartupConfig = {
        modelSpecs: { list: [{ name: 'pins-hidden', mcpServers: ['spec-server'] }] },
      };
      const { Wrapper } = createWrapper();

      /** Mirrors `useSideNavLinks`, which is always mounted and shares the
       *  NEW_CONVO selection but knows nothing about the active spec. */
      const TestComponent = () => {
        const picker = useMCPSelect({
          servers: createMCPServers(['visible']),
          allServers: createMCPServers(['visible', 'spec-server']),
          specName: 'pins-hidden',
          ownsChatSelection: true,
        });
        useMCPSelect({
          servers: createMCPServers(['visible']),
          allServers: createMCPServers(['visible', 'spec-server']),
        });
        const setEphemeralAgent = useSetRecoilState(ephemeralAgentByConvoId(Constants.NEW_CONVO));
        const ephemeralAgent = useRecoilValue(ephemeralAgentByConvoId(Constants.NEW_CONVO));
        return { picker, ephemeralAgent, setEphemeralAgent };
      };

      const { result } = renderHook(() => TestComponent(), { wrapper: Wrapper });

      act(() => {
        result.current.setEphemeralAgent({ mcp: ['visible', 'spec-server'] });
      });

      await waitFor(() => {
        expect(result.current.picker.mcpValues).toEqual(['visible', 'spec-server']);
      });
      expect(result.current.ephemeralAgent?.mcp).toEqual(['visible', 'spec-server']);
    });

    it('mirrors the selection into a non-owner instance so its actions build on it', async () => {
      const { Wrapper } = createWrapper();

      /** Mirrors `MCPServerCard`, which mounts the manager for its actions only;
       *  those actions derive the next selection from `mcpValues`. */
      const TestComponent = () => {
        const actions = useMCPSelect({ servers: createMCPServers(['server1', 'server2']) });
        const setEphemeralAgent = useSetRecoilState(ephemeralAgentByConvoId(Constants.NEW_CONVO));
        return { actions, setEphemeralAgent };
      };

      const { result } = renderHook(() => TestComponent(), { wrapper: Wrapper });

      act(() => {
        result.current.setEphemeralAgent({ mcp: ['server1'] });
      });

      await waitFor(() => {
        expect(result.current.actions.mcpValues).toEqual(['server1']);
      });

      act(() => {
        result.current.actions.setMCPValues([...result.current.actions.mcpValues, 'server2']);
      });

      await waitFor(() => {
        expect(result.current.actions.mcpValues).toEqual(['server1', 'server2']);
      });
    });

    it('keeps a selection while the catalog is empty, so a degraded read cannot wipe it', async () => {
      const { Wrapper } = createWrapper();
      const storageKey = `${LocalStorageKeys.LAST_MCP_}${Constants.NEW_CONVO}`;
      localStorage.setItem(storageKey, JSON.stringify(['server1', 'server2']));

      const { result, rerender } = renderHook(
        ({ servers, allServers }) => useMCPSelect({ servers, allServers, ownsChatSelection: true }),
        {
          initialProps: {
            servers: [] as MCPServerDefinition[],
            allServers: [] as MCPServerDefinition[],
          },
          wrapper: Wrapper,
        },
      );

      await waitFor(() => {
        expect(result.current.mcpValues).toEqual(['server1', 'server2']);
      });

      rerender({
        servers: createMCPServers(['server1', 'server2']),
        allServers: createMCPServers(['server1', 'server2']),
      });

      await waitFor(() => {
        expect(result.current.mcpValues).toEqual(['server1', 'server2']);
      });
    });

    it('falls back to the selectable list when no unfiltered catalog is passed', async () => {
      const { Wrapper } = createWrapper();
      const storageKey = `${LocalStorageKeys.LAST_MCP_}${Constants.NEW_CONVO}`;
      localStorage.setItem(storageKey, JSON.stringify(['server1', 'stale']));

      const { result } = renderHook(
        () => useMCPSelect({ servers: createMCPServers(['server1']), ownsChatSelection: true }),
        { wrapper: Wrapper },
      );

      await waitFor(() => {
        expect(result.current.mcpValues).toEqual(['server1']);
      });
    });
  });

  describe('Memory Leak Prevention', () => {
    it('should not leak memory on repeated updates', async () => {
      const values = Array.from({ length: 100 }, (_, i) => `value-${i}`);
      const { Wrapper, servers } = createWrapper(values);
      const { result } = renderHook(() => useMCPSelect({ servers, ownsChatSelection: true }), {
        wrapper: Wrapper,
      });

      // Perform many updates to test for memory leaks
      for (let i = 0; i < 100; i++) {
        act(() => {
          result.current.setMCPValues([`value-${i}`]);
        });
      }

      // If we get here without crashing, memory management is likely OK
      expect(result.current.mcpValues).toEqual(['value-99']);
    });

    it('should handle component remounting', () => {
      const { Wrapper, servers } = createWrapper();
      const { result, unmount } = renderHook(
        () => useMCPSelect({ servers, ownsChatSelection: true }),
        {
          wrapper: Wrapper,
        },
      );

      act(() => {
        result.current.setMCPValues(['before-unmount']);
      });

      unmount();

      // Remount
      const { Wrapper: Wrapper2, servers: servers2 } = createWrapper();
      const { result: newResult } = renderHook(
        () => useMCPSelect({ servers: servers2, ownsChatSelection: true }),
        {
          wrapper: Wrapper2,
        },
      );

      // Should handle remounting gracefully
      expect(newResult.current.mcpValues).toBeDefined();
    });
  });

  describe('defaultPinnedTools (admin-configured default pin)', () => {
    it('keeps the MCP dropdown pinned by default when "mcp" is listed', async () => {
      mockStartupConfig = { interface: { defaultPinnedTools: ['artifacts', 'mcp'] } };
      const { Wrapper, servers } = createWrapper();
      const { result } = renderHook(() => useMCPSelect({ servers, ownsChatSelection: true }), {
        wrapper: Wrapper,
      });

      await waitFor(() => {
        expect(result.current.isPinned).toBe(true);
      });
    });

    it('unpins the MCP dropdown by default when configured without "mcp"', async () => {
      mockStartupConfig = { interface: { defaultPinnedTools: ['artifacts'] } };
      const { Wrapper, servers } = createWrapper(['serverA']);
      const { result } = renderHook(() => useMCPSelect({ servers, ownsChatSelection: true }), {
        wrapper: Wrapper,
      });

      await waitFor(() => {
        expect(result.current.isPinned).toBe(false);
      });
    });

    it('pins the MCP dropdown when a configured server name is listed', async () => {
      mockStartupConfig = { interface: { defaultPinnedTools: ['serverA'] } };
      const { Wrapper, servers } = createWrapper(['serverA', 'serverB']);
      const { result } = renderHook(() => useMCPSelect({ servers, ownsChatSelection: true }), {
        wrapper: Wrapper,
      });

      await waitFor(() => {
        expect(result.current.isPinned).toBe(true);
      });
    });

    it('keeps the legacy pinned default when defaultPinnedTools is not configured', async () => {
      mockStartupConfig = { interface: {} };
      const { Wrapper, servers } = createWrapper(['serverA']);
      const { result } = renderHook(() => useMCPSelect({ servers, ownsChatSelection: true }), {
        wrapper: Wrapper,
      });

      await waitFor(() => {
        expect(result.current.isPinned).toBe(true);
      });
    });

    it('respects a stored user preference over the configured default', async () => {
      localStorage.setItem(LocalStorageKeys.PIN_MCP_, JSON.stringify(false));
      mockStartupConfig = { interface: { defaultPinnedTools: ['mcp'] } };
      const { Wrapper, servers } = createWrapper();
      const { result } = renderHook(() => useMCPSelect({ servers, ownsChatSelection: true }), {
        wrapper: Wrapper,
      });

      await waitFor(() => {
        expect(result.current.isPinned).toBe(false);
      });
    });
  });
});

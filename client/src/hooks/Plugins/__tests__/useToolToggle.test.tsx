import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { LocalStorageKeys, Tools } from 'librechat-data-provider';
import { RecoilRoot, useRecoilValue, useSetRecoilState } from 'recoil';
import useLocalStorage from '~/hooks/useLocalStorageAlt';
import { ephemeralAgentByConvoId } from '~/store';
import { useToolToggle } from '../useToolToggle';

/**
 * Tests for useToolToggle — the hook responsible for toggling tool badges
 * (code execution, web search, file search, artifacts) and persisting state.
 *
 * Desired behaviors:
 * - User toggles persist to per-conversation localStorage
 * - In non-spec mode with specs configured (storageContextKey = '__defaults__'),
 *   toggles ALSO persist to the defaults key so future new conversations inherit them
 * - In spec mode (storageContextKey = undefined), toggles only persist per-conversation
 * - The hook reflects the current ephemeral agent state
 */

// Mutable startup config so tests can vary `interface.defaultPinnedTools`
let mockStartupConfig: { interface?: { defaultPinnedTools?: string[] } } | undefined;

// Mock data-provider auth query + startup config
jest.mock('~/data-provider', () => ({
  useVerifyAgentToolAuth: jest.fn().mockReturnValue({
    data: { authenticated: true },
  }),
  useGetStartupConfig: jest.fn(() => ({ data: mockStartupConfig })),
}));

// Mock timestamps (track calls without actual localStorage timestamp logic)
jest.mock('~/utils/timestamps', () => ({
  setTimestamp: jest.fn(),
}));

// Mock useLocalStorageAlt (isPinned state — not relevant to our behavior tests)
jest.mock('~/hooks/useLocalStorageAlt', () => jest.fn(() => [false, jest.fn()]));

const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <RecoilRoot>{children}</RecoilRoot>
);

describe('useToolToggle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    mockStartupConfig = undefined;
  });

  // ─── Dual-Write Behavior ───────────────────────────────────────────

  describe('non-spec mode: dual-write to defaults key', () => {
    const storageContextKey = '__defaults__';

    it('should write to both conversation key and defaults key when user toggles a tool', () => {
      const conversationId = 'convo-123';
      const { result } = renderHook(
        () =>
          useToolToggle({
            conversationId,
            storageContextKey,
            toolKey: Tools.execute_code,
            localStorageKey: LocalStorageKeys.LAST_CODE_TOGGLE_,
            isAuthenticated: true,
          }),
        { wrapper: Wrapper },
      );

      act(() => {
        result.current.handleChange({ value: true });
      });

      // Conversation key: per-conversation persistence
      const convoKey = `${LocalStorageKeys.LAST_CODE_TOGGLE_}${conversationId}`;
      // Defaults key: persists for future new conversations
      const defaultsKey = `${LocalStorageKeys.LAST_CODE_TOGGLE_}${storageContextKey}`;

      // Sync effect writes to conversation key
      expect(localStorage.getItem(convoKey)).toBe(JSON.stringify(true));
      // handleChange dual-writes to defaults key
      expect(localStorage.getItem(defaultsKey)).toBe(JSON.stringify(true));
    });

    it('should persist false values to defaults key when user disables a tool', () => {
      const { result } = renderHook(
        () =>
          useToolToggle({
            conversationId: 'convo-456',
            storageContextKey,
            toolKey: Tools.web_search,
            localStorageKey: LocalStorageKeys.LAST_WEB_SEARCH_TOGGLE_,
            isAuthenticated: true,
          }),
        { wrapper: Wrapper },
      );

      // Enable then disable
      act(() => {
        result.current.handleChange({ value: true });
      });
      act(() => {
        result.current.handleChange({ value: false });
      });

      const defaultsKey = `${LocalStorageKeys.LAST_WEB_SEARCH_TOGGLE_}${storageContextKey}`;
      expect(localStorage.getItem(defaultsKey)).toBe(JSON.stringify(false));
    });
  });

  describe('spec mode: no dual-write', () => {
    it('should only write to conversation key, not to any defaults key', () => {
      const conversationId = 'spec-convo-789';
      const { result } = renderHook(
        () =>
          useToolToggle({
            conversationId,
            storageContextKey: undefined, // spec mode
            toolKey: Tools.execute_code,
            localStorageKey: LocalStorageKeys.LAST_CODE_TOGGLE_,
            isAuthenticated: true,
          }),
        { wrapper: Wrapper },
      );

      act(() => {
        result.current.handleChange({ value: true });
      });

      // Conversation key should have the value
      const convoKey = `${LocalStorageKeys.LAST_CODE_TOGGLE_}${conversationId}`;
      expect(localStorage.getItem(convoKey)).toBe(JSON.stringify(true));

      // Defaults key should NOT have a value
      const defaultsKey = `${LocalStorageKeys.LAST_CODE_TOGGLE_}__defaults__`;
      expect(localStorage.getItem(defaultsKey)).toBeNull();
    });
  });

  // ─── Per-Conversation Isolation ────────────────────────────────────

  describe('per-conversation isolation', () => {
    it('should maintain separate toggle state per conversation', () => {
      const TestComponent = ({ conversationId }: { conversationId: string }) => {
        const toggle = useToolToggle({
          conversationId,
          toolKey: Tools.execute_code,
          localStorageKey: LocalStorageKeys.LAST_CODE_TOGGLE_,
          isAuthenticated: true,
        });
        const ephemeralAgent = useRecoilValue(ephemeralAgentByConvoId(conversationId));
        return { toggle, ephemeralAgent };
      };

      // Conversation A: enable code
      const { result: resultA } = renderHook(() => TestComponent({ conversationId: 'convo-A' }), {
        wrapper: Wrapper,
      });

      act(() => {
        resultA.current.toggle.handleChange({ value: true });
      });

      // Conversation B: disable code
      const { result: resultB } = renderHook(() => TestComponent({ conversationId: 'convo-B' }), {
        wrapper: Wrapper,
      });

      act(() => {
        resultB.current.toggle.handleChange({ value: false });
      });

      // Each conversation has its own value in localStorage
      expect(localStorage.getItem(`${LocalStorageKeys.LAST_CODE_TOGGLE_}convo-A`)).toBe('true');
      expect(localStorage.getItem(`${LocalStorageKeys.LAST_CODE_TOGGLE_}convo-B`)).toBe('false');
    });
  });

  // ─── Ephemeral Agent Sync ──────────────────────────────────────────

  describe('ephemeral agent reflects toggle state', () => {
    it('should update ephemeral agent when user toggles a tool', async () => {
      const conversationId = 'convo-sync-test';
      const TestComponent = () => {
        const toggle = useToolToggle({
          conversationId,
          toolKey: Tools.execute_code,
          localStorageKey: LocalStorageKeys.LAST_CODE_TOGGLE_,
          isAuthenticated: true,
        });
        const ephemeralAgent = useRecoilValue(ephemeralAgentByConvoId(conversationId));
        return { toggle, ephemeralAgent };
      };

      const { result } = renderHook(() => TestComponent(), { wrapper: Wrapper });

      act(() => {
        result.current.toggle.handleChange({ value: true });
      });

      await waitFor(() => {
        expect(result.current.ephemeralAgent?.execute_code).toBe(true);
      });

      act(() => {
        result.current.toggle.handleChange({ value: false });
      });

      await waitFor(() => {
        expect(result.current.ephemeralAgent?.execute_code).toBe(false);
      });
    });

    it('should reflect external ephemeral agent changes in toolValue', async () => {
      const conversationId = 'convo-external';
      const TestComponent = () => {
        const toggle = useToolToggle({
          conversationId,
          toolKey: Tools.web_search,
          localStorageKey: LocalStorageKeys.LAST_WEB_SEARCH_TOGGLE_,
          isAuthenticated: true,
        });
        const setEphemeralAgent = useSetRecoilState(ephemeralAgentByConvoId(conversationId));
        return { toggle, setEphemeralAgent };
      };

      const { result } = renderHook(() => TestComponent(), { wrapper: Wrapper });

      // External update (e.g., from applyModelSpecEphemeralAgent)
      act(() => {
        result.current.setEphemeralAgent({ web_search: true, execute_code: false });
      });

      await waitFor(() => {
        expect(result.current.toggle.toolValue).toBe(true);
        expect(result.current.toggle.isToolEnabled).toBe(true);
      });
    });

    it('should sync externally-set ephemeral agent values to localStorage', async () => {
      const conversationId = 'convo-sync-ls';
      const TestComponent = () => {
        const toggle = useToolToggle({
          conversationId,
          toolKey: Tools.file_search,
          localStorageKey: LocalStorageKeys.LAST_FILE_SEARCH_TOGGLE_,
          isAuthenticated: true,
        });
        const setEphemeralAgent = useSetRecoilState(ephemeralAgentByConvoId(conversationId));
        return { toggle, setEphemeralAgent };
      };

      const { result } = renderHook(() => TestComponent(), { wrapper: Wrapper });

      // Simulate applyModelSpecEphemeralAgent setting a value
      act(() => {
        result.current.setEphemeralAgent({ file_search: true });
      });

      // The sync effect should write to conversation-keyed localStorage
      await waitFor(() => {
        const storageKey = `${LocalStorageKeys.LAST_FILE_SEARCH_TOGGLE_}${conversationId}`;
        expect(localStorage.getItem(storageKey)).toBe(JSON.stringify(true));
      });
    });
  });

  // ─── isToolEnabled computation ─────────────────────────────────────

  describe('isToolEnabled computation', () => {
    it('should return false when tool is not set', () => {
      const { result } = renderHook(
        () =>
          useToolToggle({
            conversationId: 'convo-1',
            toolKey: Tools.execute_code,
            localStorageKey: LocalStorageKeys.LAST_CODE_TOGGLE_,
            isAuthenticated: true,
          }),
        { wrapper: Wrapper },
      );

      expect(result.current.isToolEnabled).toBe(false);
    });

    it('should treat non-empty string as enabled (artifacts)', async () => {
      const conversationId = 'convo-artifacts';
      const TestComponent = () => {
        const toggle = useToolToggle({
          conversationId,
          toolKey: 'artifacts',
          localStorageKey: LocalStorageKeys.LAST_ARTIFACTS_TOGGLE_,
          isAuthenticated: true,
        });
        const setEphemeralAgent = useSetRecoilState(ephemeralAgentByConvoId(conversationId));
        return { toggle, setEphemeralAgent };
      };

      const { result } = renderHook(() => TestComponent(), { wrapper: Wrapper });

      act(() => {
        result.current.setEphemeralAgent({ artifacts: 'default' });
      });

      await waitFor(() => {
        expect(result.current.toggle.isToolEnabled).toBe(true);
      });
    });

    it('should treat empty string as disabled (artifacts off)', async () => {
      const conversationId = 'convo-no-artifacts';
      const TestComponent = () => {
        const toggle = useToolToggle({
          conversationId,
          toolKey: 'artifacts',
          localStorageKey: LocalStorageKeys.LAST_ARTIFACTS_TOGGLE_,
          isAuthenticated: true,
        });
        const setEphemeralAgent = useSetRecoilState(ephemeralAgentByConvoId(conversationId));
        return { toggle, setEphemeralAgent };
      };

      const { result } = renderHook(() => TestComponent(), { wrapper: Wrapper });

      act(() => {
        result.current.setEphemeralAgent({ artifacts: '' });
      });

      await waitFor(() => {
        expect(result.current.toggle.isToolEnabled).toBe(false);
      });
    });
  });

  // ─── Default pinned state from interface.defaultPinnedTools ─────────

  describe('defaultPinnedTools (admin-configured default pin)', () => {
    const renderToolToggle = () =>
      renderHook(
        () =>
          useToolToggle({
            toolKey: Tools.execute_code,
            localStorageKey: LocalStorageKeys.LAST_CODE_TOGGLE_,
            isAuthenticated: true,
          }),
        { wrapper: Wrapper },
      );

    it('seeds the pinned state to true when the tool key is listed', () => {
      mockStartupConfig = { interface: { defaultPinnedTools: ['execute_code', 'mcp'] } };
      renderToolToggle();
      expect(useLocalStorage).toHaveBeenCalledWith(
        `${LocalStorageKeys.LAST_CODE_TOGGLE_}pinned`,
        true,
      );
    });

    it('seeds the pinned state to false when the tool key is not listed', () => {
      mockStartupConfig = { interface: { defaultPinnedTools: ['artifacts'] } };
      renderToolToggle();
      expect(useLocalStorage).toHaveBeenCalledWith(
        `${LocalStorageKeys.LAST_CODE_TOGGLE_}pinned`,
        false,
      );
    });

    it('seeds the pinned state to false when defaultPinnedTools is not configured', () => {
      mockStartupConfig = undefined;
      renderToolToggle();
      expect(useLocalStorage).toHaveBeenCalledWith(
        `${LocalStorageKeys.LAST_CODE_TOGGLE_}pinned`,
        false,
      );
    });
  });
});

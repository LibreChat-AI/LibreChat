import { atom } from 'jotai';
import { atomFamily, atomWithStorage } from 'jotai/utils';
import { Constants, LocalStorageKeys } from 'librechat-data-provider';
import { createTabIsolatedStorage } from './jotai-utils';

/**
 * Tab-isolated storage for MCP values — prevents cross-tab sync so that
 * each tab's MCP server selections are independent (especially for new chats
 * which all share the same `LAST_MCP_new` localStorage key).
 */
const mcpTabIsolatedStorage = createTabIsolatedStorage<string[]>();

/**
 * Creates a storage atom for MCP values per conversation
 * Uses atomFamily to create unique atoms for each conversation ID
 */
export const mcpValuesAtomFamily = atomFamily((conversationId: string | null) => {
  const key = conversationId ?? Constants.NEW_CONVO;
  const storageKey = `${LocalStorageKeys.LAST_MCP_}${key}`;

  return atomWithStorage<string[]>(storageKey, [], mcpTabIsolatedStorage, { getOnInit: true });
});

/**
 * Global storage atom for MCP pinned state (shared across all conversations)
 */
export const mcpPinnedAtom = atomWithStorage<boolean>(LocalStorageKeys.PIN_MCP_, true, undefined, {
  getOnInit: true,
});

/**
 * Server initialization state - shared globally so chat dropdown and settings panel
 * both see the same OAuth/initialization state.
 *
 * This enables canceling OAuth from either location.
 */
export interface MCPServerInitState {
  isInitializing: boolean;
  isCancellable: boolean;
  oauthUrl: string | null;
  oauthStartTime: number | null;
  /** Last initialize attempt reported a request-scoped server whose connection
   * is deferred to the next chat turn (runtime body placeholders) — its tools
   * cannot be enumerated up front. Consumers attach such servers wholesale via
   * the `mcp_all` wildcard instead of waiting for a tool list. */
  connectionDeferred: boolean;
}

const defaultServerInitState: MCPServerInitState = {
  isInitializing: false,
  isCancellable: false,
  oauthUrl: null,
  oauthStartTime: null,
  connectionDeferred: false,
};

/**
 * Global atom for MCP server initialization states.
 * Keyed by server name.
 */
export const mcpServerInitStatesAtom = atom<Record<string, MCPServerInitState>>({});

/**
 * Helper to get or create a server's init state
 */
export const getServerInitState = (
  states: Record<string, MCPServerInitState>,
  serverName: string,
): MCPServerInitState => {
  return states[serverName] || defaultServerInitState;
};

import { useContext } from 'react';
import type { ChatSurface, SubagentPanelActions } from './context';
import type { ActiveSubagentPanel } from './state';
import { ChatSurfaceContext, SubagentPanelActionsContext } from './context';

export type { ChatSurface, SubagentPanelActions } from './context';

export function useChatSurface(): ChatSurface {
  const surface = useContext(ChatSurfaceContext);
  if (surface == null) {
    throw new Error('useChatSurface must be used within a ChatSurfaceProvider');
  }
  return surface;
}

/** The host, where one exists. A subagent card is rendered by every message
 *  renderer, and search results are not a chat surface. */
export function useOptionalChatSurface(): ChatSurface | null {
  return useContext(ChatSurfaceContext);
}

/** The panel actions, or `null` where there is no surface to open a panel on. */
export function useSubagentPanelActions(): SubagentPanelActions | null {
  return useContext(SubagentPanelActionsContext);
}

/**
 * Selecting a child for the panel and taking the foreground are one action:
 * the panel and whatever else occupies that slot cannot both be open, so a
 * selection made without the yield leaves the reader looking at the other one.
 *
 * `null` where there is no host: a search result renders the same card, but
 * that route has no panel to open, so the card is not openable there.
 */
export function useOpenSubagentPanel(): ((selection: ActiveSubagentPanel) => void) | null {
  return useSubagentPanelActions()?.open ?? null;
}

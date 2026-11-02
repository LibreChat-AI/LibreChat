import { useMemo } from 'react';
import { useSetAtom } from 'jotai';
import type { ReactNode } from 'react';
import type { ChatSurface, SubagentPanelActions } from './context';
import { ChatSurfaceContext, SubagentPanelActionsContext } from './context';
import { activeSubagentPanel, subagentPanelFocusRequest } from './state';

/** Mounts the host's surface and binds the activity panel's actions to it. */
export function ChatSurfaceProvider({
  value,
  children,
}: {
  value: ChatSurface;
  children: ReactNode;
}): ReactNode {
  const { claimForeground } = value;
  const setSelection = useSetAtom(activeSubagentPanel);
  const requestFocus = useSetAtom(subagentPanelFocusRequest);
  const actions = useMemo<SubagentPanelActions>(
    () => ({
      open: (selection) => {
        claimForeground();
        setSelection(selection);
        requestFocus((current) => current + 1);
      },
      update: setSelection,
    }),
    [claimForeground, requestFocus, setSelection],
  );
  return (
    <ChatSurfaceContext.Provider value={value}>
      <SubagentPanelActionsContext.Provider value={actions}>
        {children}
      </SubagentPanelActionsContext.Provider>
    </ChatSurfaceContext.Provider>
  );
}

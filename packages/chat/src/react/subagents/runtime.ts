import { useCallback } from 'react';
import { useAtom, useAtomValue, useStore } from 'jotai';
import type { SubagentControlUiState } from './state';
import type { SubagentPanelState } from './context';
import {
  subagentControlStateByTask,
  subagentPanelFocusRequest,
  useSubagentProgress,
} from './state';
import { useSubagentActivityStream } from './stream';

function useControlStateWriter(): (identity: string, state: SubagentControlUiState | null) => void {
  const store = useStore();
  return useCallback(
    (identity: string, state: SubagentControlUiState | null) =>
      store.set(subagentControlStateByTask(identity), state),
    [store],
  );
}

/** The panel state `ChatSurfaceProvider` supplies: the atoms behind `SubagentPanelState`. */
export const subagentPanelState: SubagentPanelState = {
  useFocusRequest: () => useAtomValue(subagentPanelFocusRequest),
  useProgress: useSubagentProgress,
  useControlState: (identity) => useAtom(subagentControlStateByTask(identity)),
  useControlStateWriter,
  useActivityStream: useSubagentActivityStream,
};

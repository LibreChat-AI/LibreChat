import { createContext } from 'react';
import type { Context, Dispatch, SetStateAction } from 'react';
import type { ActiveSubagentPanel, SubagentControlUiState, SubagentProgress } from './state';
import type { ComposerBindings } from '../../core/shortcuts';

/**
 * Everything this feature needs from the application hosting it, and nothing
 * it owns itself. Reading these through the host instead of the app store is
 * what keeps the feature liftable: a second host already exists (the shared
 * conversation view), and a host outside this repository would satisfy the
 * same six members without the feature learning where they come from.
 */
export interface ChatSurface {
  /** Enter submits a composer; without it, Enter inserts a newline. */
  enterToSend: boolean;
  /** Message rows stretch to the container instead of the reading column. */
  maximizeChatSpace: boolean;
  /** The reader wants a jump-to-bottom control on scrollable transcripts. */
  showScrollButton: boolean;
  /** The reader's effective composer shortcut bindings. */
  composerBindings: ComposerBindings;
  /** Take the shell's foreground slot: the host closes whatever else holds it. */
  claimForeground: () => void;
  /** Carry unsent composer words into a conversation the host is about to open. */
  handOffComposerText: (conversationId: string, text: string) => void;
}

/** What the surface does with the activity panel, bound by `ChatSurfaceProvider`. */
export type SubagentPanelActions = {
  /** Claims the foreground, selects the child and moves focus into the panel. */
  open: (selection: ActiveSubagentPanel) => void;
  /** Rewrites the current selection in place, without claiming anything. */
  update: Dispatch<SetStateAction<ActiveSubagentPanel | null>>;
};

/**
 * The activity panel's own state, which lives in atoms. The panel reads it through this
 * contract instead of the atoms, so the component loads none. Members are hooks, called
 * unconditionally, and the object never changes.
 */
export interface SubagentPanelState {
  /** Bumped each time a caller asks the panel to take focus. */
  useFocusRequest: () => number;
  /** The live progress of one invocation, retained while the caller is mounted. */
  useProgress: (invocationKey: string) => SubagentProgress | null;
  /** The pending or failed control command of one task, persisted across reloads. */
  useControlState: (
    identity: string,
  ) => [SubagentControlUiState | null, Dispatch<SetStateAction<SubagentControlUiState | null>>];
  /** Writes another task's control state, for a response that lands after the reader moved on. */
  useControlStateWriter: () => (identity: string, state: SubagentControlUiState | null) => void;
  /** Replays, then follows, the selected child's activity while `enabled`. */
  useActivityStream: (selection: ActiveSubagentPanel, enabled?: boolean) => { isReady: boolean };
}

/**
 * Written by `ChatSurfaceProvider` and read by the hooks in `surface.tsx`, apart from the
 * provider, so a component reading the surface loads no atom: the components entry stays free
 * of module-scope state, which a consumer that stubs its state library trips over on import.
 */
export const ChatSurfaceContext: Context<ChatSurface | null> = createContext<ChatSurface | null>(
  null,
);
export const SubagentPanelActionsContext: Context<SubagentPanelActions | null> =
  createContext<SubagentPanelActions | null>(null);
export const SubagentPanelStateContext: Context<SubagentPanelState | null> =
  createContext<SubagentPanelState | null>(null);

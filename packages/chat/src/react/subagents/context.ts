import { createContext } from 'react';
import type { Context, Dispatch, SetStateAction } from 'react';
import type { ComposerBindings } from '../../core/shortcuts';
import type { ActiveSubagentPanel } from './state';

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
 * Written by `ChatSurfaceProvider` and read by the hooks in `surface.tsx`, apart from the
 * provider, so a component reading the surface loads no atom: the components entry stays free
 * of module-scope state, which a consumer that stubs its state library trips over on import.
 */
export const ChatSurfaceContext: Context<ChatSurface | null> = createContext<ChatSurface | null>(
  null,
);
export const SubagentPanelActionsContext: Context<SubagentPanelActions | null> =
  createContext<SubagentPanelActions | null>(null);

import type { TChatProject, TConversation } from 'librechat-data-provider';
import type { ChatPaneView } from './view';

/** What the pane shows around its column, derived from the session and the host's footers. */
export type ChatPaneChrome = {
  /** The conversation's title for the page heading, or `null` for the new-chat label. */
  title: string | null;
  /** The full footer: the welcome screen, with the landing footer on. */
  fullFooter: boolean;
  /** Whether the full footer sits directly under the composer rather than below the column. */
  composerFooter: boolean;
  /** The configured footer inside the composer band, wherever the full one is not shown. */
  bandFooter: boolean;
  /** Whether a footer sits in the composer's clearance. Under the composer, it takes its own room. */
  footerBelow: boolean;
  /** The project a new chat starts in, on a project's welcome screen. */
  landingProject?: TChatProject;
  /** The project of the routed conversation, for its badge. */
  projectId?: string;
  /** A subagent's thread: an execution record its parent owns, which the reader cannot continue. */
  readOnly: boolean;
  /** The conversation that owns a subagent's thread. */
  parentConversationId?: string;
};

/**
 * Derives the pane's chrome. The app's conversation can lag the route during navigation, so only
 * a conversation whose id matches the routed one names the title, the project and the subagent
 * lineage.
 */
export function getChatPaneChrome({
  view,
  conversation,
  conversationId,
  project,
  landingFooter,
  configuredFooter,
}: {
  view: ChatPaneView;
  conversation?: TConversation | null;
  /** The routed conversation. */
  conversationId?: string;
  /** The project the route opens a new chat in. */
  project?: TChatProject;
  /** The deployment shows the full footer on the welcome screen, and where. */
  landingFooter: boolean | 'composer';
  /** The deployment configured footer content. */
  configuredFooter: boolean;
}): ChatPaneChrome {
  const active = conversation?.conversationId === conversationId ? conversation : undefined;
  const subagentThread = active?.subagentThread;
  const fullFooter = view.isLanding && landingFooter !== false;
  const composerFooter = fullFooter && landingFooter === 'composer';
  const bandFooter = !fullFooter && configuredFooter;
  const title = active?.title?.trim();
  return {
    title: view.isLanding || !title ? null : title,
    fullFooter,
    composerFooter,
    bandFooter,
    footerBelow: bandFooter || (fullFooter && !composerFooter),
    landingProject: view.isLanding && project != null ? project : undefined,
    projectId: active?.chatProjectId || undefined,
    readOnly: subagentThread != null,
    parentConversationId: subagentThread?.parentConversationId,
  };
}

import { createContext, useContext } from 'react';
import type { SearchResultData, TAttachment, TMessageContentParts } from 'librechat-data-provider';
import type { MouseEventHandler, ReactNode } from 'react';
import type { SteerReceiptState } from '../../components/composer/steering/Receipt';
import type { TaskContentScope } from './scope';

/** What a transcript asks the host to draw a child's content parts with. */
export type SubagentContentPartsProps = {
  content: TMessageContentParts[];
  messageId: string;
  conversationId: string | null;
  attachments?: TAttachment[];
  searchResults?: Record<string, SearchResultData>;
  authorHeader?: ReactNode;
  isSubmitting: boolean;
  showThinking: boolean;
};

/** One guidance message sent to a child, drawn as the main chat draws a steer. */
export type SubagentSteerProps = {
  steer: string;
  steerId: string;
  createdAt: number;
  receiptState: SteerReceiptState | null;
  isSubmitting: boolean;
  hasMore?: boolean;
  onExpand?: () => void;
};

/** The transcript's jump-to-latest control, and whether the reader has scrolled away from it. */
export type SubagentJumpToLatestProps = {
  visible: boolean;
  onClick: MouseEventHandler<HTMLButtonElement>;
  maximizeChatSpace: boolean;
};

/** A guidance message the transcript was handed shortened, read in full on request. */
export type SubagentRetainedControl = {
  message?: string;
  isFetching: boolean;
  isError: boolean;
  refetch: () => void;
};

/**
 * What a subagent transcript reads from the app: render slots for the parts it shares with the
 * main chat and has not received yet, and the one read it makes. Members are hooks or slots,
 * called unconditionally, and a host stays the same object for the life of the tree it wraps.
 */
export interface SubagentsHost {
  /** Draws a child's content with the app's content-parts renderer. */
  renderContentParts: (props: SubagentContentPartsProps) => ReactNode;
  /** Draws one guidance message with the app's steer renderer. */
  renderSteer: (props: SubagentSteerProps) => ReactNode;
  /**
   * Draws the jump-to-latest control with the app's enter and exit animation. Without it the
   * package's `ScrollToBottom` shows while `visible`, unanimated.
   */
  renderJumpToLatest?: (props: SubagentJumpToLatestProps) => ReactNode;
  /** The full text of a shortened guidance message, fetched only while `enabled`. */
  useRetainedControl: (
    scope: TaskContentScope,
    invocationId: string,
    enabled: boolean,
  ) => SubagentRetainedControl;
}

const idleControl: SubagentRetainedControl = {
  isFetching: false,
  isError: false,
  refetch: () => undefined,
};

/** The host a transcript reads before an app registers one: no slots and no reads. */
const fallbackHost: SubagentsHost = {
  renderContentParts: () => null,
  renderSteer: () => null,
  useRetainedControl: () => idleControl,
};

const SubagentsHostContext = createContext<SubagentsHost | null>(null);

let defaultHost: SubagentsHost = fallbackHost;

/**
 * Registers the host that transcripts rendered outside any `SubagentsHostProvider` read. An app
 * registers its own once, when the module that builds it loads; a provider always wins over it.
 */
export function setDefaultSubagentsHost(host: SubagentsHost): void {
  defaultHost = host;
}

/** Supplies the host subagent transcripts read from. */
export function SubagentsHostProvider({
  host,
  children,
}: {
  host: SubagentsHost;
  children: ReactNode;
}): ReactNode {
  return <SubagentsHostContext.Provider value={host}>{children}</SubagentsHostContext.Provider>;
}

/** The host of the nearest provider, else the registered default, else the fallback. */
export function useSubagentsHost(): SubagentsHost {
  return useContext(SubagentsHostContext) ?? defaultHost;
}

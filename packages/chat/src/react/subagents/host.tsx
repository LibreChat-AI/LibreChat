import { createContext, useContext } from 'react';
import type {
  Agent,
  TConversation,
  SubagentThreadView,
  SubagentControlRequest,
  SubagentControlResponse,
  ToolCallPartParams,
  ToolCallPartResponse,
  SubagentTaskContentSnapshot,
} from 'librechat-data-provider';
import type { MouseEventHandler, ReactNode } from 'react';
import type { SteerReceiptState } from '../../components/composer/steering/Receipt';
import type { ToolContentQuery } from '../parts/disclosure';
import type { MessagePartsHost } from '../host';
import type { TaskContentScope } from './scope';

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

/** A task's recovered content, read from the parent-authorized task endpoint. */
export type SubagentTaskContent = {
  data?: SubagentTaskContentSnapshot;
  isError: boolean;
  /** The task predates content recovery, so there is nothing to retry. */
  isUnavailable: boolean;
  refetch: () => void;
};

/** A child thread's durable view, read through the parent conversation. */
export type SubagentThreadRead = {
  data?: SubagentThreadView;
  isLoading: boolean;
  isError: boolean;
  /** `data` still describes the previous key while the new one loads. */
  isPreviousData: boolean;
  /** The child has not published its thread yet, inside the readiness window. */
  isReadinessPending: boolean;
  /** Stable across renders, so effects can depend on it. */
  refetch: () => void;
};

export type SubagentThreadReadOptions = {
  /** Keep the previous key's view mounted while a new key loads. */
  keepPreviousData?: boolean;
  /** Poll at this interval instead of the thread's own readiness schedule. */
  refetchInterval?: number;
};

/** One steering command sent to a running child. */
export type SubagentControlVariables = {
  parentConversationId: string;
  threadId: string;
  command: SubagentControlRequest;
  /** Client-only timestamp retained across retries; never sent to the API. */
  submittedAt: string;
};

/** A child thread carried into a conversation of the reader's own. */
export type SubagentContinueVariables = {
  conversationId: string;
  messageId: string;
};

export type SubagentMutationHandlers<TData, TVariables> = {
  onSuccess?: (data: TData, variables: TVariables) => void;
  onError?: (error: unknown, variables: TVariables) => void;
};

export type SubagentMutation<TVariables> = {
  mutate: (variables: TVariables) => void;
  isLoading: boolean;
};

/** A parent tool call's stored part. */
export type SubagentToolCallPart = {
  data?: ToolCallPartResponse;
  isError: boolean;
  refetch: () => void;
};

/** Where the thread panel sends the reader. */
export type SubagentNavigation = {
  /** Opens a conversation the app already holds, as the chat list does. */
  openConversation: (conversation: TConversation) => void;
  /** Opens a conversation by id. */
  openConversationId: (conversationId: string) => void;
};

/**
 * What a subagent transcript reads from the app: render slots for the parts it shares with the
 * main chat and has not received yet, and the one read it makes. Members are hooks or slots,
 * called unconditionally, and a host stays the same object for the life of the tree it wraps.
 */
export interface SubagentsHost {
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
  /** A task's recovered content, read only while `enabled`. */
  useTaskContent: (scope: TaskContentScope, options: { enabled: boolean }) => SubagentTaskContent;
  /**
   * Reads a tool call's full output through the task scope, never the child's own messages.
   * Without it, recovered tool calls stay view-only.
   */
  useToolContent?: ToolContentQuery;
  /** The agents the viewer can see, keyed by id. */
  useAgentsMap: () => Record<string, Agent | undefined> | undefined;
  /**
   * The parts host a child conversation renders its content with: the parent's, with the members
   * that act on the parent's messages view stood down. Returns the same object while `host` is.
   */
  useChildPartsHost: (host: MessagePartsHost) => MessagePartsHost;
  /** A child thread's durable view, fetched while both ids are set. */
  useThread: (
    parentConversationId: string,
    threadId: string,
    taskId: string,
    options: SubagentThreadReadOptions,
  ) => SubagentThreadRead;
  /** Fetches one page of a child thread outside the cached read: a task's exact view, or the
   *  history before `cursor`. */
  loadThread: (
    parentConversationId: string,
    threadId: string,
    taskId?: string,
    cursor?: string,
  ) => Promise<SubagentThreadView>;
  /** Sends a steering command to a running child and reconciles the thread's receipts. */
  useControl: (
    handlers: SubagentMutationHandlers<SubagentControlResponse, SubagentControlVariables>,
  ) => SubagentMutation<SubagentControlVariables>;
  /** Forks a child thread into a conversation of the reader's own. */
  useContinueChat: (
    handlers: SubagentMutationHandlers<{ conversation?: TConversation }, SubagentContinueVariables>,
  ) => SubagentMutation<SubagentContinueVariables>;
  /** Reads a parent tool call's stored part through the parent message, while `enabled`. */
  useToolCallPart: (
    params: ToolCallPartParams,
    options: { enabled: boolean },
    revision?: string,
  ) => SubagentToolCallPart;
  /** Where the panel sends the reader. */
  useNavigation: () => SubagentNavigation;
  /** Whether the panel is a modal sheet over the chat rather than a region beside it. */
  useSheetLayout: () => boolean;
  /** Whether the deployment draws a footer bar the panel's composer has to clear. */
  useClearsFooter: () => boolean;
  /** Wraps a foreground child's activity in the parent's tool approval scope. */
  renderApprovalScope: (props: { scopeKey: string; children: ReactNode }) => ReactNode;
}

const idleControl: SubagentRetainedControl = {
  isFetching: false,
  isError: false,
  refetch: () => undefined,
};

const idleContent: SubagentTaskContent = {
  isError: false,
  isUnavailable: false,
  refetch: () => undefined,
};

const idleThread: SubagentThreadRead = {
  isLoading: false,
  isError: false,
  isPreviousData: false,
  isReadinessPending: false,
  refetch: () => undefined,
};

const idlePart: SubagentToolCallPart = { isError: false, refetch: () => undefined };

const idleNavigation: SubagentNavigation = {
  openConversation: () => undefined,
  openConversationId: () => undefined,
};

/** The host a transcript reads before an app registers one: no slots and no reads. */
const fallbackHost: SubagentsHost = {
  renderSteer: () => null,
  useRetainedControl: () => idleControl,
  useTaskContent: () => idleContent,
  useAgentsMap: () => undefined,
  useChildPartsHost: (host) => host,
  useThread: () => idleThread,
  loadThread: () => Promise.reject(new Error('subagents_host_required')),
  useControl: () => ({ mutate: () => undefined, isLoading: false }),
  useContinueChat: () => ({ mutate: () => undefined, isLoading: false }),
  useToolCallPart: () => idlePart,
  useNavigation: () => idleNavigation,
  useSheetLayout: () => false,
  useClearsFooter: () => false,
  renderApprovalScope: ({ children }) => children,
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

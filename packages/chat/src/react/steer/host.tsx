import { createContext, useContext } from 'react';
import type {
  TMessage,
  TConversation,
  CodeApprovalMode,
  CodeEnvironmentMode,
  TAgentQueuedTurnReceipt,
  TEnqueueAgentQueuedTurnRequest,
} from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type {
  ChatSteerResult,
  ChatSteerTarget,
  DuringRunAction,
  ChatSteerRequest,
  ChatStreamStatus,
  ChatArmSteerResult,
  ChatTransportError,
  ChatCancelSteerResult,
} from '../../core/types';
import type { StreamStatusResponse } from '../../core/resumable/host';
import type { FileDeliveryMetadataMap } from '../../core/files';

/** Callbacks of a fire-and-forget request, called once it settles. */
export type SteerRequestCallbacks<Result> = {
  onSuccess?: (result: Result) => void;
  onError?: (error: ChatTransportError) => void;
};

/** A toast the host shows on the steer surfaces' behalf. */
export type SteerNotification = {
  message: string;
  status: 'error' | 'info' | 'success' | 'warning';
};

/** The copy the steer hooks show, by the key the host's catalogue holds it under. */
export type SteerMessageKey =
  | 'com_ui_steer_already_applied'
  | 'com_ui_steer_arm_lost_race'
  | 'com_ui_steer_arm_unconfirmed'
  | 'com_ui_steer_cancel_failed'
  | 'com_ui_steer_paused_queued'
  | 'com_ui_steer_preempt_unsupported';

/** One mounted chat pane and the conversation it shows. */
export type SteerPane = {
  /** The pane key, as the app keys its panes (`0` for the main chat). */
  index: string | number;
  conversationId: string | null;
};

/** The app-global preferences and deployment limits the steer hooks read. */
export type SteerSettings = {
  duringRunDefaultAction: DuringRunAction;
  setDuringRunDefaultAction: (action: DuringRunAction) => void;
  queuedSendLockTimeoutMs?: number;
  queuedTurnReconciliationTimeoutMs?: number;
  steerArmConfirmationTimeoutMs?: number;
  /** The conversation each mounted chat pane shows, read when called rather than at render:
   *  steer recovery asks whether any pane holding a conversation is still running. */
  getPaneConversations: () => ReadonlyArray<SteerPane>;
};

/** What the host's caches already hold about a conversation's queued-turn handoff. */
export type QueuedTurnSnapshot = {
  receipts?: TAgentQueuedTurnReceipt[];
  status?: StreamStatusResponse;
};

/** Reads the cached handoff of one conversation without fetching it, and subscribes to changes
 *  of it. Both functions keep their identity while the conversation does. */
export type QueuedTurnCache = {
  read: () => QueuedTurnSnapshot;
  subscribe: (notify: () => void) => () => void;
};

/**
 * What the steer and queue hooks need from the app that hosts them. Every member is a hook,
 * called by a steer hook exactly where it needs the service, so the host can back each one with
 * its own query cache, router or store without the package reaching into any of them.
 */
export interface SteerHost {
  /** Posts a steer into the running generation. */
  useSteerMessage(): (
    request: ChatSteerRequest,
    callbacks?: SteerRequestCallbacks<ChatSteerResult>,
  ) => void;
  /** Posts a steer and settles with the server's answer even after the caller unmounts, which a
   *  retry from the thread needs: its row unmounts when the user navigates away mid-request. */
  useSteerMessageAsync(): (request: ChatSteerRequest) => Promise<ChatSteerResult>;
  /** Withdraws a steer that has not been injected yet. */
  useCancelSteer(): (
    request: ChatSteerTarget & { clientSteerId?: string },
  ) => Promise<ChatCancelSteerResult>;
  /** Escalates a queued steer to interrupt the running step. */
  useArmSteer(): (request: ChatSteerTarget) => Promise<ChatArmSteerResult>;
  /** Holds queued uploads past their upload window; failures are tolerated. */
  useMarkFilesUsage(): (body: { file_ids: string[] }) => void;
  /** Adds a durable queued turn behind the running one. */
  useEnqueueQueuedTurn(): (
    input: TEnqueueAgentQueuedTurnRequest,
    callbacks?: SteerRequestCallbacks<TAgentQueuedTurnReceipt>,
  ) => void;
  /** Cancels a durable queued turn. */
  useCancelQueuedTurn(): (input: {
    conversationId: string;
    queuedTurnId: string;
  }) => Promise<TAgentQueuedTurnReceipt>;
  /** The server's queued-turn receipts for a conversation, polled while any is unresolved. */
  useQueuedTurns(
    conversationId: string,
    enabled: boolean,
    clientRequestIds: string[],
    reconcileUntil: number | undefined,
    expectsReceipts: boolean,
  ): TAgentQueuedTurnReceipt[] | undefined;
  /** The queued-turn receipts and stream status the host has cached for a conversation, observed
   *  without registering a competing fetcher. */
  useQueuedTurnCache(conversationId: string): QueuedTurnCache;
  /** Reads a conversation's generation state, including steers it could not deliver. */
  useFetchStreamStatus(): (conversationId: string) => Promise<ChatStreamStatus>;
  /** The latest message of the pane, on the branch on screen. */
  useLatestMessage(index: number, conversationId: string | null): TMessage | null;
  /** The code approval mode a new turn would run under. */
  useCodeApprovalMode(
    conversation: TConversation | null,
    addedConversation?: TConversation | null,
    codeEnvironmentMode?: CodeEnvironmentMode,
  ): CodeApprovalMode | undefined;
  useLocalize(): (key: SteerMessageKey) => string;
  useNotify(): (notification: SteerNotification) => void;
  /** Delivery metadata of the files the user owns, by id. */
  useFileMap(): FileDeliveryMetadataMap | undefined;
  /** Drops the composer's pending file deletions once its attachments ride a message. */
  useClearFilesToDelete(): () => void;
  useSettings(): SteerSettings;
}

const SteerHostContext = createContext<SteerHost | null>(null);

export function SteerHostProvider({
  host,
  children,
}: {
  host: SteerHost;
  children?: ReactNode;
}): ReactNode {
  return <SteerHostContext.Provider value={host}>{children}</SteerHostContext.Provider>;
}

export function useSteerHost(): SteerHost {
  const host = useContext(SteerHostContext);
  if (host == null) {
    throw new Error('The steer hooks need a SteerHostProvider above them.');
  }
  return host;
}

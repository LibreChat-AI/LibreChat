import { createElement, createContext, useContext } from 'react';
import { atomFamily } from 'jotai/utils';
import { atom, useAtomValue } from 'jotai';
import { Constants } from 'librechat-data-provider';
import type { Agents, TEphemeralAgent, TMessage } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { Family } from './steer/family';

/**
 * The server-owned pending action for one conversation.
 *
 * Kept outside message rendering so the composer and timeline can project the
 * same action without making mounted cards the source of truth. This state is
 * memory-only: reload hydration comes from the stream status endpoint.
 */
export const pendingApprovalActionFamily: Family<Agents.PendingAction | null> = atomFamily(
  (_conversationId: string) => atom<Agents.PendingAction | null>(null),
);

/** Whether the composer's review panel is expanded for one conversation. */
export const approvalPanelOpenFamily: Family<boolean> = atomFamily((_conversationId: string) =>
  atom(false),
);

/**
 * True while the composer's review panel is open on this tool-approval action.
 * The panel then owns the decisions and the batch submit, and it overlays the
 * tail of the thread where the live approval card sits, so the thread card
 * steps back to a record of the request until the panel is collapsed.
 * Without a conversation there is no composer, so nothing is presented there.
 */
export function useComposerPresentsApproval(
  conversationId: string | null | undefined,
  actionId: string,
): boolean {
  const key = conversationId ?? Constants.NEW_CONVO;
  const pendingAction = useAtomValue(pendingApprovalActionFamily(key));
  const open = useAtomValue(approvalPanelOpenFamily(key));
  return (
    conversationId != null &&
    open &&
    pendingAction?.actionId === actionId &&
    pendingAction.payload.type === 'tool_approval'
  );
}

/** Fields the ordinary chat resume sends so the server can rebuild the paused agent. */
export interface ApprovalResumeFields {
  conversationId: string;
  /** Exact paused generation, when the client has observed it. */
  generationCreatedAt?: number;
  endpoint?: string | null;
  endpointType?: string | null;
  agent_id?: string | null;
  model?: string | null;
  spec?: string | null;
  promptPrefix?: string | null;
  ephemeralAgent?: TEphemeralAgent | null;
}

export type ApprovalResumeCallbacks = {
  onSuccess: () => void;
  onError: (error: unknown) => void;
};

/**
 * Ordinary chat I/O for a tool approval or an ask answer: the conversation fields, the resume
 * request, and the thread an ask answer patches locally. Absent when this view has no live
 * conversation. An explicit resume transport still wins over this host.
 *
 * This is not a member of the steer or stream hosts. Those providers throw when they are
 * missing, and this hook also runs from the composer, a response review, and shared renders,
 * where it must stay inert instead of throwing.
 */
export interface ApprovalResumeHost {
  /** Resume fields for the active conversation, or null when there is nothing to resume. */
  readFields: () => ApprovalResumeFields | null;
  submitToolApproval: (
    body: ApprovalResumeFields & {
      actionId: string;
      decisions: Agents.ToolApprovalResolution[];
    },
    callbacks: ApprovalResumeCallbacks,
  ) => void;
  submitAskAnswer: (
    body: ApprovalResumeFields & {
      actionId: string;
      answer?: string;
      answers?: Record<string, string>;
    },
    callbacks: ApprovalResumeCallbacks,
  ) => void;
  /** The thread the ordinary transport may patch after an ask answer. */
  readMessages: () => {
    messages: TMessage[];
    setMessages: (messages: TMessage[]) => void;
  } | null;
}

const ApprovalResumeHostContext = createContext<ApprovalResumeHost | null>(null);

export function ApprovalResumeHostProvider({
  host,
  children,
}: {
  host: ApprovalResumeHost;
  children?: ReactNode;
}): ReactNode {
  return createElement(ApprovalResumeHostContext.Provider, { value: host }, children);
}

export function useApprovalResumeHost(): ApprovalResumeHost | null {
  return useContext(ApprovalResumeHostContext);
}

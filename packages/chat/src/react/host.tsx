import { createContext, useContext } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { TFile } from 'librechat-data-provider';
import type { TShowToast } from '@librechat/client';

/** The message a part renders in, as its host reports it. */
export type MessagePartMessage = {
  /** Id of the message that owns the part, or `''` outside a message. */
  messageId: string;
  /** Whether that message is still generating. */
  isSubmitting?: boolean;
  /** Whether that message is the tail of the active branch. */
  isLatestMessage?: boolean;
  /** Content type of the part after this one, when known. */
  nextType?: string;
};

/** How the viewer prefers user-authored text to display. */
export type MessagePartsUserTextPreferences = {
  /** Whether user-authored text renders as markdown. */
  enableUserMsgMarkdown: boolean;
  /** Whether long user-authored text collapses behind a toggle. */
  collapseLongUserMessages: boolean;
  /** Whether user turns are labeled with the user's name. */
  usernameDisplay: boolean;
};

/** The signed-in user as the parts label it; `undefined` on a public share. */
export type MessagePartsUser = { name?: string; username?: string } | undefined;

/** Shows a transient notification. */
export type MessagePartsToast = (toast: TShowToast) => void;

/**
 * Everything the message part components read from the app, supplied by the view that renders
 * them through `MessagePartsHostProvider`. Members are hooks, called unconditionally by the parts
 * that need them, so keyed reads subscribe to one key only. A host must stay the same object for
 * the life of the tree it wraps. Setters are typed as React dispatchers, so
 * the contract names no state library.
 *
 * It is an interface so an app can declare the members of parts it has not handed to this
 * package yet, by augmenting `@librechat/chat/react`.
 */
export interface MessagePartsHost {
  /** The message the calling part renders in. */
  useMessage: () => MessagePartMessage;
  /** The viewer's font size utility, applied to reasoning and summary text. */
  useFontSize: () => string;
  /** Whether the viewer wants reasoning expanded by default. */
  useShowThinking: () => boolean;
  /** Whether the viewer wants tool cards and tool groups expanded by default. */
  useAutoExpandTools: () => boolean;
  /** How the viewer prefers user-authored text to display. */
  useUserTextPreferences: () => MessagePartsUserTextPreferences;
  /** The signed-in user. */
  useUser: () => MessagePartsUser;
  /** The user's uploaded files keyed by file id, used to hydrate attachment metadata. */
  useFileMap: () => Record<string, TFile> | undefined;
  /** The notification function. */
  useToast: () => MessagePartsToast;
  /** Whether the sandbox for a code tool call is still starting. */
  useSandboxStarting: (toolCallId: string) => boolean;
  /**
   * Which mounted card owns the row for a tool artifact, so one file renders once across tool
   * calls and messages. The key is the artifact id.
   */
  useToolArtifactClaim: (
    artifactId: string,
  ) => [string | null, Dispatch<SetStateAction<string | null>>];
  /** Whether a steer in a conversation is being escalated to an interrupt. */
  useSteerEscalating: (conversationId: string) => boolean;
  /** The conversation a pane is showing, or `null`. */
  usePaneConversationId: (index: number) => string | null;
  /**
   * Whether a steer was just applied live (and should animate in), plus a stable function that
   * clears that mark for a steer id once the part has seen it.
   */
  useLiveAppliedSteer: (steerId: string) => [boolean, (steerId: string) => void];
}

const MessagePartsHostContext = createContext<MessagePartsHost | null>(null);

let defaultHost: MessagePartsHost | null = null;

/**
 * Registers the host that parts rendered outside any `MessagePartsHostProvider` read, the way
 * `react-i18next` registers its instance. An app registers its own once, when the module that
 * builds it loads; a provider always wins over it.
 */
export function setDefaultMessagePartsHost(host: MessagePartsHost): void {
  defaultHost = host;
}

/** Supplies the host the message parts read from. */
export function MessagePartsHostProvider({
  host,
  children,
}: {
  host: MessagePartsHost;
  children: ReactNode;
}): ReactNode {
  return (
    <MessagePartsHostContext.Provider value={host}>{children}</MessagePartsHostContext.Provider>
  );
}

/** The host of the nearest provider, or the registered default. */
export function useMessagePartsHost(): MessagePartsHost {
  const host = useContext(MessagePartsHostContext) ?? defaultHost;
  if (host == null) {
    throw new Error(
      'Message parts need a host: render them inside MessagePartsHostProvider or register one with setDefaultMessagePartsHost.',
    );
  }
  return host;
}

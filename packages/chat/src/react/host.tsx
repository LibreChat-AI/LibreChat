import { createContext, useContext } from 'react';
import type {
  Agent,
  TFile,
  TAttachment,
  SearchResultData,
  TMessageContentParts,
} from 'librechat-data-provider';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { TShowToast } from '@librechat/client';
import type { ToolCallPhase } from '../core/parts/toolCallPhase';

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
  /** Conversation of that message, when it has one. */
  conversationId?: string | null;
  /** Position of the part in the message's content, when it renders one part. */
  partIndex?: number;
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
export type MessagePartsUser = { id?: string; name?: string; username?: string } | undefined;

/** Shows a transient notification. */
export type MessagePartsToast = (toast: TShowToast) => void;

/** What a caller asks the host's content-parts renderer to draw: a message's parts, and the row
 *  state around them. Omitted row fields take an assistant reply's defaults: not the user's,
 *  the last row, and latest while it is submitting. */
export type ContentPartsSlotProps = {
  /** Holes stay where a streaming or parallel index has no part yet; positions are part indexes. */
  content: Array<TMessageContentParts | undefined>;
  messageId: string;
  conversationId: string | null;
  attachments?: TAttachment[];
  searchResults?: Record<string, SearchResultData>;
  authorHeader?: ReactNode;
  isSubmitting: boolean;
  showThinking: boolean;
  edit?: boolean;
  enterEdit?: (cancel?: boolean) => void | null | undefined;
  siblingIdx?: number;
  setSiblingIdx?: ((value: number) => void) | null;
  isCreatedByUser?: boolean;
  isLast?: boolean;
  isLatestMessage?: boolean;
  manualSkills?: string[];
  renderOwnerId?: string;
  createdAt?: string | null;
  foldLiveActivity?: boolean;
};

/** Where the calling message is rendered: a public share link, or the reader's own chat. */
export type MessagePartsShare = {
  isSharedConvo?: boolean;
  shareId?: string;
};

/** Strings a tool call card asks the host to resolve. Values fill `{0}`-style placeholders. */
export type ToolCallLocalize = (key: string, values?: Record<string, string | number>) => string;

/** What the app's progress row draws for one tool call. */
export type ToolCallProgressProps = {
  phase: ToolCallPhase;
  onClick: () => void;
  inProgressText: string;
  authText?: string;
  finishedText: string;
  subtitle?: string;
  durationMs?: number;
  toolPreparationDurationMs?: number;
  toolExecutionDurationMs?: number;
  phaseStartAt?: number;
  phaseStepId?: string;
  icon: ReactNode;
  hasInput: boolean;
  isExpanded: boolean;
};

/** What the app's parameter and output panel draws for one tool call. */
export type ToolCallInfoProps = {
  input: string;
  output?: string | null;
};

/** What the app's tool icon draws for one tool call. `name` is the raw tool id. */
export type ToolCallIconProps = {
  name: string;
  iconUrl?: string;
  isAnimating: boolean;
};

/**
 * App services and renderers for a generic tool call card. The progress row, parameter panel,
 * icon and attachment stack stay in the app because other cards still share them.
 */
export type ToolCallChrome = {
  localize: ToolCallLocalize;
  /** Configured MCP server names in the normalized form tool keys use. */
  mcpServerNames: readonly string[];
  /** Icon URL for an MCP server, when the catalog has one. */
  mcpIconUrl: (serverName: string) => string | undefined;
  bindMCPOAuth: (serverName: string) => Promise<unknown>;
  bindActionOAuth: (actionId: string) => Promise<unknown>;
  /** Opens a URL in a new tab. Called synchronously inside the sign-in click. */
  openUrl: (url: string) => void;
  logError: (message: string, error?: unknown) => void;
  renderProgress: (props: ToolCallProgressProps) => ReactNode;
  renderInfo: (props: ToolCallInfoProps) => ReactNode;
  renderIcon: (props: ToolCallIconProps) => ReactNode;
  renderAttachments: (attachments: TAttachment[]) => ReactNode;
};

const emptyChrome: ToolCallChrome = {
  localize: (key) => key,
  mcpServerNames: [],
  mcpIconUrl: () => undefined,
  bindMCPOAuth: () => Promise.resolve(undefined),
  bindActionOAuth: () => Promise.resolve(undefined),
  openUrl: () => undefined,
  logError: () => undefined,
  renderProgress: () => null,
  renderInfo: () => null,
  renderIcon: () => null,
  renderAttachments: () => null,
};

/** A chrome that renders nothing and binds nothing. Test hosts that never draw a tool call use it. */
export function emptyToolCallChrome(): ToolCallChrome {
  return emptyChrome;
}

/** What a part asks the host's image renderer to draw: an attached image, opened full size on click. */
export type MessagePartsImageProps = {
  imagePath: string;
  altText: string;
  alignRight?: boolean;
  className?: string;
  width?: number;
  height?: number;
};

/** What a part asks the host's file preview dialog to show for an attached file. */
export type MessagePartsFilePreviewProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fileName: string;
  fileId?: string;
  filePath?: string;
  fileType?: string;
  fileSource?: string;
  fileSize?: number;
  deliveryPath?: TFile['llmDeliveryPath'];
  /** Retrieval hits carry these so the preview can order pages by relevance. */
  relevance?: number;
  pages?: number[];
  pageRelevance?: Record<number, number>;
};

/** What a part asks the host's markdown renderer to draw. */
export type MessagePartsMarkdownProps = {
  /** The markdown source. */
  content: string;
  /** `full` for assistant text, `lite` for user-authored text rendered as markdown. */
  variant: 'full' | 'lite';
  /** Whether the text belongs to the tail of the active branch. */
  isLatestMessage: boolean;
  /** `false` draws code blocks without run controls, for text that is shown and never run. */
  codeExecution?: boolean;
};

/**
 * Everything the message part components read from the app, supplied by the view that renders
 * them through `MessagePartsHostProvider`. Members are hooks, called unconditionally by the parts
 * that need them, so keyed reads subscribe to one key only; `render*` members are slots that return
 * the app's own elements, for renderers too large to move (markdown) or owned elsewhere (icons).
 * A host must stay the same object for
 * the life of the tree it wraps. Setters are typed as React dispatchers, so
 * the contract names no state library.
 *
 * It is an interface so an app can declare the members of parts it has not handed to this
 * package yet, by augmenting `@librechat/chat/react`.
 */
export interface MessagePartsHost {
  /** The message the calling part renders in. */
  useMessage: () => MessagePartMessage;
  /** Renders markdown with the app's renderer. */
  renderMarkdown: (props: MessagePartsMarkdownProps) => ReactNode;
  /** Renders an attached image with the app's image viewer. */
  renderImage: (props: MessagePartsImageProps) => ReactNode;
  /** Renders the app's preview dialog for an attached file. */
  renderFilePreview: (props: MessagePartsFilePreviewProps) => ReactNode;
  /** Whether streamed text fades in word by word: the viewer's setting, unless motion is reduced. */
  useSmoothStreaming: () => boolean;
  /** An agent the viewer can see, by id. */
  useAgent: (agentId: string) => Agent | undefined;
  /** Draws a message's content parts with the app's renderer. */
  renderContentParts: (props: ContentPartsSlotProps) => ReactNode;
  /** Renders an agent's avatar; `undefined` when the agent is unknown. */
  renderAgentIcon: (agent: Agent | undefined) => ReactNode;
  /** Renders an agent's bare inline avatar, without the message icon around it. */
  renderAgentAvatar: (agent: Agent | undefined) => ReactNode;
  /** The viewer's font size utility, applied to reasoning and summary text. */
  useFontSize: () => string;
  /** Whether the viewer wants reasoning expanded by default. */
  useShowThinking: () => boolean;
  /** Whether the viewer wants tool cards and tool groups expanded by default. */
  useAutoExpandTools: () => boolean;
  /** Whether the viewer wants LaTeX in markdown rendered as math. */
  useLaTeXParsing: () => boolean;
  /** The direction chat text is typed in; `auto` resolves it from the text itself. */
  useChatDirection: () => 'auto' | 'ltr' | 'rtl';
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
  /** Whether the calling message renders under a public share link, and which. */
  useShare: () => MessagePartsShare;
  /** Localization, MCP lookups, OAuth binding and the app's renderers for a generic tool call. */
  useToolCallChrome: () => ToolCallChrome;
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

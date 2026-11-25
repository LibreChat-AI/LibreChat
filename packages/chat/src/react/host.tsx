import { createContext, useContext } from 'react';
import type {
  AgentDisplay,
  BalanceDisplay,
  EModelEndpoint,
  TFile,
  TAttachment,
  SearchResultData,
  ToolCallPartParams,
  ToolCallPartResponse,
  TMessageContentParts,
} from 'librechat-data-provider';
import type { UseQueryOptions, QueryObserverResult } from '@tanstack/react-query';
import type { Dispatch, ElementType, ReactNode, SetStateAction } from 'react';
import type { TShowToast } from '@librechat/client';
import type { PluggableList } from 'unified';
import type { ErrorEnvironment, ErrorSource } from '../core/errors';
import type { CurrencyConfig } from '../core/usage/format';
import type { ApprovalResumeHost } from './approval';
import type { AskCardMode } from './parts/ask';
import type { PtcTrace } from '../core/ptc';

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

/** A skill a call loaded, as the reader's library holds it now. */
export type LoadedSkill = {
  /** The skill's current instructions, which may have changed since the call ran. */
  instructions: string;
  /** Opens the skill in the app. */
  open: () => void;
};

/** Strings a tool call card asks the host to resolve. Values fill `{0}`-style placeholders. */
export type ToolCallLocalize = (key: string, values?: Record<string, string | number>) => string;

/**
 * App services for a generic tool call card, and its one renderer: the attachment stack stays
 * in the app because other cards still share it.
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
  renderAttachments: () => null,
};

/** A chrome that renders nothing and binds nothing. Test hosts that never draw a tool call use it. */
export function emptyToolCallChrome(): ToolCallChrome {
  return emptyChrome;
}

/** A fenced code block the markdown elements ask the host to draw. */
export type MarkdownCodeBlockProps = {
  lang: string;
  codeChildren: ReactNode;
  /** Whether the surface lets its reader run code. A reply does; a prompt or skill preview does not. */
  executable: boolean;
  /** The block's position among the reply's executable blocks, in document order. */
  blockIndex?: number;
};

/** A `mermaid` fence a reply's markdown asks the host to draw. */
export type MarkdownMermaidProps = {
  code: string;
  /** Stable for the fence's position in a message; absent on a preview surface. */
  id?: string;
  /** Whether a diagram that throws while rendering is caught and shown as its source. */
  guarded: boolean;
};

/** Loads a stored tool call part; the app's query, or a nested transcript's own. */
export type ToolContentQuery = (
  params: ToolCallPartParams,
  config?: UseQueryOptions<ToolCallPartResponse>,
  revision?: string,
) => QueryObserverResult<ToolCallPartResponse>;

/**
 * What a host adds to the markdown of a reply: syntax of its own and the elements that draw it,
 * such as citations or embedded resources.
 */
export type MarkdownExtensions = {
  /** remark plugins, run after the package's own in the order given. */
  remarkPlugins?: PluggableList;
  /** Elements by node name, for what those plugins produce. One can also replace a package element. */
  elements?: { [nodeType: string]: ElementType };
};

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

/** Whether the reader may open the agent builder, as an agent error offers it. */
export type AgentBuilderAccess = {
  /** The reader holds both the use and the create permission for agents. */
  canUseBuilder: boolean;
  /** The reader is an administrator, who may edit any agent. */
  isAdmin: boolean;
};

/** How the deployment shows balances: credits, money in a currency, or a share of the allotment. */
export type MessagePartsBalanceDisplay = { display: BalanceDisplay; currency?: CurrencyConfig };

/** What an error asks the host's key dialog to edit: the reader's own credentials for an endpoint. */
export type SetKeyDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  endpoint: string;
  endpointType?: EModelEndpoint;
  userProvideURL?: boolean | null;
  userProvideAccessKeyId?: boolean;
  userProvideSecretAccessKey?: boolean;
  userProvideSessionToken?: boolean;
  userProvideBearerToken?: boolean;
};

/** The failure a host's recovery actions are drawn for. */
export type ErrorActionsProps = {
  /** The failed turn's text as persisted. */
  text: string;
  /** The failed message, when the caller has it; an error part reads it from its context. */
  messageId?: string;
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
  /** Renders markdown, for a host with a renderer of its own. Without it a part draws the
   *  package's `Markdown`, or `MarkdownLite` for the `lite` variant. */
  renderMarkdown?: (props: MessagePartsMarkdownProps) => ReactNode;
  /**
   * Renders plain text while it is still streaming, so a reasoning stream can fade its words in.
   * Absent, the part shows the text as it is.
   */
  renderStreamingText?: (text: string) => ReactNode;
  /** Renders an attached image, for a host with a viewer of its own. Without it a part draws the
   *  package's `Image`. */
  renderImage?: (props: MessagePartsImageProps) => ReactNode;
  /** Renders the app's preview dialog for an attached file. */
  renderFilePreview: (props: MessagePartsFilePreviewProps) => ReactNode;
  /** Whether streamed text fades in word by word: the viewer's setting, unless motion is reduced. */
  useSmoothStreaming: () => boolean;
  /** An agent the viewer can see, by id. */
  useAgent: (agentId: string) => AgentDisplay | undefined;
  /**
   * Draws a message's content parts, for a host that adds to the package's `ContentParts`; build
   * it with `contentPartsRenderer(slots)`. Without it the package's renderer draws them with no
   * slots.
   */
  renderContentParts?: (props: ContentPartsSlotProps) => ReactNode;
  /** Renders an agent's avatar; `undefined` when the agent is unknown. */
  renderAgentIcon: (agent: AgentDisplay | undefined) => ReactNode;
  /** Renders an agent's bare inline avatar, without the message icon around it. */
  renderAgentAvatar: (agent: AgentDisplay | undefined) => ReactNode;
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
  /** Live inner-call trace of one programmatic tool call in one message. */
  usePtcTrace: (messageId: string, toolCallId: string) => PtcTrace;
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
  /**
   * The skill a call loaded by name, when the reader can open exactly that skill: names are
   * unique only per author, so a name that matches none, several, or a skill the reader cannot
   * see resolves to `undefined`. While `enabled` is false the lookup is skipped.
   */
  useLoadedSkill: (name: string, enabled: boolean) => LoadedSkill | undefined;
  /** Localization, MCP lookups, OAuth binding and the app's renderers for a generic tool call. */
  useToolCallChrome: () => ToolCallChrome;
  /**
   * Draws a fenced code block, for a host that adds to the package's `CodeBlock`: a run button,
   * the output of its runs. Without it a fence is the package's block, which copies and downloads
   * and runs nothing.
   */
  renderCodeBlock?: (props: MarkdownCodeBlockProps) => ReactNode;
  /** Draws a `mermaid` fence. Without it the fence is an ordinary code block. */
  renderMermaid?: (props: MarkdownMermaidProps) => ReactNode;
  /**
   * A hook a markdown link calls once per render with the id of the file it points at, or `''`
   * for any other link. The function it returns resolves to a URL the browser can save, or to
   * nothing when the file could not be fetched. Without it a file link is an ordinary link.
   */
  useFileDownload?: (fileId: string) => () => Promise<string | undefined>;
  /**
   * A hook that loads the stored content of one tool call, for a call the server sent as a
   * preview: its arguments or output shortened, or a subagent's activity left out. It runs once
   * the reader opens the card. Without it a previewed call says its content could not be loaded.
   */
  useToolCallPart?: ToolContentQuery;
  /**
   * A hook that returns how a paused tool call or question in the calling message resumes the run:
   * the conversation's fields and the requests that send a decision or an answer. Called by the
   * approval controls and the question card. Without it, or when it returns `null`, they use an
   * `ApprovalResumeHostProvider` above them; with neither, they render disabled and say the request
   * cannot be answered from here.
   */
  useApprovalResumeHost?: () => ApprovalResumeHost | null;
  /**
   * A hook that shares a paused question with the host's composer, for a host whose composer can
   * take the question over. Called with the conversation of the calling message. Without it the
   * question is answered in its card only.
   */
  useAskAnswerMode?: (conversationId: string | null | undefined) => AskCardMode;
  /**
   * The host's additions to a reply's markdown, or nothing. Called while rendering, so it must
   * return the same object until the additions change. The lighter renderer for cards and the
   * error boundary's fallback do not use them.
   */
  markdownExtensions?: () => MarkdownExtensions | null | undefined;
  /**
   * Told when an error boundary of the package's caught a render that threw, with the boundary's
   * name (`'markdown'`). For a host's error reporting; the boundary has already drawn its fallback.
   */
  onBoundaryError?: (boundary: string, error: Error) => void;
  /**
   * A hook an error card calls with the row that failed, returning what the host knows beyond it:
   * the conversation the chat shows, the agents a transcript can name, the endpoint configuration
   * and whether compaction is offered. It must return the same object until one of those changes.
   * Without it an error names what its row says and nothing more: key ownership stays unknown, so
   * the copy is the generic sentence and no key can be updated from the card.
   */
  useErrorEnvironment?: (source?: ErrorSource) => ErrorEnvironment;
  /** A hook: whether the reader may open the agent builder. Without it an agent error never
   *  claims the reader can edit the agent, and names its owner or an administrator instead. */
  useAgentBuilderAccess?: () => AgentBuilderAccess;
  /** A hook: how the deployment shows balances. Without it a balance error shows credits. */
  useBalanceDisplay?: () => MessagePartsBalanceDisplay;
  /**
   * Draws the host's dialog for the reader's own key of an endpoint, opened from a key error.
   * Without it a key error explains itself and offers no button.
   */
  renderSetKeyDialog?: (props: SetKeyDialogProps) => ReactNode;
  /**
   * Draws what a reader can do about a failure beyond reading it, such as sending the turn again
   * without its files, inside the error's box under its text. Without it the error stands alone.
   */
  renderErrorActions?: (props: ErrorActionsProps) => ReactNode;
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

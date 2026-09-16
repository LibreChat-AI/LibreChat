import { RefObject } from 'react';
import { FileSources, EModelEndpoint, isEphemeralAgentId } from 'librechat-data-provider';
import type { UseMutationResult } from '@tanstack/react-query';
import type * as InputNumberPrimitive from 'rc-input-number';
import type { SetterOrUpdater, RecoilState } from 'recoil';
import type { ColumnDef } from '@tanstack/react-table';
import type * as t from 'librechat-data-provider';
import type { LucideIcon } from 'lucide-react';
import type { TranslationKeys } from '~/hooks';
import { MCPServerDefinition } from '~/hooks/MCP/useMCPServerManager';

export function isEphemeralAgent(agentId: string | null | undefined): boolean {
  return isEphemeralAgentId(agentId);
}

export interface ConfigFieldDetail {
  title: string;
  description: string;
  /** Whether the field holds a secret and should be masked (defaults to masked when omitted). */
  sensitive?: boolean;
}

export type CodeBarProps = {
  lang: string;
  error?: boolean;
  plugin?: boolean;
  blockIndex?: number;
  allowExecution?: boolean;
  codeRef: RefObject<HTMLElement>;
};

export enum PromptsEditorMode {
  SIMPLE = 'simple',
  ADVANCED = 'advanced',
}

export enum STTEndpoints {
  browser = 'browser',
  external = 'external',
}

export enum TTSEndpoints {
  browser = 'browser',
  external = 'external',
}

export type AudioChunk = {
  audio: string;
  isFinal: boolean;
  alignment: {
    char_start_times_ms: number[];
    chars_durations_ms: number[];
    chars: string[];
  };
  normalizedAlignment: {
    char_start_times_ms: number[];
    chars_durations_ms: number[];
    chars: string[];
  };
};

export type BadgeItem = {
  id: string;
  icon: React.ComponentType<any>;
  label: string;
  atom: RecoilState<boolean>;
  isAvailable: boolean;
};

export type AssistantListItem = {
  id: string;
  name: string;
  metadata: t.Assistant['metadata'];
  model: string;
};

export type AgentListItem = {
  id: string;
  name: string;
  avatar: t.Agent['avatar'];
};

export type TPluginMap = Record<string, t.TPlugin>;

export type GenericSetter<T> = (value: T | ((currentValue: T) => T)) => void;

export type LastSelectedModels = Record<t.EModelEndpoint, string>;

export type LocalizeFunction = (
  phraseKey: TranslationKeys,
  options?: Record<string, string | number>,
) => string;

export type ChatFormValues = { text: string };

export const mainTextareaId = 'prompt-textarea';
export const globalAudioId = 'global-audio';

export enum IconContext {
  landing = 'landing',
  menuItem = 'menu-item',
  nav = 'nav',
  message = 'message',
}

export type NavLink = {
  title: TranslationKeys;
  label?: string;
  icon: LucideIcon | React.FC;
  Component?: React.ComponentType;
  onClick?: (e?: React.MouseEvent) => void;
  variant?: 'default' | 'ghost';
  disabled?: boolean;
  id: string;
};

export interface DataColumnMeta {
  meta:
    | {
        size: number | string;
      }
    | undefined;
}

export enum Panel {
  advanced = 'advanced',
  builder = 'builder',
  actions = 'actions',
  model = 'model',
  version = 'version',
}

export type FileSetter =
  | SetterOrUpdater<Map<string, ExtendedFile>>
  | React.Dispatch<React.SetStateAction<Map<string, ExtendedFile>>>;

export type ActionAuthForm = {
  /* General */
  type: t.AuthTypeEnum;
  saved_auth_fields: boolean;
  /* API key */
  api_key: string; // not nested
  authorization_type: t.AuthorizationTypeEnum;
  custom_auth_header: string;
  /* OAuth */
  oauth_client_id: string; // not nested
  oauth_client_secret: string; // not nested
  authorization_url: string;
  client_url: string;
  scope: string;
  token_exchange_method: t.TokenExchangeMethodEnum;
};

export type ActionWithNullableMetadata = Omit<t.Action, 'metadata'> & {
  metadata: t.ActionMetadata | null;
};

export type AssistantPanelProps = {
  index?: number;
  action?: ActionWithNullableMetadata;
  actions?: t.Action[];
  assistant_id?: string;
  activePanel?: string;
  endpoint: t.AssistantsEndpoint;
  version: number | string;
  documentsMap: Map<string, t.AssistantDocument> | null;
  setAction: React.Dispatch<React.SetStateAction<t.Action | undefined>>;
  setCurrentAssistantId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setActivePanel: React.Dispatch<React.SetStateAction<Panel>>;
};

export type AgentPanelProps = {
  index?: number;
  agent_id?: string;
  activePanel?: string;
  mcp?: t.MCP;
  mcps?: t.MCP[];
  action?: t.Action;
  actions?: t.Action[];
  createMutation: UseMutationResult<t.Agent, Error, t.AgentCreateParams>;
  setActivePanel: React.Dispatch<React.SetStateAction<Panel>>;
  setMcp: React.Dispatch<React.SetStateAction<t.MCP | undefined>>;
  setAction: React.Dispatch<React.SetStateAction<t.Action | undefined>>;
  endpointsConfig?: t.TEndpointsConfig;
  setCurrentAgentId: React.Dispatch<React.SetStateAction<string | undefined>>;
  agentsConfig?: t.TAgentsEndpoint | null;
};

export interface MCPServerInfo {
  serverName: string;
  tools: t.AgentToolType[];
  isConfigured: boolean;
  isConnected: boolean;
  /** True when the server can be attached to an agent, even if its transport is request-scoped. */
  isReadyForAgent?: boolean;
  /** True when tools can only be discovered with live chat request fields. */
  requestScoped?: boolean;
  consumeOnly?: boolean;
  metadata: t.TPlugin;
}

export type AgentPanelContextType = {
  action?: t.Action;
  actions?: t.Action[];
  setAction: React.Dispatch<React.SetStateAction<t.Action | undefined>>;
  mcp?: t.MCP;
  mcps?: t.MCP[];
  setMcp: React.Dispatch<React.SetStateAction<t.MCP | undefined>>;
  setMcps: React.Dispatch<React.SetStateAction<t.MCP[] | undefined>>;
  activePanel?: string;
  regularTools?: t.TPlugin[];
  setActivePanel: React.Dispatch<React.SetStateAction<Panel>>;
  setCurrentAgentId: React.Dispatch<React.SetStateAction<string | undefined>>;
  agent_id?: string;
  startupConfig?: t.TStartupConfig | null;
  agentsConfig?: t.TAgentsEndpoint | null;
  endpointsConfig?: t.TEndpointsConfig | null;
  /** Pre-computed MCP server information indexed by server key */
  mcpServersMap: Map<string, MCPServerInfo>;
  /** True while the MCP tools list is being fetched and no data has arrived yet,
   * so consumers can show a skeleton instead of an empty "no tools" state. */
  mcpToolsLoading: boolean;
  availableMCPServers: MCPServerDefinition[];
  availableMCPServersMap: t.MCPServersListResponse | undefined;
};

export type AgentModelPanelProps = {
  agent_id?: string;
  providers: Option[];
  models: Record<string, string[] | undefined>;
  modelsError: boolean;
  modelsReady: boolean;
  setActivePanel: React.Dispatch<React.SetStateAction<Panel>>;
};

export type AugmentedColumnDef<TData, TValue> = ColumnDef<TData, TValue> & DataColumnMeta;

export type TSetOption = t.TSetOption;

export type TSetExample = (
  i: number,
  type: string,
  newValue: number | string | boolean | null,
) => void;

export type OnInputNumberChange = InputNumberPrimitive.InputNumberProps['onChange'];

export const defaultDebouncedDelay = 450;

export enum ESide {
  Top = 'top',
  Right = 'right',
  Bottom = 'bottom',
  Left = 'left',
}

export enum NotificationSeverity {
  INFO = 'info',
  SUCCESS = 'success',
  WARNING = 'warning',
  ERROR = 'error',
}

export type TShowToast = {
  message: string;
  severity?: NotificationSeverity;
  showIcon?: boolean;
  duration?: number;
  status?: 'error' | 'success' | 'warning' | 'info';
};

export type TBaseSettingsProps = {
  conversation: t.TConversation | t.TPreset | null;
  className?: string;
  isPreset?: boolean;
  readonly?: boolean;
};

export type TSettingsProps = TBaseSettingsProps & {
  setOption: TSetOption;
};

export type TModels = {
  models: string[];
  showAbove?: boolean;
  popover?: boolean;
};

export type TModelSelectProps = TSettingsProps & TModels;

export type TEditPresetProps = {
  open: boolean;
  onOpenChange: React.Dispatch<React.SetStateAction<boolean>>;
  preset: t.TPreset;
  title?: string;
};

export type TSetOptions = (options: Record<string, unknown>) => void;
export type TSetOptionsPayload = {
  setOption: TSetOption;
  setExample: TSetExample;
  addExample: () => void;
  removeExample: () => void;
  setOptions?: TSetOptions;
};

export type TPresetItemProps = {
  preset: t.TPreset;
  value: t.TPreset;
  onSelect: (preset: t.TPreset) => void;
  onChangePreset: (preset: t.TPreset) => void;
  onDeletePreset: (preset: t.TPreset) => void;
};

export type TOnClick = (e: React.MouseEvent<HTMLButtonElement>) => void;

export type TGenButtonProps = {
  onClick: TOnClick;
};

export type TAskProps = {
  text: string;
  overrideConvoId?: string;
  overrideUserMessageId?: string;
  parentMessageId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  clientTimestamp?: string;
};

export type TOptions = {
  editedMessageId?: string | null;
  editedContent?: t.TEditedContent;
  isRegenerate?: boolean;
  isContinued?: boolean;
  isEdited?: boolean;
  /**
   * Manual context compaction: a summarize-only turn hung off the branch's
   * leaf (`messageId`). Shaped like a regenerate on the client — no new user
   * bubble, the response placeholder parents onto the leaf — and sent with
   * `compact: true` so the server runs the graph summarize-only.
   */
  compact?: boolean;
  overrideMessages?: t.TMessage[];
  /**
   * Authoritative attachment list for this submission: a rerun replays the edited
   * message's stored files, and an auto-drained queued message replays the ones taken
   * out of the composer when it was queued. Authoritative even when empty, so a drain
   * never vacuums up attachments the user staged for their next send.
   */
  overrideFiles?: t.TMessage['files'];
  /**
   * Assistant message being regenerated. Used to derive the optimistic response
   * id for non-tail regenerations without accidentally keying the stream to the
   * conversation tail.
   */
  targetResponseMessageId?: string | null;
  /**
   * Carry forward a user message's manually-invoked skills when the caller
   * is resubmitting / regenerating that same message — the compose-time
   * atom has already been drained on the original submit, so without this
   * the second turn would run without any manual priming even though the
   * pills are still visible on the user bubble.
   */
  overrideManualSkills?: string[];
  /**
   * Carry forward a user message's quoted excerpts when resubmitting /
   * regenerating that same message — the compose-time atom is drained on the
   * original submit, so without this the second turn would lose the quoted
   * context even though the references still show on the user bubble.
   */
  overrideQuotes?: string[];
  /** Request-scoped reasoning selection for this exact submission. */
  overrideReasoning?: t.TReasoningOverride | null;
  /** Added conversation for multi-convo feature - sent to server as part of submission payload */
  addedConvo?: t.TConversation;
  /** Reuse a durable submission identity (terminal steer recovery). */
  overrideClientRequestId?: string;
  /** Exact parked steer source for a recovery attempt. */
  overrideRecoverySteerId?: string;
  /** Exact terminal generation observed before an automatic queued start. */
  overrideExpectedPredecessorCreatedAt?: number;
  /** Client-only exact queue position restored if admission is rejected. */
  overrideQueuedMessageOrigin?: unknown;
};

export type TAskFunction = (props: TAskProps, options?: TOptions) => false | void;

/**
 * Stable context object passed from non-memo'd wrapper components (Message, MessageContent)
 * to memo'd inner components (MessageRender, ContentRender) via props.
 *
 * This avoids subscribing to ChatContext inside memo'd components, which would bypass React.memo
 * and cause unnecessary re-renders when `isSubmitting` changes during streaming.
 *
 * The `isSubmitting` property should use a getter backed by a ref so it returns the current
 * value at call-time (for callback guards) without being a reactive dependency.
 */
export type TMessageChatContext = {
  ask: TAskFunction;
  index: number;
  regenerate: (message: t.TMessage, options?: { addedConvo?: t.TConversation | null }) => void;
  conversation: t.TConversation | null;
  latestMessageId: string | undefined;
  latestMessageDepth: number | undefined;
  handleContinue: (e: React.MouseEvent<HTMLButtonElement>) => void;
  /** Resolved once per chat from `interface.feedback`; false until the config loads */
  feedbackEnabled: boolean;
  /** Should be a getter backed by a ref — reads current value without triggering re-renders */
  readonly isSubmitting: boolean;
};

export type TMessageProps = {
  conversation?: t.TConversation | null;
  messageId?: string | null;
  message?: t.TMessage;
  messagesTree?: t.TMessage[];
  currentEditId: string | number | null;
  isSearchView?: boolean;
  siblingIdx?: number;
  siblingCount?: number;
  setCurrentEditId?: React.Dispatch<React.SetStateAction<string | number | null>> | null;
  setSiblingIdx?: ((value: number) => void | React.Dispatch<React.SetStateAction<number>>) | null;
};

export type TMessageIcon = { endpoint?: string | null; isCreatedByUser?: boolean } & Pick<
  t.TConversation,
  'modelLabel'
> &
  Pick<t.TMessage, 'model' | 'iconURL'>;

export type TInitialProps = {
  text: string;
  edit: boolean;
  error: boolean;
  unfinished: boolean;
  isSubmitting: boolean;
  isLast: boolean;
};
export type TAdditionalProps = {
  ask: TAskFunction;
  message: t.TMessage;
  isCreatedByUser: boolean;
  siblingIdx: number;
  enterEdit: (cancel: boolean) => void;
  setSiblingIdx: (value: number) => void;
};

export type TMessageContentProps = TInitialProps & TAdditionalProps;

export type TText = Pick<TInitialProps, 'text'> & { className?: string };
export type TEditProps = Pick<TInitialProps, 'isSubmitting'> &
  Omit<TAdditionalProps, 'isCreatedByUser' | 'siblingIdx'> & {
    text?: string;
    index?: number;
    siblingIdx: number | null;
  };
export type TDisplayProps = TText &
  Pick<TAdditionalProps, 'isCreatedByUser' | 'message'> & {
    showCursor?: boolean;
  };

export type TConfigProps = {
  userKey: string;
  setUserKey: React.Dispatch<React.SetStateAction<string>>;
  endpoint: t.EModelEndpoint | string;
};

export type TDangerButtonProps = {
  id: string;
  confirmClear: boolean;
  className?: string;
  disabled?: boolean;
  showText?: boolean;
  mutation?: UseMutationResult<unknown>;
  onClick: () => void;
  infoTextCode: TranslationKeys;
  actionTextCode: TranslationKeys;
  dataTestIdInitial: string;
  dataTestIdConfirm: string;
  infoDescriptionCode?: TranslationKeys;
  confirmActionTextCode?: TranslationKeys;
};

export type TDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export type ToolDialogProps = {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
};

export type TResError = {
  response: { data: { message: string; code?: string } };
  message: string;
};

export type TAuthContext = {
  user: t.TUser | undefined;
  token: string | undefined;
  isAuthenticated: boolean;
  isAuthReady: boolean;
  error: string | undefined;
  login: (data: t.TLoginUser) => void;
  logout: (redirect?: string) => void;
  setError: React.Dispatch<React.SetStateAction<string | undefined>>;
  roles?: Record<string, t.TRole | null | undefined>;
};

export type TUserContext = {
  user?: t.TUser | undefined;
  token: string | undefined;
  isAuthenticated: boolean;
  redirect?: string;
};

export type TAuthConfig = {
  loginRedirect: string;
  test?: boolean;
  optional?: boolean;
};

export type IconProps = Pick<t.TMessage, 'isCreatedByUser' | 'model'> &
  Pick<t.TConversation, 'chatGptLabel' | 'modelLabel'> & {
    size?: number;
    button?: boolean;
    iconURL?: string;
    message?: boolean;
    className?: string;
    iconClassName?: string;
    endpoint?: t.EModelEndpoint | string | null;
    endpointType?: t.EModelEndpoint | null;
    endpointsConfig?: t.TEndpointsConfig | null;
    assistantName?: string;
    agentName?: string;
    error?: boolean;
  };

export type Option = Record<string, unknown> & {
  label?: string;
  value: string | number | null;
};

export type StringOption = Option & { value: string | null };

export type VoiceOption = {
  value: string;
  label: string;
};

export type TMessageAudio = {
  isLast?: boolean;
  index: number;
  messageId: string;
  content: string;
  className?: string;
  renderButton?: (props: {
    onClick: (e?: React.MouseEvent<HTMLButtonElement>) => void;
    title: string;
    icon: React.ReactNode;
    isActive?: boolean;
    isVisible?: boolean;
    isDisabled?: boolean;
    className?: string;
  }) => React.ReactNode;
};

export type OptionWithIcon = Option & { icon?: React.ReactNode };
export type DropdownValueSetter = (value: string | Option | OptionWithIcon) => void;
export type MentionOption = OptionWithIcon & {
  type: string;
  value: string;
  description?: string;
};
export type PromptOption = MentionOption & {
  id: string;
};

export type TOptionSettings = {
  showExamples?: boolean;
  isCodeChat?: boolean;
};

export interface ExtendedFile {
  file?: File;
  file_id: string;
  temp_file_id?: string;
  type?: string;
  filepath?: string;
  filename?: string;
  width?: number;
  height?: number;
  size: number;
  preview?: string;
  progress: number;
  source?: FileSources;
  attached?: boolean;
  embedded?: boolean;
  llmDeliveryPath?: t.TFile['llmDeliveryPath'];
  tool_resource?: string;
  metadata?: t.TFile['metadata'];
}

export interface ModelItemProps {
  modelName: string;
  endpoint: EModelEndpoint;
  isSelected: boolean;
  onSelect: () => void;
  onNavigateBack: () => void;
  icon?: JSX.Element;
  className?: string;
}

export interface SwitcherProps {
  endpoint?: t.EModelEndpoint | null;
  endpointKeyProvided: boolean;
  isCollapsed: boolean;
}
export type TLoginLayoutContext = {
  startupConfig: t.TStartupConfig | null;
  startupConfigError: unknown;
  isFetching: boolean;
  error: string | null;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  headerText: string;
  setHeaderText: React.Dispatch<React.SetStateAction<string>>;
};

export type NewConversationParams = {
  template?: Partial<t.TConversation>;
  preset?: Partial<t.TPreset>;
  modelsData?: t.TModelsConfig;
  buildDefault?: boolean;
  keepAddedConvos?: boolean;
  disableParams?: boolean;
};

export type ConvoGenerator = (params: NewConversationParams) => void | t.TConversation;

export type TBaseResData = {
  final?: boolean;
  initial?: boolean;
  previousMessages?: t.TMessage[];
  conversation: t.TConversation;
  conversationId?: string;
  runMessages?: t.TMessage[];
};

export type TResData = TBaseResData & {
  requestMessage: t.TMessage;
  responseMessage: t.TMessage;
};

export type TFinalResData = Omit<TBaseResData, 'conversation'> & {
  conversation: Partial<t.TConversation> & Pick<t.TConversation, 'conversationId'>;
  requestMessage?: t.TMessage;
  responseMessage?: t.TMessage;
};

export type TVectorStore = {
  _id: string;
  object: 'vector_store';
  created_at: string | Date;
  name: string;
  bytes?: number;
  file_counts?: {
    in_progress: number;
    completed: number;
    failed: number;
    cancelled: number;
    total: number;
  };
};

export type TThread = { id: string; createdAt: string };

declare global {
  interface Window {
    google_tag_manager?: unknown;
    /** Answers the server emits with the document, ahead of the app's own
     *  scripts, for questions the first render must not guess at. */
    __LIBRECHAT_CONFIG__?: {
      enableQueryDevtools?: boolean;
      /** Whether this deployment configured footer content of its own, so the
       *  composer reserves the footer bar's band on its first frame. */
      hasConfiguredFooter?: boolean;
    };
  }
}

import type { InfiniteData } from '@tanstack/react-query';
import type {
  TConversationTag,
  EModelEndpoint,
  TConversation,
  TSharedLink,
  TAttachment,
  TMessage,
  TBanner,
  ReasoningResponseKey,
  ReasoningParameterFormat,
} from './schemas';
import type {
  CodeWorkspaceDescriptor,
  CodeEnvironmentMode,
  CodeWorkspaceOperation,
  CodeWorkspaceSelection,
} from './code/workspace';
import type {
  CodeEnvironmentUserConfigSchema,
  CodeEnvironmentUserSettings,
  TAgentsEndpoint,
} from './config';
import type { StatefulCodeEnvironment } from './stateful-code';
import type { CodeApprovalMode } from './code/approval';
import type { EToolResources } from './types/tools';
import type { RefillIntervalUnit } from './balance';
import type { SettingDefinition } from './generate';
import type { TMinimalFeedback } from './feedback';
import type { ContentTypes } from './types/runs';
import type { ProviderId } from './providers';
import type { Agent } from './types/agents';

export * from './schemas';
export * from './types/subagents';
export * from './types/background';

export type TMessages = TMessage[];

/* TODO: Cleanup EndpointOption types */
export type TEndpointOption = Pick<
  TConversation,
  // Core conversation fields
  | 'endpoint'
  | 'endpointType'
  | 'model'
  | 'modelLabel'
  | 'chatGptLabel'
  | 'promptPrefix'
  | 'temperature'
  | 'topP'
  | 'topK'
  | 'top_p'
  | 'frequency_penalty'
  | 'presence_penalty'
  | 'maxOutputTokens'
  | 'maxContextTokens'
  | 'max_tokens'
  | 'maxTokens'
  | 'resendFiles'
  | 'imageDetail'
  | 'reasoning_effort'
  | 'verbosity'
  | 'instructions'
  | 'additional_instructions'
  | 'append_current_datetime'
  | 'tools'
  | 'stop'
  | 'region'
  | 'additionalModelRequestFields'
  // Anthropic-specific
  | 'promptCache'
  | 'promptCacheTtl'
  | 'thinking'
  | 'thinkingBudget'
  | 'thinkingLevel'
  | 'effort'
  | 'thinkingDisplay'
  // Assistant/Agent fields
  | 'assistant_id'
  | 'agent_id'
  // UI/Display fields
  | 'iconURL'
  | 'greeting'
  | 'spec'
  // Artifacts
  | 'artifacts'
  // Files
  | 'file_ids'
  // System field
  | 'system'
  | 'chatProjectId'
  // Google examples
  | 'examples'
  // Context
  | 'context'
> & {
  // Fields specific to endpoint options that don't exist on TConversation
  modelDisplayLabel?: string;
  key?: string | null;
  /** @deprecated Assistants API */
  thread_id?: string;
  // Conversation identifiers for multi-response streams
  overrideConvoId?: string;
  overrideUserMessageId?: string;
  // Model parameters (used by different endpoints)
  modelOptions?: Record<string, unknown>;
  model_parameters?: Record<string, unknown>;
  // Configuration data (added by middleware)
  modelsConfig?: TModelsConfig;
  // File attachments (processed by middleware)
  attachments?: TAttachment[];
  // Generated prompts
  artifactsPrompt?: string;
  // Agent-specific fields
  agent?: Promise<Agent>;
  // Client-specific options
  clientOptions?: Record<string, unknown>;
};

export type TEphemeralAgent = {
  mcp?: string[];
  web_search?: boolean;
  file_search?: boolean;
  execute_code?: boolean;
  artifacts?: string;
  skills?: boolean;
  memory?: boolean;
  /** Equip the ephemeral agent with the `ask_user_question` HITL tool. */
  ask_user_question?: boolean;
  /**
   * Let the model dispatch this ephemeral agent's eligible tool calls in the
   * background (poll results via `check_background_task`). Requires the
   * `run_in_background` agent capability to be enabled by the admin.
   */
  run_in_background?: boolean;
  /**
   * Inject the `intent` label param into this ephemeral agent's eligible
   * tools so each call streams a live status label. Requires the
   * `tool_intents` agent capability to be enabled by the admin.
   */
  describe_intent?: boolean;
};

export type TPayload = Partial<TMessage> &
  Partial<TEndpointOption> & {
    isContinued: boolean;
    isRegenerate?: boolean;
    /** Manual context compaction: summarize the branch up to `parentMessageId`
     *  and end without a reply. No user message is created. */
    compact?: boolean;
    conversationId: string | null;
    messages?: TMessages;
    isTemporary: boolean;
    ephemeralAgent?: TEphemeralAgent | null;
    editedContent?: TEditedContent | null;
    /** Added conversation for multi-convo feature */
    addedConvo?: TConversation;
    /**
     * Skills the user selected via the `$` popover for this turn. Names, not IDs
     * — the backend resolves them against the user's ACL-accessible skill set,
     * loads each SKILL.md body, and prepends one meta user message per skill
     * before the LLM turn runs.
     */
    manualSkills?: string[];
    /** Conversation-scoped preference for code tool approval behavior. */
    codeApprovalMode?: CodeApprovalMode;
    /** Immutable conversation choice for attached code execution. */
    codeEnvironmentMode?: CodeEnvironmentMode;
    /** Conversation-selected workspaces, with at most one binding per environment. */
    codeWorkspaces?: CodeWorkspaceSelection[];
    /** Browser IANA timezone (e.g. `America/New_York`) used to resolve local-time prompt variables server-side. */
    timezone?: string;
    /**
     * Stable per-submission idempotency key (uuid) generated once per `ask()`. Identical
     * across the client's start-generation network retries, unique per user action (including
     * regenerate). The server dedups retried start requests on it so a lost/reset response
     * cannot trigger a second billed generation.
     */
    clientRequestId?: string;
    /** Parked steer source consumed only after this new turn's user message is
     * durably saved. Separate from `clientRequestId`, which identifies one
     * generation attempt and must rotate after a failed recovery. */
    recoverySteerId?: string;
    /** Optional optimistic-serialization fence for a queued follow-up. The
     * server may create only if this observed predecessor is still current or
     * the conversation is still idle after its cleanup. */
    expectedPredecessorCreatedAt?: number;
  };

export type TEditedContent =
  | {
      index: number;
      type: ContentTypes.THINK;
      [ContentTypes.THINK]: string;
    }
  | {
      index: number;
      type: ContentTypes.TEXT;
      [ContentTypes.TEXT]: string;
    };

export type TSubmission = {
  userMessage: TMessage;
  isEdited?: boolean;
  isContinued?: boolean;
  isTemporary: boolean;
  messages: TMessage[];
  /** Client-only full message context used to restore branch siblings after scoped regenerate. */
  regenerateMessages?: TMessage[];
  isRegenerate?: boolean;
  /** Manual context compaction; shaped like a regenerate on the client (no new
   *  user bubble) and sent to the server as a summarize-only turn. */
  compact?: boolean;
  initialResponse?: TMessage;
  conversation: Partial<TConversation>;
  endpointOption: TEndpointOption;
  clientTimestamp?: string;
  ephemeralAgent?: TEphemeralAgent | null;
  editedContent?: TEditedContent | null;
  /**
   * Length of the retained content prefix for an edited resubmission, captured
   * when the submission is built.
   *
   * The server indexes only NEW content, so the client offsets incoming
   * indices by the prefix it kept. `initialResponse.content` cannot be used
   * for that after a reconnect: the resume sync overwrites it with the
   * server's completion-local snapshot, whose length is unrelated to the
   * prefix. Recording the length up front keeps the offset stable across
   * resumes for run steps and activity labels alike.
   */
  editPrefixLength?: number;
  /** True once server index 0 text/reasoning actually merged into the retained tail. */
  editPrefixFirstPartFolded?: boolean;
  /**
   * Set once a resume SYNC has replaced the response's retained prefix with
   * the server's completion-local snapshot. From that point the prefix is
   * gone from the rendered message and server indices are absolute in the
   * new space, so {@link editPrefixLength} must NOT be applied — by run
   * steps or by activity labels. Both event paths read this flag so a
   * batch's tool cards and its header always land in one index space.
   *
   * Stamped per event by the resumable transport, which owns the SYNC
   * boundary; the non-resumable path never sets it.
   */
  editPrefixCleared?: boolean;
  /** Added conversation for multi-convo feature */
  addedConvo?: TConversation;
  /** Skills the user invoked via the `$` popover for this submission. */
  manualSkills?: string[];
  /** Conversation-scoped preference for code tool approval behavior. */
  codeApprovalMode?: CodeApprovalMode;
  /** Immutable conversation choice for attached code execution. */
  codeEnvironmentMode?: CodeEnvironmentMode;
  /** Conversation-selected workspaces, with at most one binding per environment. */
  codeWorkspaces?: CodeWorkspaceSelection[];
  /** Stable per-submission idempotency key (uuid) forwarded to the server to dedup retried start-generation requests. */
  clientRequestId?: string;
  /** Client-only carry-through for a receipt-bound queued recovery. */
  recoverySteerId?: string;
  expectedPredecessorCreatedAt?: number;
  /** Opaque client-only queue restoration metadata; intentionally omitted by
   * `createPayload`. */
  queuedMessageOrigin?: unknown;
};

export type EventSubmission = Omit<TSubmission, 'initialResponse'> & { initialResponse: TMessage };

export type TPluginAction = {
  pluginKey: string;
  action: 'install' | 'uninstall';
  auth?: Partial<Record<string, string>> | null;
  isEntityTool?: boolean;
};

export type GroupedConversations = [key: string, TConversation[]][];

export type TUpdateUserPlugins = {
  isEntityTool?: boolean;
  pluginKey: string;
  action: string;
  auth?: Partial<Record<string, string | null>> | null;
};

// TODO `label` needs to be changed to the proper `TranslationKeys`
export type TCategory = {
  id?: string;
  value: string;
  label: string;
  description?: string;
  custom?: boolean;
};

export type TMarketplaceCategory = TCategory & {
  count: number;
};

export type TError = {
  message: string;
  code?: number | string;
  file_id?: string;
  tool_resource?: EToolResources;
  response?: {
    data?: {
      message?: string;
    };
    status?: number;
  };
};

export type TBackupCode = {
  codeHash: string;
  used: boolean;
  usedAt: Date | null;
};

export type TUser = {
  id: string;
  username: string;
  email: string;
  name: string;
  avatar: string;
  role: string;
  provider: string;
  tenantId?: string;
  plugins?: string[];
  twoFactorEnabled?: boolean;
  backupCodes?: TBackupCode[];
  personalization?: {
    memories?: boolean;
    statefulCodeEnvironment?: StatefulCodeEnvironment;
  };
  createdAt: string;
  updatedAt: string;
};

export type TUpdateUserPreferencesRequest = {
  statefulCodeEnvironment: StatefulCodeEnvironment;
};

export type TUpdateUserPreferencesResponse = {
  updated: boolean;
  preferences: TUpdateUserPreferencesRequest;
};

export type TGetConversationsResponse = {
  conversations: TConversation[];
  pageNumber: string;
  pageSize: string | number;
  pages: string | number;
};

export type TUpdateMessageRequest = {
  conversationId: string;
  messageId: string;
  model: string;
  text: string;
};

export type TUpdateMessageContent = {
  conversationId: string;
  messageId: string;
  index: number;
  text: string;
};

export type TUpdateUserKeyRequest = {
  name: string;
  value: string;
  expiresAt: string;
};

export type TAgentApiKeyCreateRequest = {
  name: string;
  expiresAt?: string | null;
};

export type TAgentApiKeyCreateResponse = {
  id: string;
  name: string;
  key: string;
  keyPrefix: string;
  createdAt: string;
  expiresAt?: string;
};

export type TAgentApiKeyListItem = {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt?: string;
  expiresAt?: string;
  createdAt: string;
};

export type TAgentApiKeyListResponse = {
  keys: TAgentApiKeyListItem[];
};

export type TUpdateConversationRequest = {
  conversationId: string;
  title: string;
};

export type TUpdateConversationResponse = TConversation;

export type TChatProject = {
  _id: string;
  name: string;
  description?: string;
  user?: string;
  conversationCount: number;
  lastConversationAt?: string | null;
  lastConversationId?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TCreateChatProjectRequest = {
  name: string;
  description?: string;
};

export type TUpdateChatProjectRequest = Partial<TCreateChatProjectRequest> & {
  projectId: string;
};

export type TDeleteChatProjectResponse = {
  deletedCount: number;
  modifiedCount: number;
};

export type TAssignConversationToProjectRequest = {
  conversationId: string;
  projectId: string | null;
};

export type TAssignConversationToProjectResponse = {
  conversation: TConversation;
  previousProjectId: string | null;
  projectId: string | null;
};

export type TDeleteConversationRequest = {
  conversationId?: string;
  thread_id?: string;
  endpoint?: string;
  source?: string;
};

export type TDeleteConversationResponse = {
  acknowledged: boolean;
  deletedCount: number;
  messages: {
    acknowledged: boolean;
    deletedCount: number;
  };
};

export type TArchiveConversationRequest = {
  conversationId: string;
  isArchived: boolean;
};

export type TArchiveConversationResponse = TConversation;

export type TArchiveAllConversationsResponse = {
  archivedCount: number;
};

export type TPinConversationRequest = {
  conversationId: string;
  pinned: boolean;
};

export type TPinConversationResponse = TConversation;

export type TSharedMessagesResponse = Omit<TSharedLink, 'messages'> & {
  messages: TMessage[];
  langfuseSessionUrl?: string;
  /** Whether the link was published with a configured sender label; withholds the
   * model on hover. */
  hasConfiguredSender?: boolean;
};

export type TCreateShareLinkRequest = Pick<TConversation, 'conversationId'>;

export type TUpdateShareLinkRequest = Pick<TSharedLink, 'shareId' | 'targetMessageId'>;

export type TSharedLinkResponse = Pick<TSharedLink, 'shareId'> &
  Pick<TSharedLink, 'targetMessageId'> &
  Pick<TConversation, 'conversationId'> & {
    _id?: string;
  };

export type TSharedLinkGetResponse = Omit<TSharedLinkResponse, 'shareId'> & {
  shareId: string | null;
  success: boolean;
  /** Per-link "share files" choice; absent on legacy links (treated as enabled). */
  snapshotFiles?: boolean;
};

// type for getting conversation tags
export type TConversationTagsResponse = TConversationTag[];
// type for creating conversation tag
export type TConversationTagRequest = Partial<
  Omit<TConversationTag, 'createdAt' | 'updatedAt' | 'count' | 'user'>
> & {
  conversationId?: string;
  addToConversation?: boolean;
};

export type TConversationTagResponse = TConversationTag;

export type TTagConversationRequest = {
  tags: string[];
  tag: string;
};

export type TTagConversationResponse = string[];

export type TDuplicateConvoRequest = {
  conversationId?: string;
};

export type TDuplicateConvoResponse = {
  conversation: TConversation;
  messages: TMessage[];
};

export type TForkConvoRequest = {
  messageId: string;
  conversationId: string;
  option?: string;
  splitAtTarget?: boolean;
  latestMessageId?: string;
};

export type TForkConvoResponse = {
  conversation: TConversation;
  messages: TMessage[];
};

export type TForkSharedConvoRequest = {
  shareId: string;
  /** Index of the viewer's active message within the shared payload; reduces the
   *  fork to that branch. An index is used because shared ids are re-anonymized
   *  per request and `createdAt` can collide, while the payload order is stable. */
  targetMessageIndex?: number;
  /** `updatedAt` of the shared payload being forked. The shareId survives an
   *  owner update, so the server rejects a fork whose payload has since moved
   *  instead of resolving the index against different messages. */
  shareRevision?: string;
};

export type TSearchResults = {
  conversations: TConversation[];
  messages: TMessage[];
  pageNumber: string;
  pageSize: string | number;
  pages: string | number;
  filter: object;
};

export type TPublicCodeEnvironment = {
  id: string;
  name: string;
  type: 'managed' | 'attached';
  default?: boolean;
  pairingAvailable?: boolean;
  configSchema?: CodeEnvironmentUserConfigSchema;
  settings?: CodeEnvironmentUserSettings;
};

export type TCodeEnvironmentSummary = {
  resourceId: string;
  id: string;
  name: string;
  type: 'managed' | 'attached';
  canEdit?: boolean;
  canDelete: boolean;
  configSchema?: CodeEnvironmentUserConfigSchema;
  settings?: CodeEnvironmentUserSettings;
};

export type TCodeControlPlane = {
  id: string;
  name: string;
  configSchema?: CodeEnvironmentUserConfigSchema;
};

export type TCodeEnvironmentsResponse = {
  environments: TCodeEnvironmentSummary[];
  controlPlanes: TCodeControlPlane[];
};

export type TCodeEnvironmentPairingResponse = {
  environment: TCodeEnvironmentSummary;
  pairing: {
    workerId: string;
    code: string;
    expiresAt: string;
    endpoint: string;
  };
};

export type TCodeEnvironmentStatusResponse = {
  environmentId: string;
  status: 'offline' | 'starting' | 'ready';
  statefulWorkspace?: boolean;
  leaseExpiresInMs?: number;
  sandboxProfile?: string;
  runtimes?: string[];
  operations?: CodeWorkspaceOperation[];
  workspaces?: CodeWorkspaceDescriptor[];
};

/**
 * Replaces a conversation's sealed code-environment decision: a move onto the environments its
 * agents now use, an attach for a chat running without one, or a detach off an attached machine.
 */
export type TCodeEnvironmentMoveRequest = {
  conversationId: string;
  /** The persisted selections being replaced, empty for a chat without an attached environment;
   *  a mismatch rejects the change as stale. */
  from: CodeWorkspaceSelection[];
  /** Empty to continue without an attached environment. */
  to: CodeWorkspaceSelection[];
};

export type TCodeEnvironmentMoveResponse = {
  conversationId: string;
  codeEnvironmentMode: CodeEnvironmentMode;
  /** Absent once the conversation continues without an attached environment. */
  codeWorkspaces?: CodeWorkspaceSelection[];
};

/** Sanitized results of server request shaping for each saved toggle state. */
export type ResponsesApiRoute = {
  default: boolean;
  on: boolean;
  off: boolean;
  withWebSearch?: { default: boolean; on: boolean; off: boolean };
};
export type ResponsesApiRouting = Record<string, ResponsesApiRoute>;

export type TConfig = {
  responsesApiRouting?: ResponsesApiRouting;
  order: number;
  type?: EModelEndpoint;
  azure?: boolean;
  availableTools?: [];
  availableRegions?: string[];
  allowedProviders?: (string | EModelEndpoint)[];
  plugins?: Record<string, string>;
  name?: string;
  iconURL?: string;
  /** Canonical provider identity resolved at config load, used for branding. */
  providerId?: ProviderId;
  version?: string;
  modelDisplayLabel?: string;
  userProvide?: boolean | null;
  userProvideURL?: boolean | null;
  userProvideAccessKeyId?: boolean;
  userProvideSecretAccessKey?: boolean;
  userProvideSessionToken?: boolean;
  userProvideBearerToken?: boolean;
  disableBuilder?: boolean;
  retrievalModels?: string[];
  capabilities?: string[];
  statefulCodeSessions?: {
    allowedEnvironments: StatefulCodeEnvironment[];
    environments?: TPublicCodeEnvironment[];
    approvalsEnabled?: boolean;
    /** Approval modes the endpoint policy permits the client to offer. */
    approvalModes?: CodeApprovalMode[];
  };
  /** Effective subagents-per-agent cap served from `endpoints.agents.maxSubagents`. */
  maxSubagents?: number;
  fileSharing?: TAgentsEndpoint['fileSharing'];
  /** Concurrent Code API uploads allowed per route and authenticated principal. */
  codeApiUploadConcurrency?: number;
  /** Milliseconds one operation may spend waiting on Code API rate limits. */
  codeApiMaxRetryWaitMs?: number;
  customParams?: {
    defaultParamsEndpoint?: string;
    reasoningFormat?: ReasoningParameterFormat;
    reasoningKey?: ReasoningResponseKey;
    includeReasoningContent?: boolean;
    includeReasoningHistory?: boolean;
    paramDefinitions?: Partial<SettingDefinition>[];
  };
};

export type TEndpointsConfig =
  | Record<EModelEndpoint | string, TConfig | null | undefined>
  | undefined;

export type TModelsConfig = Record<string, string[]>;

/** Server-resolved context window and pricing for one model. Rates are USD per 1M tokens. */
export type TModelTokenomics = {
  context?: number;
  prompt?: number;
  completion?: number;
  cacheWrite?: number;
  cacheRead?: number;
};

/** endpoint → model → resolved tokenomics, from GET /api/endpoints/token-config */
export type TTokenConfigMap = Record<string, Record<string, TModelTokenomics>>;

export type TUpdateTokenCountResponse = {
  count: number;
};

export type TMessageTreeNode = object;

export type TSearchMessage = object;

export type TSearchMessageTreeNode = object;

export type TRegisterUserResponse = {
  message: string;
};

export type TRegisterUser = {
  name: string;
  email: string;
  username: string;
  password: string;
  confirm_password?: string;
  token?: string;
};

export type TLoginUser = {
  email: string;
  password: string;
  token?: string;
  backupCode?: string;
};

export type TLoginResponse = {
  token?: string;
  user?: TUser;
  twoFAPending?: boolean;
  tempToken?: string;
};

/** Shared payload for any operation that requires OTP or backup-code verification. */
export type TOTPVerificationPayload = {
  token?: string;
  backupCode?: string;
};

export type TEnable2FARequest = TOTPVerificationPayload;

export type TEnable2FAResponse = {
  otpauthUrl: string;
  backupCodes: string[];
  message?: string;
};

export type TVerify2FARequest = TOTPVerificationPayload;

export type TVerify2FAResponse = {
  message: string;
};

/** For verifying 2FA during login with a temporary token. */
export type TVerify2FATempRequest = TOTPVerificationPayload & {
  tempToken: string;
};

export type TVerify2FATempResponse = {
  token?: string;
  user?: TUser;
  message?: string;
};

export type TDisable2FARequest = TOTPVerificationPayload;

export type TDisable2FAResponse = {
  message: string;
};

export type TRegenerateBackupCodesRequest = TOTPVerificationPayload;

export type TRegenerateBackupCodesResponse = {
  message?: string;
  backupCodes: string[];
  backupCodesHash: TBackupCode[];
};

export type TDeleteUserRequest = TOTPVerificationPayload;

export type TRequestPasswordReset = {
  email: string;
};

export type TResetPassword = {
  userId: string;
  token: string;
  password: string;
  confirm_password?: string;
};

export type VerifyEmailResponse = { message: string };

export type TVerifyEmail = {
  email: string;
  token: string;
};

export type TResendVerificationEmail = Omit<TVerifyEmail, 'token'>;

export type TRefreshTokenResponse = {
  token: string;
  user: TUser;
};

export type TCheckUserKeyResponse = {
  expiresAt: string;
};

export type TRequestPasswordResetResponse = {
  link?: string;
  message?: string;
};

/**
 * Represents the response from the import endpoint.
 */
export type TImportResponse = {
  /**
   * The message associated with the response.
   */
  message: string;
};

/** Prompts */

export type TPrompt = {
  groupId: string;
  author: string;
  prompt: string;
  type: 'text' | 'chat';
  createdAt: string;
  updatedAt: string;
  _id?: string;
};

export type TPromptGroup = {
  name: string;
  numberOfGenerations?: number;
  command?: string;
  oneliner?: string;
  category?: string;
  productionId?: string | null;
  productionPrompt?: Pick<TPrompt, 'prompt'> | null;
  author: string;
  authorName: string;
  isPublic?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
  _id?: string;
};

export type TCreatePrompt = {
  prompt: Pick<TPrompt, 'prompt' | 'type'> & { groupId?: string };
  group?: { name: string; category?: string; oneliner?: string; command?: string };
};

export type TCreatePromptRecord = TCreatePrompt & Pick<TPromptGroup, 'author' | 'authorName'>;

export type TPromptsWithFilterRequest = {
  groupId: string;
  tags?: string[];
  projectId?: string;
  version?: number;
};

export type TPromptGroupsWithFilterRequest = {
  category: string;
  pageNumber?: string; // Made optional for cursor-based pagination
  pageSize?: string | number;
  limit?: string | number; // For cursor-based pagination
  cursor?: string; // For cursor-based pagination
  before?: string | null;
  after?: string | null;
  order?: 'asc' | 'desc';
  name?: string;
  author?: string;
};

export type PromptGroupListResponse = {
  promptGroups: TPromptGroup[];
  pageNumber: string;
  pageSize: string | number;
  pages: string | number;
  has_more: boolean; // Added for cursor-based pagination
  after: string | null; // Added for cursor-based pagination
};

export type PromptGroupListData = InfiniteData<PromptGroupListResponse>;

export type TCreatePromptResponse = {
  prompt: TPrompt;
  group?: TPromptGroup;
};

export type TUpdatePromptGroupPayload = Partial<TPromptGroup>;

export type TUpdatePromptGroupVariables = {
  id: string;
  payload: TUpdatePromptGroupPayload;
};

export type TUpdatePromptGroupResponse = TPromptGroup;

export type TDeletePromptResponse = {
  prompt: string;
  promptGroup?: { message: string; id: string };
};

export type TDeletePromptVariables = {
  _id: string;
  groupId: string;
};

export type TMakePromptProductionResponse = {
  message: string;
};

export type TMakePromptProductionRequest = {
  id: string;
  groupId: string;
  productionPrompt: Pick<TPrompt, 'prompt'>;
};

export type TUpdatePromptLabelsRequest = {
  id: string;
  payload: {
    labels: string[];
  };
};

export type TUpdatePromptLabelsResponse = {
  message: string;
};

export type TDeletePromptGroupResponse = TUpdatePromptLabelsResponse;

export type TDeletePromptGroupRequest = {
  id: string;
};

export type TGetCategoriesResponse = TCategory[];

export type TGetRandomPromptsResponse = {
  prompts: TPromptGroup[];
};

export type TGetRandomPromptsRequest = {
  limit: number;
  skip: number;
};

export type TCustomConfigSpeechResponse = { [key: string]: string };

export type TUserTermsResponse = {
  termsAccepted: boolean;
  termsAcceptedAt: Date | string | null;
};

export type TAcceptTermsResponse = {
  message: string;
  termsAcceptedAt: Date | string;
};

export type TBannerResponse = TBanner | null;

export type TUpdateFeedbackRequest = {
  feedback?: TMinimalFeedback;
};

export type TUpdateFeedbackResponse = {
  messageId: string;
  conversationId: string;
  feedback?: TMinimalFeedback;
};

export type TBalanceResponse = {
  tokenCredits: number;
  // Automatic refill settings
  autoRefillEnabled: boolean;
  refillIntervalValue?: number;
  refillIntervalUnit?: RefillIntervalUnit;
  lastRefill?: Date | string;
  refillAmount?: number;
};

/* -------------------------------------------------------------------------- */
/* Skill UI extensions (not yet persisted — phase 2 backend will fill these)  */
/* -------------------------------------------------------------------------- */

/**
 * @deprecated Superseded by the persisted `userInvocable` /
 * `disableModelInvocation` pair derived from frontmatter. Retained for the
 * transition window so older UI forms and tests still type-check; the
 * backend no longer reads or writes it.
 */
export enum InvocationMode {
  auto = 'auto',
  manual = 'manual',
  both = 'both',
}

/**
 * Node in the filesystem-style skill tree view. Phase 1 derives these from
 * the flat `TSkillFile[]` list; phase 2 will have the backend serve them
 * directly from a persisted folder hierarchy. Kept in the shared types so
 * tree UI helpers can be imported from both client and server.
 */
export type TSkillNode = {
  _id: string;
  skillId: string;
  parentId: string | null;
  type: 'file' | 'folder';
  name: string;
  fileId?: string;
  order: number;
  author: string;
  createdAt: string;
  updatedAt: string;
};

export type TSkillTreeResponse = {
  nodes: TSkillNode[];
};

export type TCreateSkillNodeRequest = {
  type: 'file' | 'folder';
  name: string;
  parentId?: string | null;
  order?: number;
};

export type TUpdateSkillNodeRequest = {
  name?: string;
  parentId?: string | null;
  order?: number;
};

export type TLangfuseConnectionStatus = {
  configured: boolean;
  enabled: boolean;
  destinations: TLangfuseDestinationOption[];
  destination?: string;
  publicKey?: string;
  secretKeyPreview?: string;
  updatedAt?: string;
};

export type TLangfuseDestinationOption = {
  key: string;
  baseUrl: string;
};

export type TUpdateLangfuseConnectionRequest = {
  enabled: boolean;
  destination: string;
  publicKey: string;
  secretKey?: string;
};

export type TLangfuseConnectionTestRequest = {
  destination: string;
  publicKey: string;
  secretKey?: string;
};

export type TLangfuseConnectionTestErrorCode =
  | 'invalid_credentials'
  | 'access_denied'
  | 'rate_limited'
  | 'server_error'
  | 'timeout'
  | 'unreachable'
  | 'missing_secret'
  | 'stored_secret_unavailable'
  | 'unexpected_response';

export type TLangfuseConnectionTestResponse =
  | { success: true }
  | { success: false; errorCode: TLangfuseConnectionTestErrorCode };

export type TLangfuseSessionLinkResponse = {
  url: string | null;
  /** Opaque identity of the project `url` opens, so a caller can tell whether it holds what it showed. */
  destinationId?: string;
};

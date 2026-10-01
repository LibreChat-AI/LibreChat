import { z } from 'zod';
import {
  Tools,
  SSEOptionsSchema,
  MCPOptionsSchema,
  MCPServersSchema,
  StdioOptionsSchema,
  WebSocketOptionsSchema,
  StreamableHTTPOptionsSchema,
} from 'librechat-data-provider';
import type {
  EmbeddedResource,
  ListToolsResult,
  ResourceLink,
  ImageContent,
  AudioContent,
  TextContent,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  SearchResultData,
  UIResource,
  TPlugin,
  TMCPAppOperationLimits,
} from 'librechat-data-provider';
import type { TokenMethods, IUser } from '@librechat/data-schemas';
import type { LCTool } from '@librechat/agents';
import type {
  OboTokenResolver,
  OboTrustChecker,
  UpstreamTokenProvider,
  UpstreamTokenProviderResolver,
} from '~/mcp/oauth/obo';
import type { AuthIdentityContext } from '~/utils/identity';
import type { GraphTokenResolver } from '~/utils/graph';
import type { FlowStateManager } from '~/flow/manager';
import type { RequestBody } from '~/types/http';
import type * as o from '~/mcp/oauth/types';

export type MCPRuntimeRequestBody = Required<Pick<RequestBody, 'messageId' | 'conversationId'>> &
  Pick<RequestBody, 'parentMessageId' | 'codeEnvironmentMode' | 'codeWorkspaces'>;

export type StdioOptions = z.infer<typeof StdioOptionsSchema>;
export type WebSocketOptions = z.infer<typeof WebSocketOptionsSchema>;
export type SSEOptions = z.infer<typeof SSEOptionsSchema>;
export type StreamableHTTPOptions = z.infer<typeof StreamableHTTPOptionsSchema>;
export type MCPOptions = z.infer<typeof MCPOptionsSchema> & {
  customUserVars?: Record<
    string,
    {
      title: string;
      description: string;
    }
  >;
};
export type MCPServers = z.infer<typeof MCPServersSchema>;
export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface LCFunctionTool {
  type: 'function';
  ['function']: LCTool;
  /** Raw upstream tool name when the model-facing key stripped a redundant
   *  server-name prefix — tool calls must send THIS name to the server. */
  serverToolName?: string;
}

export type LCAvailableTools = Record<string, LCFunctionTool>;
export type LCManifestTool = TPlugin;
export type LCToolManifest = TPlugin[];
export interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: Array<{ name: string }>;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export type OAuthHandledSource = 'silent-refresh' | 'interactive';

export type MCPTool = Tool;
export type MCPToolListResponse = ListToolsResult;
export type ToolContentPart =
  | TextContent
  | ImageContent
  | EmbeddedResource
  | ResourceLink
  | AudioContent;
export type ResourceContents = EmbeddedResource['resource'];
export type ResourceBody = {
  text?: string;
  image?: ImageContent;
  binaryBytes?: number;
};
export type { TextContent, ImageContent, EmbeddedResource, ResourceLink, AudioContent };
export type MCPToolCallResponse =
  | undefined
  | {
      _meta?: Record<string, unknown>;
      content?: Array<ToolContentPart>;
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };

export type Provider =
  | 'google'
  | 'anthropic'
  | 'openai'
  | 'azureopenai'
  | 'openrouter'
  | 'xai'
  | 'deepseek'
  | 'ollama'
  | 'bedrock';

export type FormattedContent =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'image';
      inlineData: {
        mimeType: string;
        data: string;
      };
    }
  | {
      type: 'image';
      source: {
        type: 'base64';
        media_type: string;
        data: string;
      };
    }
  | {
      type: 'image_url';
      image_url: {
        url: string;
      };
    };

export type FileSearchSource = {
  fileId: string;
  relevance: number;
  fileName?: string;
  metadata?: {
    storageType?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type Artifacts =
  | {
      content?: FormattedContent[];
      [Tools.ui_resources]?: {
        data: UIResource[];
      };
      [Tools.file_search]?: {
        sources: FileSearchSource[];
        fileCitations?: boolean;
      };
      [Tools.web_search]?: SearchResultData;
      files?: Array<{ id: string; name: string }>;
      session_id?: string;
      file_ids?: string[];
    }
  | undefined;

export type FormattedContentResult = [string, Artifacts | undefined];

export type ImageFormatter = (item: ImageContent) => FormattedContent;

export type FormattedToolResponse = FormattedContentResult;

/**
 * Origin of an MCP server definition.
 * - `'yaml'`   — operator-defined in librechat.yaml, full trust, boot-time init
 * - `'config'` — admin-defined via Config override, full trust, lazy init
 * - `'user'`   — user-provided via UI, sandboxed (restricted placeholder resolution)
 * - `'plugin'` — contributed by an Agent Plugins package, no placeholder resolution
 *
 * This tag is load-bearing, not descriptive: `processMCPEnv` reads it to decide
 * which placeholders may resolve. Code that stores a config must carry the tag
 * through rather than re-deriving it from the storage tier.
 */
export type MCPServerSource = 'yaml' | 'config' | 'user' | 'plugin';

export type ParsedServerConfig = MCPOptions & {
  url?: string;
  requiresOAuth?: boolean;
  oauthMetadata?: Record<string, unknown> | null;
  capabilities?: string;
  tools?: string;
  toolFunctions?: LCAvailableTools;
  /**
   * Instructions advertised by the server, fetched during inspection when
   * `serverInstructions` is enabled. Held separately so `serverInstructions`
   * always keeps the operator's declaration: overwriting it in place made a
   * re-inspected config compare unequal to its own YAML entry.
   */
  resolvedInstructions?: string;
  initDuration?: number;
  updatedAt?: number;
  dbId?: string;
  /** Origin of this server definition — determines trust level and placeholder resolution */
  source?: MCPServerSource;
  /** True if access is only via agent (not directly shared with user) */
  consumeOnly?: boolean;
  /** True when inspection failed at startup; the server is known but not fully initialized */
  inspectionFailed?: boolean;
  /**
   * User-id of the creating user (DB-sourced configs only). Used at runtime to gate
   * OBO token exchanges by re-checking the author's CONFIGURE_OBO permission, so a
   * stored config remains safe if the author's role is downgraded.
   */
  author?: string;
};

export type AddServerResult = {
  serverName: string;
  config: ParsedServerConfig;
};

/** Mutable per-creation budget shared by every direct-bearer recovery layer. */
export interface DirectBearerRecoveryState {
  attempted: boolean;
  /** Request-local credential snapshot shared with checkout joiners and the first tool call. */
  resolvedConfig?: MCPOptions;
}

export interface BasicConnectionOptions {
  serverName: string;
  serverConfig: MCPOptions;
  /** Original unresolved definition retained across asynchronous credential preprocessing. */
  serverDefinition?: MCPOptions;
  /** Original trusted definition retained when serverConfig already contains request-resolved credentials. */
  directBearerSourceConfig?: ParsedServerConfig;
  /** Internal one-shot fence shared with the connection owner. */
  directBearerRecoveryState?: DirectBearerRecoveryState;
  useSSRFProtection?: boolean;
  allowedDomains?: string[] | null;
  /** Admin exemption list of host:port pairs that bypass the SSRF private-IP block */
  allowedAddresses?: string[] | null;
  /** When true, only resolve customUserVars in processMCPEnv (for DB-stored servers) */
  dbSourced?: boolean;
  /** When true, serverConfig has already gone through processMCPEnv for this request */
  skipEnvProcessing?: boolean;
  /** When true, the connection is intentionally short-lived for a single request/tool call */
  ephemeralConnection?: boolean;
  /** Immutable client capabilities negotiated for this connection. */
  capabilityProfile?: import('../capabilities').MCPClientCapabilityProfile;
  /** Validated deployment limits captured for App-profile transport parsing. */
  operationLimits?: TMCPAppOperationLimits;
}

/** User context for placeholder resolution in MCP connections (non-OAuth and OAuth alike) */
export interface UserConnectionContext {
  user?: IUser;
  customUserVars?: Record<string, string>;
  requestBody?: RequestBody;
  requestScopedConnections?: RequestScopedMCPConnectionStore;
  graphTokenResolver?: GraphTokenResolver;
  /** Live OpenID session credential source for trusted direct bearer and OBO configurations. */
  upstreamTokenProvider?: UpstreamTokenProvider;
  /** Deferred credential source used only after a server is confirmed to require OBO. */
  upstreamTokenProviderResolver?: UpstreamTokenProviderResolver;
  connectionTimeout?: number;
  /** Cancels the connection's SDK requests when the caller itself is cancelled; previously only
   *  OAuth connections could carry a signal, leaving non-OAuth discovery uncancellable. */
  signal?: AbortSignal;
  /** Immutable client capabilities requested by this caller. */
  capabilityProfile?: import('../capabilities').MCPClientCapabilityProfile;
  /** Absolute epoch-ms bound on the whole connect-and-list operation. `connectionTimeout` bounds
   *  only a single `connect()`, so a caller that must return within a fixed budget sets this to
   *  cap every segment, including `tools/list` pagination and the unauthenticated fallback. */
  deadlineMs?: number;
  /** Advances application authorization state after OAuth token persistence succeeds. */
  onOAuthCredentialsChanged?: (scope: { userId: string; serverName: string }) => Promise<void>;
  /**
   * Persists authorization-fence intent before OAuth token rows change and returns its publisher.
   * The publisher reports the generation it wrote, so a caller that fenced its own credential
   * change can adopt that generation instead of the one it captured beforehand.
   */
  onOAuthCredentialsChanging?: (scope: {
    userId: string;
    serverName: string;
  }) => Promise<() => Promise<string | undefined>>;
  /**
   * Receives discovery work the caller stopped waiting for at its deadline or abort, such as an
   * OAuth token flow still persisting a refresh. The work keeps running; the promise settles with it.
   */
  onDiscoveryDetached?: (work: Promise<unknown>) => void;
  /**
   * Reports the publication generation carried by credentials the factory adopted from an
   * authorization or refresh it did not perform. A caller leasing a generation captured before it
   * resolved credentials moves the lease to the reported one while that is the generation
   * currently stored: the build then leases under the publication that stored its credentials
   * and stays fenced by any rotation that followed them.
   */
  onOAuthCredentialsAdopted?: (publicationGeneration: string) => Promise<void>;
  /**
   * Runs before the factory re-reads credentials from storage because a credential change
   * invalidated its cached token flow. A caller leasing a generation captured earlier re-captures
   * it here, ahead of the read, so a rotation that follows the read still fences the build.
   */
  onOAuthCredentialsInvalidated?: () => Promise<string | void>;
}

export interface RequestScopedMCPConnectionStore {
  connections: Map<string, unknown>;
  pending: Map<string, Promise<unknown>>;
  disposeConnection?: (connectionKey: string, connection: unknown) => Promise<void>;
  /** Set before cleanup snapshots pending work; new connection attempts must fail closed. */
  cleanupStarted?: boolean;
}

export interface OAuthStartOptions {
  expiresAt?: number;
}

export type OAuthStartHandler = (authURL: string, options?: OAuthStartOptions) => Promise<void>;

export interface OAuthConnectionOptions extends UserConnectionContext {
  useOAuth: true;
  flowManager: FlowStateManager<o.MCPOAuthTokens | null>;
  tokenMethods?: TokenMethods;
  signal?: AbortSignal;
  oauthStart?: OAuthStartHandler;
  oauthEnd?: () => Promise<void>;
  returnOnOAuth?: boolean;
  oboTokenResolver?: OboTokenResolver;
  oboTrustChecker?: OboTrustChecker;
  oboIdentityContext?: AuthIdentityContext;
}

export interface MCPConnectionTarget {
  serverConfig: ParsedServerConfig;
  connectionOwner: 'operator' | 'principal';
}

type MCPConnectionTargetInput =
  | { connectionTarget: MCPConnectionTarget; serverConfig?: never }
  | { connectionTarget?: never; serverConfig?: ParsedServerConfig };

/** Options accepted by UserConnectionManager.getUserConnection. OAuth fields are optional. */
export type UserMCPConnectionOptions = UserConnectionContext &
  MCPConnectionTargetInput & {
    serverName: string;
    forceNew?: boolean;
    ephemeralConnection?: boolean;
    /** Internal one-shot fence shared across connection initialization and initial tools/list. */
    directBearerRecoveryState?: DirectBearerRecoveryState;
    flowManager?: FlowStateManager<o.MCPOAuthTokens | null>;
    /** Request-local resolved credentials; serverConfig remains the authoritative definition. */
    directBearerResolvedConfig?: MCPOptions;
    tokenMethods?: TokenMethods;
    signal?: AbortSignal;
    oauthStart?: OAuthStartHandler;
    oauthEnd?: () => Promise<void>;
    returnOnOAuth?: boolean;
    oboTokenResolver?: OboTokenResolver;
    oboTrustChecker?: OboTrustChecker;
    oboIdentityContext?: AuthIdentityContext;
  };

export interface ToolDiscoveryOptions {
  serverName: string;
  user?: IUser;
  flowManager?: FlowStateManager<o.MCPOAuthTokens | null>;
  tokenMethods?: TokenMethods;
  signal?: AbortSignal;
  oauthStart?: OAuthStartHandler;
  customUserVars?: Record<string, string>;
  requestBody?: RequestBody;
  graphTokenResolver?: GraphTokenResolver;
  connectionTimeout?: number;
  /** Absolute epoch-ms bound on the whole discovery operation; see `UserConnectionContext`. */
  deadlineMs?: number;
  onOAuthCredentialsChanged?: (scope: { userId: string; serverName: string }) => Promise<void>;
  onOAuthCredentialsChanging?: UserConnectionContext['onOAuthCredentialsChanging'];
  /** Updates the discovery flight when it adopts credentials published by a peer. */
  onOAuthCredentialsAdopted?: (generation: string) => Promise<void>;
  onDiscoveryDetached?: UserConnectionContext['onDiscoveryDetached'];
  /** Pre-resolved config-source servers for tenant-scoped lookup */
  configServers?: Record<string, ParsedServerConfig>;
  oboTokenResolver?: OboTokenResolver;
  oboTrustChecker?: OboTrustChecker;
  upstreamTokenProvider?: UpstreamTokenProvider;
  upstreamTokenProviderResolver?: UpstreamTokenProviderResolver;
  oboIdentityContext?: AuthIdentityContext;
  /** Immutable client capabilities used for this discovery session. */
  capabilityProfile?: import('../capabilities').MCPClientCapabilityProfile;
}

export interface ToolDiscoveryResult {
  tools: Tool[] | null;
  oauthRequired: boolean;
  oauthUrl: string | null;
  authenticationKind?: 'oauth' | 'obo' | 'server';
}

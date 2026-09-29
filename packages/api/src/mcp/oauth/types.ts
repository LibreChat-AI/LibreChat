import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FlowMetadata } from '~/flow/types';

export interface OAuthMetadata {
  /** OAuth authorization endpoint */
  authorization_endpoint: string;
  /** OAuth token endpoint */
  token_endpoint: string;
  /** OAuth issuer */
  issuer?: string;
  /** Supported scopes */
  scopes_supported?: string[];
  /** Response types supported */
  response_types_supported?: string[];
  /** Grant types supported */
  grant_types_supported?: string[];
  /** Token endpoint auth methods supported */
  token_endpoint_auth_methods_supported?: string[];
  /** Code challenge methods supported */
  code_challenge_methods_supported?: string[];
  /** Dynamic client registration endpoint (RFC 7591) */
  registration_endpoint?: string;
  /** Revocation endpoint */
  revocation_endpoint?: string;
  /** Revocation endpoint auth methods supported */
  revocation_endpoint_auth_methods_supported?: string[];
}

/** How the OAuth client credentials associated with stored tokens were obtained. */
export type OAuthClientSource = 'configured' | 'dynamic';

export interface OAuthStoredClientMetadata extends OAuthMetadata {
  /** Random identifier shared by the access, refresh, and client records from one authorization. */
  credential_set_id?: string;
  /** Canonical MCP server URL the tokens and client registration are bound to. */
  server_url: string;
  /** Whether the client came from server configuration or dynamic client registration. */
  client_source: OAuthClientSource;
  /** Canonical OAuth resource indicator used when the authorization code was exchanged. */
  resource?: string;
}

export interface OAuthProtectedResourceMetadata {
  /** Resource identifier */
  resource: string;
  /** Authorization servers */
  authorization_servers?: string[];
  /** Scopes supported by the resource */
  scopes_supported?: string[];
}

export interface OAuthClientInformation {
  /** Client ID */
  client_id: string;
  /** Client secret (optional for public clients) */
  client_secret?: string;
  /** Client name */
  client_name?: string;
  /** Redirect URIs */
  redirect_uris?: string[];
  /** Grant types */
  grant_types?: string[];
  /** Response types */
  response_types?: string[];
  /** Scope */
  scope?: string;
  /** Token endpoint auth method */
  token_endpoint_auth_method?: string;
}

export interface MCPOAuthState {
  /** Current step in the OAuth flow */
  step: 'discovery' | 'registration' | 'authorization' | 'token_exchange' | 'complete' | 'error';
  /** Server name */
  serverName: string;
  /** User ID */
  userId: string;
  /** OAuth metadata from discovery */
  metadata?: OAuthMetadata;
  /** Resource metadata */
  resourceMetadata?: OAuthProtectedResourceMetadata;
  /** Client information */
  clientInfo?: OAuthClientInformation;
  /** Authorization URL */
  authorizationUrl?: string;
  /** Code verifier for PKCE */
  codeVerifier?: string;
  /** State parameter for OAuth flow */
  state?: string;
  /** Error information */
  error?: string;
  /** Timestamp */
  timestamp: number;
}

export interface MCPOAuthFlowMetadata extends FlowMetadata {
  serverName: string;
  userId: string;
  serverUrl: string;
  /** Identity of the effective server definition that admitted this authorization attempt. */
  serverGeneration?: string;
  /** Persistence wait admitted with the server configuration; preserved across the OAuth redirect. */
  oauthPersistenceWaitTimeout?: number;
  state: string;
  codeVerifier?: string;
  clientInfo?: OAuthClientInformation;
  /** Whether this flow uses a configured client or a dynamically registered client. */
  clientSource?: OAuthClientSource;
  metadata?: OAuthMetadata;
  resourceMetadata?: OAuthProtectedResourceMetadata;
  authorizationUrl?: string;
  /** Custom headers for OAuth token exchange, persisted at flow initiation for the callback. */
  oauthHeaders?: Record<string, string>;
  /** Domain allowlist captured at flow initiation for callback-time SSRF enforcement. */
  allowedDomains?: string[] | null;
  /** Address exemptions captured at flow initiation for callback-time SSRF enforcement. */
  allowedAddresses?: string[] | null;
  /** True when the flow reused a stored client registration from a prior successful OAuth flow */
  reusedStoredClient?: boolean;
  /** Credential generation of the reused client, used to scope stale-registration cleanup. */
  reusedClientCredentialSetId?: string;
  /** Tenant context captured at flow initiation for callback replay (SameSite cookies unavailable on cross-origin redirects) */
  tenantId?: string;
  /**
   * False when `oauth.send_resource_parameter` opted this server out of RFC 8707
   * `resource`. Captured at flow initiation so the token exchange sends the same
   * parameters as the authorization request that produced the code.
   */
  sendResourceParameter?: boolean;
}

export interface MCPOAuthTokens extends OAuthTokens {
  /** Internal identifier for the persisted credential set; never sent to the OAuth provider. */
  credential_set_id?: string;
  /** When the tokens were obtained */
  obtained_at: number;
  /** Calculated expiry time */
  expires_at?: number;
  /**
   * Tool-cache publication generation written when these tokens were persisted. Carried only by
   * tokens handed to the waiters of the authorization or refresh that stored them, never by a
   * stored row, so a connection built on them can lease under that generation.
   */
  publication_generation?: string;
}

/** Extended OAuth tokens that may include refresh token expiry */
export interface ExtendedOAuthTokens extends OAuthTokens {
  /** Refresh token expiry in seconds (non-standard, some providers include this) */
  refresh_token_expires_in?: number;
}

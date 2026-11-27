import type { MCPOptions, TCustomConfig } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';

export const MCP_AUTHORITY_PROOF_VERSION = 1 as const;

export type MCPAuthorityServerSource = 'config' | 'database';

export interface MCPAuthorityBootRevision {
  readonly revision: string;
  readonly digest: string;
}

interface MCPAuthorityTargetBase {
  readonly serverName: string;
  readonly sourceRevision: string;
  readonly expectedCredentialRevision: string;
  readonly expectedOAuthGrantGeneration: string | null;
  readonly resolvedConfig: MCPOptions;
  readonly credentialFields?: readonly string[];
  readonly requiresOAuth?: boolean;
}

export type MCPAuthorityTargetInput = MCPAuthorityTargetBase &
  (
    | { readonly source: 'config'; readonly databaseId?: never }
    | { readonly source: 'database'; readonly databaseId: string }
  );

export interface MCPAuthorityResolveInput {
  readonly userId: string;
  readonly tenantId?: string;
  readonly boot: MCPAuthorityBootRevision;
  readonly targets: readonly MCPAuthorityTargetInput[];
  readonly session?: ClientSession;
}

export interface MCPAuthorityUserProof {
  readonly userId: string;
  readonly tenantId: string | null;
  readonly role: string;
  readonly provider: string;
  readonly sourceIdentityDigest: string;
  readonly revision: string;
}

export interface MCPAuthorityGroupProof {
  readonly id: string;
  readonly source: string;
  readonly sourceIdentityDigest: string;
  readonly revision: string;
}

export interface MCPAuthorityConfigProof {
  readonly principalType: string;
  readonly principalId: string;
  readonly present: boolean;
  readonly active: boolean;
  readonly priority: number | null;
  readonly configVersion: number | null;
  readonly mcpOverrideDigest: string | null;
  readonly tombstones: readonly string[];
  readonly revision: string;
}

export interface MCPAuthorityRoleProof {
  readonly id: string;
  readonly name: string;
  readonly use: boolean;
  readonly revision: string;
}

export interface MCPAuthoritySharedProofV1 {
  readonly user: MCPAuthorityUserProof;
  readonly groups: readonly MCPAuthorityGroupProof[];
  readonly configs: readonly MCPAuthorityConfigProof[];
  readonly role: MCPAuthorityRoleProof;
  readonly boot: MCPAuthorityBootRevision;
  readonly groupsRevision: string;
  readonly configsRevision: string;
  readonly revision: string;
}

export interface MCPAuthorityServerProofV1 {
  readonly serverName: string;
  readonly normalizedServerName: string;
  readonly source: MCPAuthorityServerSource;
  readonly databaseId: string | null;
  readonly sourceRevision: string;
  readonly resolvedConfigDigest: string;
  readonly serverRevision: string;
  readonly linkedAgentIds: readonly string[];
  readonly directAccess: boolean;
  readonly agentAccess: boolean;
  readonly authorizationRevision: string;
  readonly credentialFields: readonly string[];
  readonly credentialRevision: string;
  readonly requiresOAuth: boolean;
  readonly oauthGrantGeneration: string | null;
  readonly oauthRevision: string;
  readonly effectivePolicyDigest: string;
  readonly revision: string;
}

export interface MCPAuthorityProofV1 {
  readonly version: typeof MCP_AUTHORITY_PROOF_VERSION;
  readonly shared: MCPAuthoritySharedProofV1;
  readonly servers: readonly MCPAuthorityServerProofV1[];
  readonly revision: string;
}

export interface MCPAuthorityAssertInput {
  readonly proofs: MCPAuthorityProofV1 | readonly MCPAuthorityProofV1[];
  readonly boot: MCPAuthorityBootRevision;
  readonly session?: ClientSession;
}

export interface MCPAuthorityDatabaseMethods {
  resolveMCPAuthorityProof(input: MCPAuthorityResolveInput): Promise<MCPAuthorityProofV1>;
  assertMCPAuthorityProofsCurrent(input: MCPAuthorityAssertInput): Promise<void>;
}

export type MCPAuthorityImmutableConfig = Readonly<
  Pick<TCustomConfig, 'mcpServers' | 'mcpSettings'>
>;

export type MCPAuthorityRejectionReason =
  | 'malformed_input'
  | 'proof_unavailable'
  | 'user_revoked'
  | 'principal_changed'
  | 'groups_changed'
  | 'config_changed'
  | 'mcp_use_revoked'
  | 'role_changed'
  | 'boot_revision_changed'
  | 'server_revoked'
  | 'server_changed'
  | 'access_revoked'
  | 'authorization_changed'
  | 'credential_changed'
  | 'oauth_grant_changed';

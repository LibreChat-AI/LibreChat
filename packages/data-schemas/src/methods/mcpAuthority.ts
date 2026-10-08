import { Types } from 'mongoose';
import { createHash } from 'crypto';
import {
  Constants,
  Permissions,
  PermissionBits,
  ResourceType,
  PrincipalType,
  PermissionTypes,
  normalizeServerName,
} from 'librechat-data-provider';
import type { Model, ClientSession, RootFilterQuery } from 'mongoose';
import type {
  IRole,
  IUser,
  IGroup,
  IConfig,
  IAgent,
  IAclEntry,
  IPluginAuth,
  IToken,
  MCPServerDocument,
  MCPAuthorityProofV1,
  MCPAuthorityBootRevision,
  MCPAuthorityResolveInput,
  MCPAuthorityAssertInput,
  MCPAuthorityDatabaseMethods,
  MCPAuthorityGroupProof,
  MCPAuthorityConfigProof,
  MCPAuthorityServerProofV1,
  MCPAuthorityRejectionReason,
  MCPAuthorityImmutableConfig,
  MCPAuthorityServerSource,
} from '~/types';
import { BASE_CONFIG_PRINCIPAL_ID } from '~/admin/capabilities';
import { MCP_AUTHORITY_PROOF_VERSION } from '~/types';
import { getTenantId } from '~/config/tenantContext';
import logger from '~/config/winston';

interface PinnableQuery {
  session(session: ClientSession): this;
}

interface PreparedTarget {
  readonly serverName: string;
  readonly normalizedServerName: string;
  readonly source: MCPAuthorityServerSource;
  readonly databaseId: string | null;
  readonly sourceRevision: string;
  readonly expectedCredentialRevision: string;
  readonly expectedOAuthGrantGeneration: string | null;
  readonly resolvedConfigDigest: string;
  readonly credentialFields: readonly string[];
  readonly requiresOAuth: boolean;
}

interface UserProjection {
  _id: Types.ObjectId;
  tenantId?: string;
  role?: string;
  provider?: string;
  idOnTheSource?: string;
  openidIssuer?: string;
  googleId?: string;
  facebookId?: string;
  openidId?: string;
  samlId?: string;
  ldapId?: string;
  githubId?: string;
  discordId?: string;
  appleId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

interface GroupProjection {
  _id: Types.ObjectId;
  source: string;
  idOnTheSource?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

interface ConfigProjection {
  _id: Types.ObjectId;
  principalType: PrincipalType;
  principalId: string | Types.ObjectId;
  priority: number;
  mcpSettingsOverride?: object;
  tombstones?: string[];
  isActive: boolean;
  configVersion: number;
  updatedAt?: Date;
}

interface RoleProjection {
  _id: Types.ObjectId;
  name: string;
  permissions?: IRole['permissions'];
}

interface ServerProjection {
  _id: Types.ObjectId;
  serverName: string;
  normalizedServerName: string;
  config: MCPServerDocument['config'];
  author: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

interface AgentProjection {
  _id: Types.ObjectId;
  id: string;
  mcpServerNames?: string[];
  createdAt?: Date;
  updatedAt?: Date;
}

interface AclProjection {
  _id: Types.ObjectId;
  principalType: PrincipalType;
  principalId?: Types.ObjectId | string;
  resourceType: ResourceType;
  resourceId: Types.ObjectId;
  permBits: number;
  expiredAt?: Date;
  updatedAt?: Date;
}

interface PluginAuthProjection {
  _id: Types.ObjectId;
  pluginKey?: string;
  authField: string;
  value: string;
  createdAt?: Date;
  updatedAt?: Date;
}

interface TokenProjection {
  _id: Types.ObjectId;
  type?: string;
  identifier?: string;
  token: string;
  metadata?: Map<string, unknown> | Record<string, unknown>;
  createdAt: Date;
  expiresAt: Date;
}

interface AggregateBatch<Projection> {
  _id: null;
  rows: Projection[];
  count: number;
}

const OAUTH_TOKEN_TYPES = ['mcp_oauth', 'mcp_oauth_refresh', 'mcp_oauth_client'] as const;
type OAuthTokenType = (typeof OAUTH_TOKEN_TYPES)[number];
export const MAX_MCP_AUTHORITY_TARGETS = 32;
const MAX_MCP_AUTHORITY_GROUPS = 64;
const MAX_MCP_AUTHORITY_AGENTS = 64;
const MAX_MCP_AUTHORITY_CREDENTIALS = 64;
const MAX_MCP_AUTHORITY_ACL_ENTRIES = 96;
const MAX_MCP_AUTHORITY_SERVER_NAME_LENGTH = 256;
const MAX_MCP_AUTHORITY_CREDENTIAL_FIELD_LENGTH = 256;
const MAX_MCP_AUTHORITY_CREDENTIAL_FIELDS = 64;
const MAX_MCP_AUTHORITY_SOURCE_REVISION_LENGTH = 256;
const MAX_MCP_AUTHORITY_CONFIG_TOMBSTONES = 64;

export type MCPAuthorityMethods = MCPAuthorityDatabaseMethods;

export interface MCPAuthorityMethodHooks {
  afterPrincipalSnapshot?: () => void | Promise<void>;
  /** Overrides the cooldown that throttles snapshot-namespace preflight
   * retries after a failure. Tests use it to exercise both sides of the
   * boundary without waiting. */
  snapshotNamespaceRetryCooldownMs?: number;
}

export class MCPAuthorityProofError extends Error {
  constructor(
    public readonly reason: MCPAuthorityRejectionReason,
    message: string,
    public readonly serverName?: string,
  ) {
    super(message);
    this.name = 'MCPAuthorityProofError';
  }
}

function reject(reason: MCPAuthorityRejectionReason, message: string, serverName?: string): never {
  throw new MCPAuthorityProofError(reason, message, serverName);
}

function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      reject('malformed_input', 'Authority proof data contains a non-finite number');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'undefined') {
    return 'null';
  }
  if (typeof value !== 'object') {
    reject('malformed_input', 'Authority proof data contains an unsupported value');
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      reject('malformed_input', 'Authority proof data contains an invalid date');
    }
    return JSON.stringify(value.toISOString());
  }
  if (value instanceof Types.ObjectId) {
    return JSON.stringify(value.toHexString());
  }
  if (seen.has(value)) {
    reject('malformed_input', 'Authority proof data contains a circular value');
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const serialized = `[${value.map((item) => stableStringify(item, seen)).join(',')}]`;
    seen.delete(value);
    return serialized;
  }
  if (value instanceof Map) {
    const entries = [...value.entries()].sort(([left], [right]) =>
      String(left).localeCompare(String(right)),
    );
    const serialized = `{${entries
      .map(([key, item]) => `${JSON.stringify(String(key))}:${stableStringify(item, seen)}`)
      .join(',')}}`;
    seen.delete(value);
    return serialized;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  const serialized = `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key], seen)}`)
    .join(',')}}`;
  seen.delete(value);
  return serialized;
}

export function digestMCPAuthorityValue(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('base64url');
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

export function createMCPAuthorityBootRevision(
  revision: string,
  immutableConfig: MCPAuthorityImmutableConfig,
): MCPAuthorityBootRevision {
  const normalizedRevision = revision.trim();
  if (!normalizedRevision) {
    reject('malformed_input', 'MCP boot revision is required');
  }
  return deepFreeze({
    revision: normalizedRevision,
    digest: digestMCPAuthorityValue(immutableConfig),
  });
}

export interface MCPAuthorityConfigSourceDocument {
  _id: Types.ObjectId | string;
  principalType: PrincipalType;
  principalId: Types.ObjectId | string;
  priority: number;
  overrides?: IConfig['overrides'];
  tombstones?: readonly string[];
  isActive: boolean;
  configVersion: number;
  updatedAt?: Date | null;
}

export function createMCPAuthorityConfigSourceRevision(
  bootDigest: string,
  documents: readonly MCPAuthorityConfigSourceDocument[],
): string {
  if (typeof bootDigest !== 'string' || !bootDigest.trim() || !Array.isArray(documents)) {
    reject('malformed_input', 'MCP config source revision inputs are malformed');
  }
  if (documents.length > MAX_MCP_AUTHORITY_GROUPS + 3) {
    reject('malformed_input', 'MCP config source revision exceeds the proof limit');
  }
  const principals = new Set<string>();
  const configs = documents
    .map((document) => {
      const id = document._id.toString();
      const principalId = document.principalId.toString();
      const key = principalKey(document.principalType, principalId);
      const rawTombstones = document.tombstones ?? [];
      if (!Array.isArray(rawTombstones) || rawTombstones.some((path) => typeof path !== 'string')) {
        reject('malformed_input', 'MCP config source revision inputs are malformed');
      }
      const tombstones = rawTombstones
        .filter((path) => path === 'mcpSettings' || path.startsWith('mcpSettings.'))
        .sort();
      if (
        !Types.ObjectId.isValid(id) ||
        !principalId ||
        principals.has(key) ||
        !Number.isFinite(document.priority) ||
        typeof document.isActive !== 'boolean' ||
        !Number.isInteger(document.configVersion) ||
        document.configVersion < 0 ||
        tombstones.length > MAX_MCP_AUTHORITY_CONFIG_TOMBSTONES
      ) {
        reject('malformed_input', 'MCP config source revision inputs are malformed');
      }
      principals.add(key);
      const mcpSettingsOverride = document.overrides?.mcpSettings;
      return {
        id,
        principalType: document.principalType,
        principalId,
        priority: document.priority,
        isActive: document.isActive,
        configVersion: document.configVersion,
        mcpSettingsOverrideDigest:
          mcpSettingsOverride === undefined ? null : digestMCPAuthorityValue(mcpSettingsOverride),
        tombstones,
        updatedAt: document.updatedAt ?? null,
      };
    })
    .sort((left, right) =>
      principalKey(left.principalType, left.principalId).localeCompare(
        principalKey(right.principalType, right.principalId),
      ),
    );
  return digestMCPAuthorityValue({ bootDigest, configs });
}

export function createMCPAuthorityDatabaseSourceRevision(server: {
  databaseId: string;
  serverName: string;
  author: string;
  config: MCPServerDocument['config'];
  createdAt?: Date | null;
  updatedAt?: Date | null;
}): string {
  if (!Types.ObjectId.isValid(server.databaseId) || !server.serverName || !server.author) {
    reject('malformed_input', 'MCP database source revision inputs are malformed');
  }
  return digestMCPAuthorityValue({
    id: server.databaseId,
    name: server.serverName,
    author: server.author,
    config: server.config,
    createdAt: server.createdAt ?? null,
    updatedAt: server.updatedAt ?? null,
  });
}

export interface MCPAuthorityCredentialSourceDocument {
  _id: Types.ObjectId | string;
  authField: string;
  value: string;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

export function createMCPAuthorityCredentialRevision(
  credentialFields: readonly string[],
  credentials: readonly MCPAuthorityCredentialSourceDocument[],
): string {
  const fields = [...new Set(credentialFields)].sort();
  if (
    fields.length !== credentialFields.length ||
    fields.some(
      (field) =>
        !field ||
        field.trim() !== field ||
        field.length > MAX_MCP_AUTHORITY_CREDENTIAL_FIELD_LENGTH,
    )
  ) {
    reject('malformed_input', 'MCP credential source fields are malformed');
  }
  const fieldSet = new Set(fields);
  const seen = new Set<string>();
  const rows = credentials
    .map((credential) => {
      const id = credential._id.toString();
      if (
        !Types.ObjectId.isValid(id) ||
        !fieldSet.has(credential.authField) ||
        seen.has(credential.authField) ||
        typeof credential.value !== 'string'
      ) {
        reject('malformed_input', 'MCP credential source data is malformed');
      }
      seen.add(credential.authField);
      return {
        id,
        authField: credential.authField,
        valueDigest: digestMCPAuthorityValue(credential.value),
        createdAt: credential.createdAt ?? null,
        updatedAt: credential.updatedAt ?? null,
      };
    })
    .sort((left, right) => left.authField.localeCompare(right.authField));
  return digestMCPAuthorityValue({ expectedFields: fields, rows });
}

function pinAuthoritativeRead<QueryType extends PinnableQuery>(
  query: QueryType,
  session: ClientSession,
): QueryType {
  query.session(session);
  return query;
}

function normalizeCredentialFields(
  target: MCPAuthorityResolveInput['targets'][number],
): readonly string[] {
  const configured = target.resolvedConfig.customUserVars;
  const providedFields = target.credentialFields ?? [];
  if (!Array.isArray(providedFields) || providedFields.some((field) => typeof field !== 'string')) {
    reject('malformed_input', `Credential fields for "${target.serverName}" are malformed`);
  }
  const normalizedProvided = [
    ...new Set(providedFields.map((field) => field.trim()).filter(Boolean)),
  ];
  if (
    normalizedProvided.length !== providedFields.length ||
    normalizedProvided.some((field) => field.length > MAX_MCP_AUTHORITY_CREDENTIAL_FIELD_LENGTH)
  ) {
    reject('malformed_input', `Credential fields for "${target.serverName}" are malformed`);
  }
  const configuredFields = configured ? Object.keys(configured) : [];
  if (
    configuredFields.some(
      (field) =>
        !field ||
        field.trim() !== field ||
        field.length > MAX_MCP_AUTHORITY_CREDENTIAL_FIELD_LENGTH,
    )
  ) {
    reject('malformed_input', `Configured credentials for "${target.serverName}" are malformed`);
  }
  return [...new Set([...normalizedProvided, ...configuredFields])].sort();
}

function assertPreparedTargetBounds(targets: readonly PreparedTarget[]): void {
  if (targets.length > MAX_MCP_AUTHORITY_TARGETS) {
    reject('malformed_input', 'Too many selected MCP servers for one authority snapshot');
  }
  const credentialFieldCount = targets.reduce(
    (total, target) => total + target.credentialFields.length,
    0,
  );
  if (credentialFieldCount > MAX_MCP_AUTHORITY_CREDENTIAL_FIELDS) {
    reject('malformed_input', 'Too many MCP credential fields for one authority snapshot');
  }
}

function prepareTargets(targets: MCPAuthorityResolveInput['targets']): readonly PreparedTarget[] {
  if (!Array.isArray(targets)) {
    reject('malformed_input', 'Selected MCP authority targets are malformed');
  }
  if (targets.length === 0) {
    reject('malformed_input', 'At least one selected MCP server is required');
  }
  if (targets.length > MAX_MCP_AUTHORITY_TARGETS) {
    reject('malformed_input', 'Too many selected MCP servers for one authority snapshot');
  }
  const rawNames = new Set<string>();
  const normalizedNames = new Set<string>();
  const prepared = targets.map((target): PreparedTarget => {
    if (!target || typeof target !== 'object') {
      reject('malformed_input', 'Selected MCP authority target is malformed');
    }
    const source: string = target.source;
    if (
      !target.serverName ||
      target.serverName.trim() !== target.serverName ||
      target.serverName.length > MAX_MCP_AUTHORITY_SERVER_NAME_LENGTH
    ) {
      reject('malformed_input', 'Selected MCP server name is required');
    }
    if (rawNames.has(target.serverName)) {
      reject('malformed_input', `Selected MCP server "${target.serverName}" is duplicated`);
    }
    rawNames.add(target.serverName);
    const normalizedServerName = normalizeServerName(target.serverName);
    if (normalizedNames.has(normalizedServerName)) {
      reject(
        'malformed_input',
        `Selected MCP server "${target.serverName}" has an ambiguous normalized identity`,
        target.serverName,
      );
    }
    normalizedNames.add(normalizedServerName);
    if (source !== 'config' && source !== 'database') {
      reject('malformed_input', `Source for "${target.serverName}" is invalid`);
    }
    if (source === 'config' && target.databaseId != null) {
      reject('malformed_input', `Config server "${target.serverName}" has a database identity`);
    }
    if (source === 'database') {
      if (!target.databaseId || !Types.ObjectId.isValid(target.databaseId)) {
        reject('malformed_input', `Database identity for "${target.serverName}" is invalid`);
      }
    }
    if (
      typeof target.sourceRevision !== 'string' ||
      !target.sourceRevision ||
      target.sourceRevision.trim() !== target.sourceRevision ||
      target.sourceRevision.length > MAX_MCP_AUTHORITY_SOURCE_REVISION_LENGTH
    ) {
      reject('malformed_input', `Source revision for "${target.serverName}" is required`);
    }
    if (
      typeof target.expectedCredentialRevision !== 'string' ||
      !target.expectedCredentialRevision ||
      target.expectedCredentialRevision.length > MAX_MCP_AUTHORITY_SOURCE_REVISION_LENGTH ||
      (target.expectedOAuthGrantGeneration !== null &&
        (typeof target.expectedOAuthGrantGeneration !== 'string' ||
          !target.expectedOAuthGrantGeneration ||
          target.expectedOAuthGrantGeneration.length > MAX_MCP_AUTHORITY_SOURCE_REVISION_LENGTH))
    ) {
      reject('malformed_input', `Credential generation for "${target.serverName}" is malformed`);
    }
    if (target.requiresOAuth !== undefined && typeof target.requiresOAuth !== 'boolean') {
      reject('malformed_input', `OAuth requirement for "${target.serverName}" is malformed`);
    }
    if (
      !target.resolvedConfig ||
      typeof target.resolvedConfig !== 'object' ||
      Array.isArray(target.resolvedConfig)
    ) {
      reject('malformed_input', `Resolved config for "${target.serverName}" is malformed`);
    }
    return {
      serverName: target.serverName,
      normalizedServerName,
      source,
      databaseId: target.databaseId ?? null,
      sourceRevision: target.sourceRevision,
      expectedCredentialRevision: target.expectedCredentialRevision,
      expectedOAuthGrantGeneration: target.expectedOAuthGrantGeneration,
      resolvedConfigDigest: digestMCPAuthorityValue(target.resolvedConfig),
      credentialFields: normalizeCredentialFields(target),
      requiresOAuth: target.resolvedConfig.oauth != null || target.requiresOAuth === true,
    };
  });
  assertPreparedTargetBounds(prepared);
  return prepared.sort((left, right) => left.serverName.localeCompare(right.serverName));
}

function assertRevisionIntegrity<T extends { readonly revision: string }>(
  value: T,
  description: string,
): void {
  const { revision, ...revisionInput } = value;
  if (!revision || digestMCPAuthorityValue(revisionInput) !== revision) {
    reject('malformed_input', `${description} revision is invalid`);
  }
}

function assertProofIntegrity(proof: MCPAuthorityProofV1): void {
  if (!proof || typeof proof !== 'object' || proof.version !== MCP_AUTHORITY_PROOF_VERSION) {
    reject('malformed_input', 'MCP authority proof version is invalid');
  }
  if (!proof.shared || typeof proof.shared !== 'object' || !Array.isArray(proof.servers)) {
    reject('malformed_input', 'MCP authority proof contents are invalid');
  }
  const shared = proof.shared;
  if (
    !shared.user ||
    !shared.role ||
    !shared.boot ||
    !Array.isArray(shared.groups) ||
    !Array.isArray(shared.configs) ||
    !shared.user.userId ||
    !shared.user.revision ||
    !shared.role.revision ||
    !shared.boot.revision ||
    !shared.boot.digest
  ) {
    reject('malformed_input', 'MCP authority shared proof is invalid');
  }
  if (
    shared.groups.length > MAX_MCP_AUTHORITY_GROUPS ||
    shared.configs.length > MAX_MCP_AUTHORITY_GROUPS + 3 ||
    shared.configs.some(
      (config) =>
        !Array.isArray(config?.tombstones) ||
        config.tombstones.length > MAX_MCP_AUTHORITY_CONFIG_TOMBSTONES,
    )
  ) {
    reject('malformed_input', 'MCP authority shared proof exceeds its bounded shape');
  }
  if (shared.groups.some((group) => !group?.revision)) {
    reject('malformed_input', 'MCP authority group proof is invalid');
  }
  if (shared.configs.some((config) => !config?.revision)) {
    reject('malformed_input', 'MCP authority configuration proof is invalid');
  }
  if (shared.groupsRevision !== digestMCPAuthorityValue(shared.groups)) {
    reject('malformed_input', 'MCP authority group revision is invalid');
  }
  if (shared.configsRevision !== digestMCPAuthorityValue(shared.configs)) {
    reject('malformed_input', 'MCP authority configuration revision is invalid');
  }
  assertRevisionIntegrity(shared, 'MCP authority shared proof');

  if (proof.servers.length === 0 || proof.servers.length > MAX_MCP_AUTHORITY_TARGETS) {
    reject('malformed_input', 'MCP authority proof contains no selected servers');
  }
  const normalizedNames = new Set<string>();
  for (const server of proof.servers) {
    if (
      !server ||
      typeof server.serverName !== 'string' ||
      !server.serverName ||
      server.serverName.trim() !== server.serverName ||
      server.serverName.length > MAX_MCP_AUTHORITY_SERVER_NAME_LENGTH ||
      typeof server.normalizedServerName !== 'string' ||
      !server.normalizedServerName ||
      typeof server.sourceRevision !== 'string' ||
      !server.sourceRevision ||
      server.sourceRevision.trim() !== server.sourceRevision ||
      server.sourceRevision.length > MAX_MCP_AUTHORITY_SOURCE_REVISION_LENGTH ||
      !server.resolvedConfigDigest ||
      !server.serverRevision ||
      !server.authorizationRevision ||
      !server.credentialRevision ||
      !server.oauthRevision ||
      !server.effectivePolicyDigest ||
      !Array.isArray(server.linkedAgentIds) ||
      server.linkedAgentIds.length > MAX_MCP_AUTHORITY_AGENTS ||
      server.linkedAgentIds.some((id: string) => typeof id !== 'string') ||
      !Array.isArray(server.credentialFields) ||
      server.credentialFields.length > MAX_MCP_AUTHORITY_CREDENTIAL_FIELDS ||
      server.credentialFields.some((field: string) => typeof field !== 'string') ||
      typeof server.directAccess !== 'boolean' ||
      typeof server.agentAccess !== 'boolean' ||
      typeof server.requiresOAuth !== 'boolean' ||
      (server.oauthGrantGeneration !== null && typeof server.oauthGrantGeneration !== 'string')
    ) {
      reject('malformed_input', 'MCP authority server proof is invalid');
    }
    const normalizedServerName = normalizeServerName(server.serverName);
    if (server.normalizedServerName !== normalizedServerName) {
      reject(
        'malformed_input',
        'MCP authority server normalized identity is invalid',
        server.serverName,
      );
    }
    if (normalizedNames.has(normalizedServerName)) {
      reject(
        'malformed_input',
        'MCP authority proof contains ambiguous server identities',
        server.serverName,
      );
    }
    normalizedNames.add(normalizedServerName);
    if (
      (server.source !== 'config' && server.source !== 'database') ||
      (server.source === 'config' && server.databaseId !== null) ||
      (server.source === 'database' &&
        (typeof server.databaseId !== 'string' || !Types.ObjectId.isValid(server.databaseId)))
    ) {
      reject('malformed_input', 'MCP authority server source is invalid', server.serverName);
    }
    const normalizedCredentialFields = [...new Set<string>(server.credentialFields)].sort();
    if (
      normalizedCredentialFields.length !== server.credentialFields.length ||
      normalizedCredentialFields.some(
        (field, index) =>
          !field ||
          field.trim() !== field ||
          field.length > MAX_MCP_AUTHORITY_CREDENTIAL_FIELD_LENGTH ||
          field !== server.credentialFields[index],
      )
    ) {
      reject('malformed_input', 'MCP authority credential fields are invalid', server.serverName);
    }
    const expectedPolicyDigest = digestMCPAuthorityValue({
      sharedRevision: shared.revision,
      serverRevision: server.serverRevision,
      sourceRevision: server.sourceRevision,
      resolvedConfigDigest: server.resolvedConfigDigest,
      authorizationRevision: server.authorizationRevision,
      credentialRevision: server.credentialRevision,
      oauthRevision: server.oauthRevision,
    });
    if (server.effectivePolicyDigest !== expectedPolicyDigest) {
      reject('malformed_input', 'MCP authority effective policy is invalid', server.serverName);
    }
    assertRevisionIntegrity(server, 'MCP authority server proof');
  }
  assertRevisionIntegrity(proof, 'MCP authority proof');
}

function sourceIdentity(user: UserProjection): object {
  return {
    idOnTheSource: user.idOnTheSource ?? null,
    openidIssuer: user.openidIssuer ?? null,
    googleId: user.googleId ?? null,
    facebookId: user.facebookId ?? null,
    openidId: user.openidId ?? null,
    samlId: user.samlId ?? null,
    ldapId: user.ldapId ?? null,
    githubId: user.githubId ?? null,
    discordId: user.discordId ?? null,
    appleId: user.appleId ?? null,
  };
}

function principalKey(principalType: string, principalId: string): string {
  return `${principalType}:${principalId}`;
}

function appendIndexValue<Key, Value>(index: Map<Key, Value[]>, key: Key, value: Value): void {
  const values = index.get(key);
  if (values) {
    values.push(value);
    return;
  }
  index.set(key, [value]);
}

function assertCompleteBatch<Projection>(
  rows: readonly Projection[],
  count: number,
  limit: number,
  description: string,
): void {
  if (!Number.isInteger(count) || count < 0 || count > limit || rows.length !== count) {
    reject('proof_unavailable', `${description} exceeds one complete authoritative proof batch`);
  }
}

function unwrapAggregateBatch<Projection>(
  batches: readonly AggregateBatch<Projection>[],
  limit: number,
  description: string,
): Projection[] {
  if (batches.length === 0) {
    return [];
  }
  if (batches.length !== 1 || !Array.isArray(batches[0].rows)) {
    reject('proof_unavailable', `${description} proof batch is malformed`);
  }
  const batch = batches[0];
  assertCompleteBatch(batch.rows, batch.count, limit, description);
  return batch.rows;
}

function configSlots(userId: string, role: string, groups: readonly GroupProjection[]) {
  return [
    { principalType: PrincipalType.ROLE, principalId: BASE_CONFIG_PRINCIPAL_ID },
    { principalType: PrincipalType.ROLE, principalId: role },
    ...groups.map((group) => ({
      principalType: PrincipalType.GROUP,
      principalId: group._id.toHexString(),
    })),
    { principalType: PrincipalType.USER, principalId: userId },
  ].sort((left, right) =>
    principalKey(left.principalType, left.principalId).localeCompare(
      principalKey(right.principalType, right.principalId),
    ),
  );
}

function buildGroupProof(group: GroupProjection): MCPAuthorityGroupProof {
  const id = group._id.toHexString();
  const sourceIdentityDigest = digestMCPAuthorityValue({
    source: group.source,
    idOnTheSource: group.idOnTheSource ?? null,
  });
  return {
    id,
    source: group.source,
    sourceIdentityDigest,
    revision: digestMCPAuthorityValue({
      id,
      sourceIdentityDigest,
      createdAt: group.createdAt ?? null,
      updatedAt: group.updatedAt ?? null,
    }),
  };
}

function buildConfigProofs(
  slots: ReturnType<typeof configSlots>,
  documents: readonly ConfigProjection[],
): readonly MCPAuthorityConfigProof[] {
  const byPrincipal = new Map<string, ConfigProjection>();
  const allowed = new Set(slots.map((slot) => principalKey(slot.principalType, slot.principalId)));
  for (const document of documents) {
    const key = principalKey(document.principalType, document.principalId.toString());
    const tombstones = document.tombstones;
    if (!allowed.has(key) || byPrincipal.has(key)) {
      reject('proof_unavailable', 'Applicable MCP configuration proof is malformed');
    }
    if (
      typeof document.isActive !== 'boolean' ||
      !Number.isFinite(document.priority) ||
      !Number.isInteger(document.configVersion) ||
      document.configVersion < 0 ||
      !Array.isArray(tombstones) ||
      tombstones.some((path) => typeof path !== 'string')
    ) {
      reject('proof_unavailable', 'Applicable MCP configuration proof is malformed');
    }
    byPrincipal.set(key, document);
  }
  return slots.map((slot): MCPAuthorityConfigProof => {
    const document = byPrincipal.get(principalKey(slot.principalType, slot.principalId));
    if (!document) {
      const absent = {
        principalType: slot.principalType,
        principalId: slot.principalId,
        present: false,
        active: false,
        priority: null,
        configVersion: null,
        mcpOverrideDigest: null,
        tombstones: [] as readonly string[],
      };
      return { ...absent, revision: digestMCPAuthorityValue(absent) };
    }
    const tombstones = (document.tombstones ?? [])
      .filter((path) => path === 'mcpSettings' || path.startsWith('mcpSettings.'))
      .sort();
    if (tombstones.length > MAX_MCP_AUTHORITY_CONFIG_TOMBSTONES) {
      reject('proof_unavailable', 'Applicable MCP configuration tombstones exceed the proof limit');
    }
    const mcpOverrideDigest =
      document.mcpSettingsOverride === undefined
        ? null
        : digestMCPAuthorityValue(document.mcpSettingsOverride);
    const present = {
      principalType: slot.principalType,
      principalId: slot.principalId,
      present: true,
      active: document.isActive,
      priority: document.priority,
      configVersion: document.configVersion,
      mcpOverrideDigest,
      tombstones,
      documentId: document._id.toHexString(),
      updatedAt: document.updatedAt ?? null,
    };
    return {
      principalType: present.principalType,
      principalId: present.principalId,
      present: present.present,
      active: present.active,
      priority: present.priority,
      configVersion: present.configVersion,
      mcpOverrideDigest: present.mcpOverrideDigest,
      tombstones: present.tombstones,
      revision: digestMCPAuthorityValue(present),
    };
  });
}

function tokenMetadata(token: TokenProjection): Record<string, unknown> {
  if (!token.metadata) {
    return {};
  }
  return token.metadata instanceof Map
    ? Object.fromEntries(token.metadata.entries())
    : { ...token.metadata };
}

function oauthTokenIdentities(
  serverName: string,
): readonly { type: OAuthTokenType; identifier: string }[] {
  const base = `mcp:${serverName}`;
  return [
    { type: 'mcp_oauth', identifier: base },
    { type: 'mcp_oauth_refresh', identifier: `${base}:refresh` },
    { type: 'mcp_oauth_client', identifier: `${base}:client` },
  ];
}

function oauthTokenKey(type: string, identifier: string): string {
  return JSON.stringify([type, identifier]);
}

function isActiveViewAcl(entry: AclProjection, now: Date): boolean {
  if (!Number.isInteger(entry.permBits) || entry.permBits < 0) {
    reject('proof_unavailable', 'MCP ACL proof is malformed');
  }
  return (
    (entry.permBits & PermissionBits.VIEW) === PermissionBits.VIEW &&
    (!entry.expiredAt || entry.expiredAt > now)
  );
}

function aclRevision(entry: AclProjection): object {
  return {
    id: entry._id.toHexString(),
    principalType: entry.principalType,
    principalId: entry.principalId?.toString() ?? null,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId.toHexString(),
    permBits: entry.permBits,
    expiredAt: entry.expiredAt ?? null,
    updatedAt: entry.updatedAt ?? null,
  };
}

function buildCredentialProof(
  target: PreparedTarget,
  credentials: readonly PluginAuthProjection[],
): { fields: readonly string[]; revision: string } {
  const pluginKey = `${Constants.mcp_prefix}${target.serverName}`;
  const selected = credentials.filter((credential) => credential.pluginKey === pluginKey);
  return {
    fields: target.credentialFields,
    revision: createMCPAuthorityCredentialRevision(target.credentialFields, selected),
  };
}

function buildOAuthProof(
  target: PreparedTarget,
  tokens: readonly TokenProjection[],
  now: Date,
): { generation: string | null; revision: string } {
  const identities = new Set(
    oauthTokenIdentities(target.serverName).map(({ type, identifier }) =>
      oauthTokenKey(type, identifier),
    ),
  );
  const seen = new Set<string>();
  const generations = new Set<string>();
  const rows = tokens
    .map((token) => {
      const type = token.type ?? '';
      const identifier = token.identifier ?? '';
      const key = oauthTokenKey(type, identifier);
      if (
        !OAUTH_TOKEN_TYPES.includes(type as (typeof OAUTH_TOKEN_TYPES)[number]) ||
        !identifier ||
        !identities.has(key) ||
        seen.has(key)
      ) {
        reject('proof_unavailable', 'MCP OAuth grant proof is malformed', target.serverName);
      }
      seen.add(key);
      const metadata = tokenMetadata(token);
      const generation = metadata.credential_set_id;
      if (typeof generation !== 'string' || generation.length === 0) {
        reject('proof_unavailable', 'MCP OAuth grant proof is malformed', target.serverName);
      }
      generations.add(generation);
      return {
        id: token._id.toHexString(),
        type,
        identifier,
        generation,
        tokenDigest: digestMCPAuthorityValue(token.token),
        metadataDigest: digestMCPAuthorityValue(metadata),
        createdAt: token.createdAt,
        expiresAt: token.expiresAt,
        active: token.expiresAt > now,
      };
    })
    .sort((left, right) =>
      `${left.type}:${left.identifier}`.localeCompare(`${right.type}:${right.identifier}`),
    );
  if (generations.size > 1) {
    reject('proof_unavailable', 'MCP OAuth grant generations disagree', target.serverName);
  }
  const generation = generations.values().next().value ?? null;
  return {
    generation,
    revision: digestMCPAuthorityValue({ requiresOAuth: target.requiresOAuth, rows }),
  };
}

function asMCPError(error: unknown): MCPAuthorityProofError {
  if (error instanceof MCPAuthorityProofError) {
    return error;
  }
  return new MCPAuthorityProofError(
    'proof_unavailable',
    'Authoritative MCP proof data is unavailable',
  );
}

/** `NamespaceExists`: the collection is already there, including when a
 * concurrent creator won the race. */
const NAMESPACE_EXISTS_CODE = 48;

/** After a failed namespace preflight, hold the failure this long before
 * attempting the DDL again. Without it a persistent failure (an authorization
 * error, say) turns every authority request into another serial collection
 * preflight — a DDL retry storm precisely while the database is unhealthy. */
const SNAPSHOT_NAMESPACE_RETRY_COOLDOWN_MS = 30_000;

function isNamespaceExistsError(error: unknown): boolean {
  const candidate = error as { code?: number; codeName?: string; message?: string };
  return (
    candidate?.code === NAMESPACE_EXISTS_CODE ||
    candidate?.codeName === 'NamespaceExists' ||
    /already exists/i.test(String(candidate?.message ?? ''))
  );
}

/** Every collection the authoritative snapshot reads inside its transaction. */
const AUTHORITY_SNAPSHOT_MODELS = [
  'User',
  'Role',
  'Group',
  'Config',
  'MCPServer',
  'Agent',
  'AclEntry',
  'PluginAuth',
  'Token',
] as const;

export function createMCPAuthorityMethods(
  mongoose: typeof import('mongoose'),
  hooks: MCPAuthorityMethodHooks = {},
): MCPAuthorityDatabaseMethods {
  let snapshotNamespacesReady: Promise<void> | undefined;
  let snapshotNamespacesFailure: { error: unknown; at: number } | undefined;
  const namespaceRetryCooldownMs =
    hooks.snapshotNamespaceRetryCooldownMs ?? SNAPSHOT_NAMESPACE_RETRY_COOLDOWN_MS;

  /** Amazon DocumentDB rejects any statement inside a transaction that touches
   * a collection which does not exist, and `asMCPError` converts that server
   * rejection into `proof_unavailable` — so on a deployment where, say, no
   * `PluginAuth` or `Token` row has ever been written, every authority proof
   * fails with an error that names nothing about the real cause. Materializing
   * the snapshot's namespaces before the transaction opens costs one `create`
   * per collection per process and nothing on MongoDB, which tolerates the
   * in-transaction read either way. */
  async function ensureSnapshotNamespaces(): Promise<void> {
    /** Inside the cooldown, replay the recorded failure without touching the
     * database: retries stay possible, but bounded. */
    if (snapshotNamespacesFailure != null) {
      if (Date.now() - snapshotNamespacesFailure.at < namespaceRetryCooldownMs) {
        throw snapshotNamespacesFailure.error;
      }
      snapshotNamespacesFailure = undefined;
    }
    snapshotNamespacesReady ??= (async () => {
      for (const modelName of AUTHORITY_SNAPSHOT_MODELS) {
        const model = mongoose.models[modelName];
        if (model == null) {
          continue;
        }
        try {
          await model.createCollection();
        } catch (error) {
          /** The namespace already exists, or a concurrent creator won the
           * race — either way it is there now. EVERY other failure must
           * propagate: swallowing one would cache this promise as settled and
           * skip creation for the rest of the process, so a transient error
           * would strand authority proofs permanently even after it cleared. */
          if (!isNamespaceExistsError(error)) {
            throw error;
          }
          logger.debug(`[MCPAuthority] ${modelName} collection already exists`);
        }
      }
    })();
    try {
      await snapshotNamespacesReady;
      snapshotNamespacesFailure = undefined;
    } catch (error) {
      /** Clear the memo so a later request retries rather than inheriting a
       * failure that may have already cleared, and record it so requests
       * arriving during the cooldown fail fast instead of re-running the DDL. */
      snapshotNamespacesReady = undefined;
      snapshotNamespacesFailure = { error, at: Date.now() };
      throw error;
    }
  }

  async function loadCurrentProof(
    userId: string,
    tenantId: string | undefined,
    boot: MCPAuthorityBootRevision,
    targets: readonly PreparedTarget[],
    session: ClientSession,
  ): Promise<MCPAuthorityProofV1> {
    if (!Types.ObjectId.isValid(userId)) {
      reject('malformed_input', 'MCP authority user identity is invalid');
    }
    if (!boot.revision.trim() || !boot.digest.trim()) {
      reject('malformed_input', 'MCP boot authority revision is malformed');
    }
    const tenantScope =
      tenantId === undefined ? { tenantId: { $exists: false as const } } : { tenantId };

    const User = mongoose.models.User as Model<IUser>;
    const userQuery = User.findOne({ _id: new Types.ObjectId(userId), ...tenantScope }).select(
      '_id tenantId role provider idOnTheSource openidIssuer googleId facebookId openidId samlId ldapId githubId discordId appleId createdAt updatedAt',
    );
    const user = await pinAuthoritativeRead(userQuery, session).lean<UserProjection>();
    if (!user) {
      reject('user_revoked', 'MCP authority user no longer exists');
    }
    const actualTenantId = user.tenantId ?? null;
    if (actualTenantId !== (tenantId ?? null)) {
      reject('principal_changed', 'MCP authority tenant identity changed');
    }
    const roleName = user.role?.trim();
    const provider = user.provider?.trim();
    if (!roleName || !provider) {
      reject('proof_unavailable', 'MCP authority principal data is malformed');
    }
    const memberId = user.idOnTheSource || userId;

    const Group = mongoose.models.Group as Model<IGroup>;
    const Role = mongoose.models.Role as Model<IRole>;
    const groupFilter = { memberIds: memberId, ...tenantScope };
    const groupCountQuery = Group.countDocuments(groupFilter).limit(MAX_MCP_AUTHORITY_GROUPS + 1);
    const groupQuery = Group.find(groupFilter)
      .select('_id source idOnTheSource createdAt updatedAt')
      .limit(MAX_MCP_AUTHORITY_GROUPS + 1)
      .setOptions({ singleBatch: true });
    const roleQuery = Role.findOne({ name: roleName, ...tenantScope }).select(
      '_id name permissions.MCP_SERVERS.USE',
    );
    const groupCount = await pinAuthoritativeRead(groupCountQuery, session);
    const groups = await pinAuthoritativeRead(groupQuery, session).lean<GroupProjection[]>();
    const role = await pinAuthoritativeRead(roleQuery, session).lean<RoleProjection>();
    assertCompleteBatch(groups, groupCount, MAX_MCP_AUTHORITY_GROUPS, 'MCP group membership');
    if (!role || role.name !== roleName) {
      reject('role_changed', 'MCP authority role no longer exists');
    }
    const useMCP = role.permissions?.[PermissionTypes.MCP_SERVERS]?.[Permissions.USE] === true;
    if (!useMCP) {
      reject('mcp_use_revoked', 'MCP server use permission is not current');
    }
    await hooks.afterPrincipalSnapshot?.();
    const sortedGroups = groups.sort((left, right) =>
      left._id.toHexString().localeCompare(right._id.toHexString()),
    );
    const slots = configSlots(userId, roleName, sortedGroups);
    const lookupNames = [
      ...new Set(targets.flatMap((target) => [target.serverName, target.normalizedServerName])),
    ];
    const oauthSelectors = targets
      .filter((target) => target.requiresOAuth)
      .flatMap((target) => oauthTokenIdentities(target.serverName));

    const Config = mongoose.models.Config as Model<IConfig>;
    const MCPServer = mongoose.models.MCPServer as Model<MCPServerDocument>;
    const Agent = mongoose.models.Agent as Model<IAgent>;
    const PluginAuth = mongoose.models.PluginAuth as Model<IPluginAuth>;
    const Token = mongoose.models.Token as Model<IToken>;
    const selectedServerNames = targets.map((target) => target.serverName);
    const selectedDatabaseServerNames = targets
      .filter((target) => target.source === 'database')
      .map((target) => target.serverName);
    const tombstoneConditions = [
      { $eq: ['$$path', 'mcpSettings'] },
      { $eq: [{ $indexOfCP: ['$$path', 'mcpSettings.'] }, 0] },
    ];
    const configQuery = Config.aggregate<AggregateBatch<ConfigProjection>>([
      { $match: { $and: [tenantScope, { $or: slots }] } },
      {
        $project: {
          _id: 1,
          principalType: 1,
          principalId: 1,
          priority: 1,
          isActive: 1,
          configVersion: 1,
          updatedAt: 1,
          mcpSettingsOverride: '$overrides.mcpSettings',
          tombstones: {
            $slice: [
              {
                $filter: {
                  input: { $ifNull: ['$tombstones', []] },
                  as: 'path',
                  cond: { $or: tombstoneConditions },
                },
              },
              MAX_MCP_AUTHORITY_CONFIG_TOMBSTONES + 1,
            ],
          },
        },
      },
      { $limit: MAX_MCP_AUTHORITY_GROUPS + 4 },
      { $group: { _id: null, rows: { $push: '$$ROOT' }, count: { $sum: 1 } } },
    ]);
    const normalizedNames = targets.map((target) => target.normalizedServerName);
    const serverFilter = {
      ...tenantScope,
      $or: [
        { serverName: { $in: lookupNames } },
        { normalizedServerName: { $in: normalizedNames } },
      ],
    };
    const serverCountQuery = MCPServer.countDocuments(serverFilter).limit(
      MAX_MCP_AUTHORITY_TARGETS * 2 + 1,
    );
    const serverQuery = MCPServer.find(serverFilter)
      .select('_id serverName normalizedServerName config author createdAt updatedAt')
      .limit(MAX_MCP_AUTHORITY_TARGETS * 2 + 1)
      .setOptions({ singleBatch: true });
    const agentQuery = Agent.aggregate<AggregateBatch<AgentProjection>>([
      {
        $match: {
          mcpServerNames: { $in: selectedDatabaseServerNames },
          ...tenantScope,
        },
      },
      {
        $project: {
          _id: 1,
          id: 1,
          createdAt: 1,
          updatedAt: 1,
          mcpServerNames: {
            $filter: {
              input: { $ifNull: ['$mcpServerNames', []] },
              as: 'serverName',
              cond: { $in: ['$$serverName', selectedDatabaseServerNames] },
            },
          },
        },
      },
      { $limit: MAX_MCP_AUTHORITY_AGENTS + 1 },
      { $group: { _id: null, rows: { $push: '$$ROOT' }, count: { $sum: 1 } } },
    ]);
    const credentialSelectors = targets
      .filter((target) => target.credentialFields.length > 0)
      .map((target) => ({
        pluginKey: `${Constants.mcp_prefix}${target.serverName}`,
        authField: { $in: target.credentialFields },
      }));
    const credentialFilter = {
      userId,
      ...tenantScope,
      $or: credentialSelectors.length > 0 ? credentialSelectors : [{ _id: null }],
    };
    const credentialCountQuery = PluginAuth.countDocuments(credentialFilter).limit(
      MAX_MCP_AUTHORITY_CREDENTIALS + 1,
    );
    const credentialQuery = PluginAuth.find(credentialFilter)
      .select('_id pluginKey authField value createdAt updatedAt')
      .limit(MAX_MCP_AUTHORITY_CREDENTIALS + 1)
      .setOptions({ singleBatch: true });
    const tokenFilter = {
      userId: new Types.ObjectId(userId),
      ...tenantScope,
      $or: oauthSelectors.length > 0 ? oauthSelectors : [{ _id: null }],
    };
    const tokenCountQuery = Token.countDocuments(tokenFilter).limit(
      MAX_MCP_AUTHORITY_TARGETS * OAUTH_TOKEN_TYPES.length + 1,
    );
    const tokenQuery = Token.find(tokenFilter)
      .select('_id type identifier token metadata createdAt expiresAt')
      .limit(MAX_MCP_AUTHORITY_TARGETS * OAUTH_TOKEN_TYPES.length + 1)
      .setOptions({ singleBatch: true });
    const configBatch = await pinAuthoritativeRead(configQuery, session);
    const configs = unwrapAggregateBatch(configBatch, slots.length, 'Applicable MCP configuration');
    const serverCount = await pinAuthoritativeRead(serverCountQuery, session);
    const servers = await pinAuthoritativeRead(serverQuery, session).lean<ServerProjection[]>();
    assertCompleteBatch(
      servers,
      serverCount,
      MAX_MCP_AUTHORITY_TARGETS * 2,
      'Selected MCP servers',
    );
    const agentBatch = await pinAuthoritativeRead(agentQuery, session);
    const agents = unwrapAggregateBatch(
      agentBatch,
      MAX_MCP_AUTHORITY_AGENTS,
      'Selected MCP Agent linkage',
    );
    const credentialCount = await pinAuthoritativeRead(credentialCountQuery, session);
    const credentials = await pinAuthoritativeRead(credentialQuery, session).lean<
      PluginAuthProjection[]
    >();
    assertCompleteBatch(
      credentials,
      credentialCount,
      MAX_MCP_AUTHORITY_CREDENTIALS,
      'Selected MCP credentials',
    );
    const tokenCount = await pinAuthoritativeRead(tokenCountQuery, session);
    const tokens = await pinAuthoritativeRead(tokenQuery, session).lean<TokenProjection[]>();
    assertCompleteBatch(
      tokens,
      tokenCount,
      MAX_MCP_AUTHORITY_TARGETS * OAUTH_TOKEN_TYPES.length,
      'Selected MCP OAuth grants',
    );

    const serverIds = servers.map((server) => server._id);
    const agentIds = agents.map((agent) => agent._id);
    let aclEntries: AclProjection[] = [];
    if (serverIds.length > 0 || agentIds.length > 0) {
      const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
      const principals: RootFilterQuery<IAclEntry>[] = [
        { principalType: PrincipalType.USER, principalId: new Types.ObjectId(userId) },
        { principalType: PrincipalType.ROLE, principalId: roleName },
        { principalType: PrincipalType.PUBLIC },
        ...sortedGroups.map((group) => ({
          principalType: PrincipalType.GROUP,
          principalId: group._id,
        })),
      ];
      const resources: RootFilterQuery<IAclEntry>[] = [];
      if (serverIds.length > 0) {
        resources.push({ resourceType: ResourceType.MCPSERVER, resourceId: { $in: serverIds } });
      }
      if (agentIds.length > 0) {
        resources.push({ resourceType: ResourceType.AGENT, resourceId: { $in: agentIds } });
      }
      const aclFilter = {
        $and: [tenantScope, { $or: principals }, { $or: resources }],
      };
      const aclCountQuery = AclEntry.countDocuments(aclFilter).limit(
        MAX_MCP_AUTHORITY_ACL_ENTRIES + 1,
      );
      const aclQuery = AclEntry.find(aclFilter)
        .select(
          '_id principalType principalId resourceType resourceId permBits expiredAt updatedAt',
        )
        .limit(MAX_MCP_AUTHORITY_ACL_ENTRIES + 1)
        .setOptions({ singleBatch: true });
      const aclCount = await pinAuthoritativeRead(aclCountQuery, session);
      aclEntries = await pinAuthoritativeRead(aclQuery, session).lean<AclProjection[]>();
      assertCompleteBatch(
        aclEntries,
        aclCount,
        MAX_MCP_AUTHORITY_ACL_ENTRIES,
        'Selected MCP ACL entries',
      );
    }

    const serversByNormalizedName = new Map<string, ServerProjection[]>();
    for (const server of servers) {
      if (
        typeof server.serverName !== 'string' ||
        typeof server.normalizedServerName !== 'string' ||
        server.normalizedServerName !== normalizeServerName(server.serverName)
      ) {
        reject('proof_unavailable', 'MCP server name index is malformed');
      }
      appendIndexValue(serversByNormalizedName, server.normalizedServerName, server);
    }
    const selectedServerNameSet = new Set(selectedServerNames);
    const agentsByServerName = new Map<string, AgentProjection[]>();
    for (const agent of agents) {
      if (
        agent.mcpServerNames !== undefined &&
        (!Array.isArray(agent.mcpServerNames) ||
          agent.mcpServerNames.some((serverName) => typeof serverName !== 'string'))
      ) {
        reject('proof_unavailable', 'MCP Agent linkage proof is malformed');
      }
      const selectedLinks = new Set(
        (agent.mcpServerNames ?? []).filter((serverName) => selectedServerNameSet.has(serverName)),
      );
      for (const serverName of selectedLinks) {
        appendIndexValue(agentsByServerName, serverName, agent);
      }
    }
    const credentialsByPluginKey = new Map<string, PluginAuthProjection[]>();
    for (const credential of credentials) {
      if (typeof credential.pluginKey !== 'string') {
        reject('proof_unavailable', 'MCP credential proof is malformed');
      }
      appendIndexValue(credentialsByPluginKey, credential.pluginKey, credential);
    }
    const serverNameByOAuthTokenKey = new Map<string, string>();
    for (const selected of targets) {
      for (const { type, identifier } of oauthTokenIdentities(selected.serverName)) {
        serverNameByOAuthTokenKey.set(oauthTokenKey(type, identifier), selected.serverName);
      }
    }
    const tokensByServerName = new Map<string, TokenProjection[]>();
    for (const token of tokens) {
      const serverName =
        token.type && token.identifier
          ? serverNameByOAuthTokenKey.get(oauthTokenKey(token.type, token.identifier))
          : undefined;
      if (!serverName) {
        reject('proof_unavailable', 'MCP OAuth grant proof is malformed');
      }
      appendIndexValue(tokensByServerName, serverName, token);
    }
    const directAclByServerId = new Map<string, AclProjection[]>();
    const agentAclByAgentId = new Map<string, AclProjection[]>();
    for (const entry of aclEntries) {
      const resourceId = entry.resourceId.toHexString();
      if (entry.resourceType === ResourceType.MCPSERVER) {
        appendIndexValue(directAclByServerId, resourceId, entry);
      } else if (entry.resourceType === ResourceType.AGENT) {
        appendIndexValue(agentAclByAgentId, resourceId, entry);
      } else {
        reject('proof_unavailable', 'MCP ACL proof is malformed');
      }
    }

    const userSourceIdentityDigest = digestMCPAuthorityValue(sourceIdentity(user));
    const userProof = {
      userId,
      tenantId: actualTenantId,
      role: roleName,
      provider,
      sourceIdentityDigest: userSourceIdentityDigest,
      revision: digestMCPAuthorityValue({
        userId,
        tenantId: actualTenantId,
        role: roleName,
        provider,
        sourceIdentityDigest: userSourceIdentityDigest,
        createdAt: user.createdAt ?? null,
        updatedAt: user.updatedAt ?? null,
      }),
    };
    const groupProofs = sortedGroups.map(buildGroupProof);
    const groupsRevision = digestMCPAuthorityValue(groupProofs);
    const configProofs = buildConfigProofs(slots, configs);
    const configsRevision = digestMCPAuthorityValue(configProofs);
    const configSourceRevision = createMCPAuthorityConfigSourceRevision(
      boot.digest,
      configs.map((config) => ({
        _id: config._id,
        principalType: config.principalType,
        principalId: config.principalId,
        priority: config.priority,
        overrides:
          config.mcpSettingsOverride === undefined
            ? undefined
            : { mcpSettings: config.mcpSettingsOverride },
        tombstones: config.tombstones,
        isActive: config.isActive,
        configVersion: config.configVersion,
        updatedAt: config.updatedAt,
      })),
    );
    const roleProof = {
      id: role._id.toHexString(),
      name: role.name,
      use: useMCP,
      revision: digestMCPAuthorityValue({
        id: role._id.toHexString(),
        name: role.name,
        use: useMCP,
      }),
    };
    const sharedWithoutRevision = {
      user: userProof,
      groups: groupProofs,
      configs: configProofs,
      role: roleProof,
      boot,
      groupsRevision,
      configsRevision,
    };
    const shared = {
      ...sharedWithoutRevision,
      revision: digestMCPAuthorityValue(sharedWithoutRevision),
    };
    const now = new Date();
    const serverProofs = targets.map((target): MCPAuthorityServerProofV1 => {
      const collidingServers = serversByNormalizedName.get(target.normalizedServerName) ?? [];
      if (collidingServers.length > 1) {
        reject('server_changed', 'MCP server normalized identity is ambiguous', target.serverName);
      }
      const databaseServer = collidingServers[0];
      if (target.source === 'config' && databaseServer) {
        reject(
          'server_changed',
          'MCP config server collides with a database server identity',
          target.serverName,
        );
      }
      if (
        target.source === 'database' &&
        (!databaseServer || databaseServer.serverName !== target.serverName)
      ) {
        reject(
          'server_revoked',
          'Selected MCP database server no longer exists',
          target.serverName,
        );
      }
      const databaseId = databaseServer?._id.toHexString() ?? null;
      if (target.databaseId && target.databaseId !== databaseId) {
        reject('server_changed', 'Selected MCP database identity changed', target.serverName);
      }
      const serverRevision = databaseServer
        ? createMCPAuthorityDatabaseSourceRevision({
            databaseId: databaseServer._id.toHexString(),
            serverName: databaseServer.serverName,
            author: databaseServer.author.toString(),
            config: databaseServer.config,
            createdAt: databaseServer.createdAt,
            updatedAt: databaseServer.updatedAt,
          })
        : digestMCPAuthorityValue({ source: 'config', name: target.serverName });
      const sourceRevision = target.source === 'database' ? serverRevision : configSourceRevision;
      if (target.sourceRevision !== sourceRevision) {
        reject(
          target.source === 'database' ? 'server_changed' : 'config_changed',
          'Selected MCP source changed before authority was resolved',
          target.serverName,
        );
      }
      const linkedAgents = (agentsByServerName.get(target.serverName) ?? []).sort((left, right) =>
        left._id.toHexString().localeCompare(right._id.toHexString()),
      );
      const linkedAgentIds = linkedAgents.map((agent) => agent._id.toHexString());
      const directAcl = databaseId ? (directAclByServerId.get(databaseId) ?? []) : [];
      const agentAcl = linkedAgentIds.flatMap((id) => agentAclByAgentId.get(id) ?? []);
      const directAccess = directAcl.some((entry) => isActiveViewAcl(entry, now));
      const agentAccess = agentAcl.some((entry) => isActiveViewAcl(entry, now));
      if (target.source === 'database' && !directAccess && !agentAccess) {
        reject('access_revoked', 'Selected MCP server access is not current', target.serverName);
      }
      const authorizationRevision = digestMCPAuthorityValue({
        linkedAgents: linkedAgents.map((agent) => ({
          id: agent._id.toHexString(),
          agentId: agent.id,
          serverNames: [...(agent.mcpServerNames ?? [])].sort(),
          createdAt: agent.createdAt ?? null,
          updatedAt: agent.updatedAt ?? null,
        })),
        directAcl: directAcl
          .map(aclRevision)
          .sort((left, right) =>
            String((left as { id: string }).id).localeCompare((right as { id: string }).id),
          ),
        agentAcl: agentAcl
          .map(aclRevision)
          .sort((left, right) =>
            String((left as { id: string }).id).localeCompare((right as { id: string }).id),
          ),
        directAccess,
        agentAccess,
      });
      const credential = buildCredentialProof(
        target,
        credentialsByPluginKey.get(`${Constants.mcp_prefix}${target.serverName}`) ?? [],
      );
      const oauth = buildOAuthProof(target, tokensByServerName.get(target.serverName) ?? [], now);
      if (credential.revision !== target.expectedCredentialRevision) {
        reject(
          'credential_changed',
          'Selected MCP credential changed before authority was resolved',
          target.serverName,
        );
      }
      if (oauth.generation !== target.expectedOAuthGrantGeneration) {
        reject(
          'oauth_grant_changed',
          'Selected MCP OAuth grant changed before authority was resolved',
          target.serverName,
        );
      }
      const effectivePolicyDigest = digestMCPAuthorityValue({
        sharedRevision: shared.revision,
        serverRevision,
        sourceRevision,
        resolvedConfigDigest: target.resolvedConfigDigest,
        authorizationRevision,
        credentialRevision: credential.revision,
        oauthRevision: oauth.revision,
      });
      const proofWithoutRevision = {
        serverName: target.serverName,
        normalizedServerName: target.normalizedServerName,
        source: target.source,
        databaseId,
        sourceRevision,
        resolvedConfigDigest: target.resolvedConfigDigest,
        serverRevision,
        linkedAgentIds,
        directAccess,
        agentAccess,
        authorizationRevision,
        credentialFields: credential.fields,
        credentialRevision: credential.revision,
        requiresOAuth: target.requiresOAuth,
        oauthGrantGeneration: oauth.generation,
        oauthRevision: oauth.revision,
        effectivePolicyDigest,
      };
      return {
        ...proofWithoutRevision,
        revision: digestMCPAuthorityValue(proofWithoutRevision),
      };
    });
    const proofWithoutRevision = {
      version: MCP_AUTHORITY_PROOF_VERSION,
      shared,
      servers: serverProofs,
    };
    return deepFreeze({
      ...proofWithoutRevision,
      revision: digestMCPAuthorityValue(proofWithoutRevision),
    });
  }

  async function loadAuthoritativeSnapshot(
    userId: string,
    tenantId: string | undefined,
    boot: MCPAuthorityBootRevision,
    targets: readonly PreparedTarget[],
    suppliedSession?: ClientSession,
  ): Promise<MCPAuthorityProofV1> {
    if ((getTenantId() ?? null) !== (tenantId ?? null)) {
      reject('proof_unavailable', 'MCP authority tenant context does not match its principal');
    }
    if (suppliedSession?.inTransaction()) {
      reject('proof_unavailable', 'MCP authority reads cannot use a caller transaction snapshot');
    }
    await ensureSnapshotNamespaces();
    const session = suppliedSession ?? (await mongoose.startSession());
    const ownsSession = suppliedSession == null;
    try {
      session.startTransaction({
        readPreference: 'primary',
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      });
      const proof = await loadCurrentProof(userId, tenantId, boot, targets, session);
      await session.commitTransaction();
      return proof;
    } catch (error) {
      if (session.inTransaction()) {
        try {
          await session.abortTransaction();
        } catch {
          /** The authoritative read already failed closed. */
        }
      }
      throw error;
    } finally {
      if (ownsSession) {
        await session.endSession();
      }
    }
  }

  async function resolveMCPAuthorityProof(
    input: MCPAuthorityResolveInput,
  ): Promise<MCPAuthorityProofV1> {
    try {
      const targets = prepareTargets(input.targets);
      return await loadAuthoritativeSnapshot(
        input.userId,
        input.tenantId,
        input.boot,
        targets,
        input.session,
      );
    } catch (error) {
      throw asMCPError(error);
    }
  }

  function assertionTargets(proofs: readonly MCPAuthorityProofV1[]): readonly PreparedTarget[] {
    const targets = new Map<string, PreparedTarget & { revision: string }>();
    const normalizedTargets = new Map<string, string>();
    for (const proof of proofs) {
      for (const server of proof.servers) {
        const current = targets.get(server.serverName);
        if (current && current.revision !== server.revision) {
          reject('malformed_input', 'MCP authority proofs disagree about a selected server');
        }
        const normalizedTarget = normalizedTargets.get(server.normalizedServerName);
        if (normalizedTarget && normalizedTarget !== server.serverName) {
          reject('malformed_input', 'MCP authority proofs contain ambiguous server identities');
        }
        normalizedTargets.set(server.normalizedServerName, server.serverName);
        targets.set(server.serverName, {
          serverName: server.serverName,
          normalizedServerName: server.normalizedServerName,
          source: server.source,
          databaseId: server.databaseId,
          sourceRevision: server.sourceRevision,
          expectedCredentialRevision: server.credentialRevision,
          expectedOAuthGrantGeneration: server.oauthGrantGeneration,
          resolvedConfigDigest: server.resolvedConfigDigest,
          credentialFields: server.credentialFields,
          requiresOAuth: server.requiresOAuth,
          revision: server.revision,
        });
      }
    }
    const prepared = [...targets.values()]
      .map(({ revision: _revision, ...target }) => target)
      .sort((left, right) => left.serverName.localeCompare(right.serverName));
    assertPreparedTargetBounds(prepared);
    return prepared;
  }

  function assertSameSharedProofs(proofs: readonly MCPAuthorityProofV1[]): void {
    const first = proofs[0];
    for (let index = 1; index < proofs.length; index++) {
      const proof = proofs[index];
      if (
        proof.shared.revision !== first.shared.revision ||
        proof.shared.user.userId !== first.shared.user.userId ||
        proof.shared.user.tenantId !== first.shared.user.tenantId
      ) {
        reject('malformed_input', 'MCP authority proofs do not share one principal snapshot');
      }
    }
  }

  function compareProofs(
    expectedProofs: readonly MCPAuthorityProofV1[],
    current: MCPAuthorityProofV1,
  ): void {
    const expectedShared = expectedProofs[0].shared;
    if (current.shared.user.revision !== expectedShared.user.revision) {
      reject('principal_changed', 'MCP authority principal identity changed');
    }
    if (current.shared.groupsRevision !== expectedShared.groupsRevision) {
      reject('groups_changed', 'MCP authority group membership changed');
    }
    if (current.shared.configsRevision !== expectedShared.configsRevision) {
      reject('config_changed', 'MCP authority configuration changed');
    }
    if (!current.shared.role.use) {
      reject('mcp_use_revoked', 'MCP server use permission was revoked');
    }
    if (current.shared.role.revision !== expectedShared.role.revision) {
      reject('role_changed', 'MCP authority role changed');
    }
    if (current.shared.revision !== expectedShared.revision) {
      reject('principal_changed', 'MCP authority shared snapshot changed');
    }
    const expectedServers = new Map(
      expectedProofs.flatMap((proof) => proof.servers).map((server) => [server.serverName, server]),
    );
    for (const server of current.servers) {
      const expected = expectedServers.get(server.serverName);
      if (!expected) {
        reject('malformed_input', 'MCP authority assertion contains an unexpected server');
      }
      if (
        server.normalizedServerName !== expected.normalizedServerName ||
        server.source !== expected.source ||
        server.databaseId !== expected.databaseId ||
        server.sourceRevision !== expected.sourceRevision ||
        server.serverRevision !== expected.serverRevision ||
        server.resolvedConfigDigest !== expected.resolvedConfigDigest
      ) {
        reject('server_changed', 'Selected MCP server configuration changed', server.serverName);
      }
      if (server.source === 'database' && !server.directAccess && !server.agentAccess) {
        reject('access_revoked', 'Selected MCP server access was revoked', server.serverName);
      }
      if (server.authorizationRevision !== expected.authorizationRevision) {
        reject(
          'authorization_changed',
          'Selected MCP server authorization changed',
          server.serverName,
        );
      }
      if (server.credentialRevision !== expected.credentialRevision) {
        reject('credential_changed', 'Selected MCP credential changed', server.serverName);
      }
      if (server.oauthRevision !== expected.oauthRevision) {
        reject('oauth_grant_changed', 'Selected MCP OAuth grant changed', server.serverName);
      }
      if (server.effectivePolicyDigest !== expected.effectivePolicyDigest) {
        reject('server_changed', 'Selected MCP effective policy changed', server.serverName);
      }
      if (server.revision !== expected.revision) {
        reject('server_changed', 'Selected MCP authority proof changed', server.serverName);
      }
    }
  }

  async function assertMCPAuthorityProofsCurrent(input: MCPAuthorityAssertInput): Promise<void> {
    try {
      const proofs = Array.isArray(input.proofs) ? input.proofs : [input.proofs];
      if (proofs.length === 0 || proofs.length > MAX_MCP_AUTHORITY_TARGETS) {
        reject('malformed_input', 'MCP authority proof composition exceeds its bounded shape');
      }
      proofs.forEach(assertProofIntegrity);
      assertSameSharedProofs(proofs);
      const expectedShared = proofs[0].shared;
      if (
        expectedShared.boot.revision !== input.boot.revision ||
        expectedShared.boot.digest !== input.boot.digest
      ) {
        reject('boot_revision_changed', 'Immutable MCP boot configuration changed');
      }
      const targets = assertionTargets(proofs);
      const current = await loadAuthoritativeSnapshot(
        expectedShared.user.userId,
        expectedShared.user.tenantId ?? undefined,
        input.boot,
        targets,
        input.session,
      );
      compareProofs(proofs, current);
    } catch (error) {
      throw asMCPError(error);
    }
  }

  return {
    resolveMCPAuthorityProof,
    assertMCPAuthorityProofsCurrent,
  };
}

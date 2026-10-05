import { createHmac } from 'node:crypto';
import { logger, getTenantId, isRuntimeDisabled } from '@librechat/data-schemas';
import { Constants, Permissions, PermissionTypes } from 'librechat-data-provider';
import type {
  IUser,
  TokenMethods,
  AppConfig,
  ScheduledOboGrantMethods,
  PluginAuthMethods,
} from '@librechat/data-schemas';
import type { Response } from 'express';
import type { MCPOAuthTokens, OAuthClientInformation } from '../mcp/oauth/types';
import type { ScheduledTokenContext, ScheduleWritePreflight } from './context';
import type { SessionOpenIDTokens } from '../auth/openid/types';
import type { HostUpstreamTokenProviderResolver } from './mcp';
import type { UpstreamTokenTarget } from '../mcp/oauth/obo';
import type { MCPTokenStorage } from '../mcp/oauth/tokens';
import type { GetAppConfigOptions } from '../app/service';
import type { ScheduledOboScopeBinding } from './scopes';
import type { FlowStateManager } from '../flow/manager';
import type { ParsedServerConfig } from '../mcp/types';
import type { ScheduleMCPPreflight } from './types';
import type { ServerRequest } from '../types/http';
import {
  getJwtAccessTokenExpiry,
  getMCPOAuthLeaseId,
  getMCPOAuthTokenIdentifier,
  MCPTokenRefreshUnavailableError,
  ReauthenticationRequiredError,
} from '../mcp/oauth/tokens';
import {
  hasScheduledOboScopeBinding,
  readScheduledOboScopeBinding,
  resolveScheduledOboScopes,
} from './scopes';
import { OboTokenResolutionError, isRetryableOboExchangeError } from '../mcp/oauth/obo';
import { getAppConfigOptionsFromUser } from '../app/service';
import { getSafeErrorMetadata } from '../utils/errors';
import { resolveScheduledOboServer } from './target';
import { checkAccess } from '../middleware/access';
import { getPluginAuthMap } from '../agents/auth';
import { isEnabled } from '../utils/common';
import { ScheduleMCPError } from './mcp';

interface ScheduleGrantRow {
  id: string;
  user: string | { toString(): string };
  tenantId?: string;
  agent_id: string;
  enabled: boolean;
  configRevision?: number;
}
interface OpenIdConfig {
  clientMetadata: () => { client_id?: string };
  serverMetadata: () => {
    issuer?: string;
    token_endpoint?: string;
    authorization_endpoint?: string;
  };
}
interface GrantProvider {
  clientId: string;
  issuer: string;
  tokenEndpoint: string;
  authorizationEndpoint: string;
  exchange: (assertion: string, scopes: string) => Promise<GrantResponse>;
  refresh: (refreshToken: string, scopes: string, signal?: AbortSignal) => Promise<GrantResponse>;
}
interface GrantResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  scope?: string;
}
interface ScheduledOboClientInfo extends OAuthClientInformation {
  scheduled_obo_scope_binding?: ScheduledOboScopeBinding;
}
interface GrantDeps {
  /** Replica-stable host key; never included in preview responses. */
  previewKey?: string;
  /** Current agent/resource consent (including absolute expiry) and read-only
   * invocation policy. Absent in the default host until its authority gate ships. */
  authorizeInvocation?: (
    user: IUser,
    context: ScheduledTokenContext,
    target: UpstreamTokenTarget,
  ) => Promise<boolean>;
  tokens: Pick<TokenMethods, 'findToken' | 'createToken' | 'updateToken' | 'deleteTokens'> &
    ScheduledOboGrantMethods;
  tokenStorage: Pick<
    typeof MCPTokenStorage,
    | 'getClientInfoAndMetadata'
    | 'getTokens'
    | 'forceRefreshTokens'
    | 'storeTokens'
    | 'beginRefreshTeardown'
    | 'deleteUserTokens'
  >;
  flowManager: Pick<FlowStateManager<MCPOAuthTokens | null>, 'getLeaseGeneration' | 'acquireLease'>;
  getUser: (id: string) => Promise<IUser | null>;
  getSchedule: (id: string, userId: string) => Promise<ScheduleGrantRow | null>;
  getAppConfig: (options: GetAppConfigOptions) => Promise<AppConfig | undefined>;
  ensureConfigServers: (
    config: NonNullable<AppConfig['mcpConfig']>,
  ) => Promise<Record<string, ParsedServerConfig>>;
  getServerConfigs: (
    userId: string,
    config: Record<string, ParsedServerConfig>,
    role?: string,
  ) => Promise<Record<string, ParsedServerConfig>>;
  findPluginAuthsByKeys: PluginAuthMethods['findPluginAuthsByKeys'];
  getRoleByName: Parameters<typeof checkAccess>[0]['getRoleByName'];
  agentAccess: (agentId: string, user: IUser) => Promise<'ok' | 'missing' | 'forbidden'>;
  getOpenIdConfig: () => OpenIdConfig | null;
  requestGrant: (
    config: OpenIdConfig,
    grantType: string,
    parameters: Record<string, string>,
    signal?: AbortSignal,
  ) => Promise<GrantResponse>;
  inspect?: (
    agentId: string,
    user: IUser,
    scheduleId: string,
    serverName: string,
    onSelected: (config: ParsedServerConfig) => Promise<void>,
  ) => Promise<void>;
  isOwnerActive: (id: string) => Promise<boolean>;
  pauseSchedule: (
    scheduleId: string,
    userId: string,
    revision?: number,
  ) => Promise<ScheduleGrantRow | null>;
  isOboConfigTrusted: (config: ParsedServerConfig) => Promise<boolean>;
  isLiveAccessTokenValid: (tokens: SessionOpenIDTokens) => boolean;
}

/** Distinct namespace from direct MCP OAuth. Neither a login refresh token nor
 * another schedule's downstream grant can satisfy this credential lookup. */
export const scheduledOboGrantKey = (scheduleId: string, serverName: string): string =>
  `schedule-obo:${scheduleId}:${serverName}`;

const scheduleGrantLeaseId = (userId: string, scheduleId: string): string =>
  JSON.stringify(['scheduled-obo', getTenantId() ?? '', userId, scheduleId]);

const ownerGrantLeaseId = (userId: string): string =>
  JSON.stringify(['scheduled-obo-owner', getTenantId() ?? '', userId]);

function missingGrant(): OboTokenResolutionError {
  return new OboTokenResolutionError(
    'missing_upstream_provider',
    'Authorize this OBO server separately for this schedule before unattended use.',
  );
}

function expiresInSeconds(tokens: GrantResponse): number {
  let value = tokens.expires_in;
  if (value == null) {
    const jwtExpiry = getJwtAccessTokenExpiry(tokens.access_token);
    value = jwtExpiry == null ? undefined : Math.floor((jwtExpiry - Date.now()) / 1000);
  }
  if (!Number.isSafeInteger(value) || value == null || value <= 30) {
    throw new MCPTokenRefreshUnavailableError('schedule-obo', new Error('No usable token expiry'));
  }
  return value;
}

function metadata(record: { metadata?: Map<string, unknown> }): Record<string, unknown> {
  return record.metadata instanceof Map
    ? Object.fromEntries(record.metadata)
    : (record.metadata ?? {});
}

export interface ScheduledOboGrantService {
  /** Availability is not authorization: the installed authority is checked per use. */
  isAvailable: () => boolean;
  resolve: HostUpstreamTokenProviderResolver;
  enroll: (
    userId: string,
    scheduleId: string,
    serverName: string,
    accessToken: string,
    expectedScopes?: string,
    expectedBinding?: string,
  ) => Promise<void>;
  revoke: (userId: string, scheduleId: string, serverName: string) => Promise<void>;
  listEnrolled: (userId: string) => Promise<Record<string, string[]>>;
  /** Called after the durable account-deletion barrier, before the token sweep. */
  drainOwnerWrites: (userId: string) => Promise<void>;
  enrollFromRequest: (req: ServerRequest, res: Response) => Promise<void>;
  describeFromRequest: (req: ServerRequest, res: Response) => Promise<void>;
  revokeFromRequest: (req: ServerRequest, res: Response) => Promise<void>;
  purge: <T>(
    userId: string,
    scheduleId: string,
    afterPurge?: () => Promise<T>,
  ) => Promise<T | undefined>;
  setInspector: (preflight: ScheduleMCPPreflight) => void;
}

export function createScheduledOboGrantService(deps: GrantDeps): ScheduledOboGrantService {
  const { tokens } = deps;
  const isAvailable = (): boolean => deps.authorizeInvocation != null && !!deps.previewKey;
  const previewBinding = (
    userId: string,
    schedule: ScheduleGrantRow,
    serverName: string,
    url: string,
    scopes: string,
  ): string => {
    if (!deps.previewKey) throw missingGrant();
    return createHmac('sha256', deps.previewKey)
      .update(
        JSON.stringify([
          'scheduled-obo-preview-v1',
          userId,
          schedule.tenantId ?? '',
          schedule.id,
          schedule.agent_id,
          schedule.configRevision,
          serverName,
          url,
          scopes,
        ]),
      )
      .digest('hex');
  };
  const assertInvocationAuthorized = async (
    user: IUser,
    context: ScheduledTokenContext,
    target: UpstreamTokenTarget,
  ): Promise<void> => {
    let authorized: boolean | undefined;
    try {
      authorized = await deps.authorizeInvocation?.(user, context, target);
    } catch (error) {
      throw new OboTokenResolutionError(
        'session_refresh_failed',
        'Temporary scheduled MCP authority failure.',
        true,
        error,
      );
    }
    if (authorized !== true) throw missingGrant();
  };
  const withOwnerPersistence =
    (userId: string, generation: number | null) =>
    async (persist: () => Promise<MCPOAuthTokens>): Promise<MCPOAuthTokens> => {
      if (generation == null) throw new ReauthenticationRequiredError('schedule-obo', 'expired');
      const lease = await deps.flowManager.acquireLease(ownerGrantLeaseId(userId), {
        expectedGeneration: generation,
      });
      if (!lease)
        throw new MCPTokenRefreshUnavailableError(
          'schedule-obo',
          new Error('Owner grant fence changed'),
        );
      try {
        if (!(await deps.isOwnerActive(userId)))
          throw new ReauthenticationRequiredError('schedule-obo', 'expired');
        return await persist();
      } finally {
        await lease.release();
      }
    };
  const drainOwnerWrites = async (userId: string): Promise<void> => {
    const lease = await deps.flowManager.acquireLease(ownerGrantLeaseId(userId), {
      advanceGeneration: true,
    });
    if (!lease) throw new Error('Could not drain scheduled OBO credential writes');
    await lease.release();
  };
  let inspect = deps.inspect;
  const setInspector = (preflight: ScheduleMCPPreflight): void => {
    inspect = async (agentId, user, scheduleId, serverName, onSelected) => {
      await preflight(agentId, user, {
        scheduleId,
        concurrency: 3,
        inspectOboTarget: { serverName, onSelected },
      });
    };
  };
  const inspectTarget: NonNullable<GrantDeps['inspect']> = async (...args) => {
    if (!inspect) throw new Error('Scheduled OBO inspector is not installed');
    return inspect(...args);
  };

  const getPolicy = async (user: IUser) => {
    const [app, base] = await Promise.all([
      deps.getAppConfig({ ...getAppConfigOptionsFromUser(user), failClosed: true }),
      deps.getAppConfig({ baseOnly: true, failClosed: true }),
    ]);
    const policy = app?.interfaceConfig?.schedules;
    const active =
      base != null &&
      !isRuntimeDisabled(base.interfaceConfig?.schedules) &&
      !isEnabled(process.env.SCHEDULES_DISABLED) &&
      policy != null &&
      policy !== false &&
      (policy === true || policy.use !== false);
    return {
      enabled: active,
      oboServers: policy && typeof policy === 'object' ? policy.oboServers : undefined,
    };
  };
  const getProvider = (): GrantProvider | null => {
    const config = deps.getOpenIdConfig();
    if (!config) return null;
    const issuer = config.serverMetadata();
    const clientId = config.clientMetadata().client_id;
    if (!clientId || !issuer.issuer || !issuer.token_endpoint || !issuer.authorization_endpoint)
      return null;
    return {
      clientId,
      issuer: issuer.issuer,
      tokenEndpoint: issuer.token_endpoint,
      authorizationEndpoint: issuer.authorization_endpoint,
      exchange: (assertion, scopes) =>
        deps.requestGrant(config, 'urn:ietf:params:oauth:grant-type:jwt-bearer', {
          scope: scopes,
          assertion,
          requested_token_use: 'on_behalf_of',
        }),
      refresh: (refreshToken, scopes, signal) =>
        deps.requestGrant(
          config,
          'refresh_token',
          { refresh_token: refreshToken, scope: scopes },
          signal,
        ),
    };
  };

  const getServer = async (user: IUser, name: string, preview = false) => {
    const appConfig = await deps.getAppConfig({
      ...getAppConfigOptionsFromUser(user),
      failClosed: true,
    });
    if (!appConfig) throw new Error('Principal MCP configuration is unavailable');
    const raw = appConfig.mcpConfig?.[name];
    const parsed = raw ? await deps.ensureConfigServers({ [name]: raw }) : {};
    const server = (await deps.getServerConfigs(user.id, parsed, user.role))[name];
    if (!server) return undefined;
    if (!server.customUserVars && !server.url?.includes('{{'))
      return resolveScheduledOboServer(server, user, undefined, preview);
    const key = `${Constants.mcp_prefix}${name}`;
    const auth = await getPluginAuthMap({
      userId: user.id,
      pluginKeys: [key],
      findPluginAuthsByKeys: deps.findPluginAuthsByKeys,
    });
    return resolveScheduledOboServer(server, user, auth[key], preview);
  };

  const validate = async (
    userId: string,
    context: ScheduledTokenContext,
    target: UpstreamTokenTarget,
    allowDisabled = false,
    writePreflight?: ScheduleWritePreflight,
    preview = false,
  ) => {
    if (!isAvailable() || context.ownerId !== userId || context.invocationMode !== 'delegated')
      throw missingGrant();
    const [user, schedule, ownerActive] = await Promise.all([
      deps.getUser(userId),
      deps.getSchedule(context.scheduleId, userId),
      deps.isOwnerActive(userId),
    ]);
    if (
      !ownerActive ||
      !user ||
      !schedule ||
      String(schedule.user) !== userId ||
      user.tenantId !== context.tenantId ||
      schedule.tenantId !== context.tenantId ||
      (writePreflight
        ? schedule.agent_id !== writePreflight.agentId ||
          schedule.configRevision !== writePreflight.configRevision
        : schedule.agent_id !== context.agentId) ||
      (!allowDisabled && context.manual !== true && !schedule.enabled) ||
      !user.openidId ||
      !user.openidIssuer
    )
      throw missingGrant();
    if (user.id && user.id !== userId) throw missingGrant();
    user.id = userId;
    const roleLookup = user.role ? deps.getRoleByName(user.role) : Promise.resolve(null);
    const getRoleByName: typeof deps.getRoleByName = () => roleLookup;
    const [limits, mcpAccess, scheduleAccess, agentAccess, rootAccess, config] = await Promise.all([
      getPolicy(user),
      checkAccess({
        user,
        permissionType: PermissionTypes.MCP_SERVERS,
        permissions: [Permissions.USE],
        getRoleByName,
      }),
      checkAccess({
        user,
        permissionType: PermissionTypes.SCHEDULES,
        permissions: [Permissions.USE],
        getRoleByName,
      }),
      checkAccess({
        user,
        permissionType: PermissionTypes.AGENTS,
        permissions: [Permissions.USE],
        getRoleByName,
      }),
      deps.agentAccess(context.agentId, user),
      getServer(user, target.mcpServer, preview),
    ]);
    if (
      !limits.enabled ||
      !limits.oboServers?.includes(target.mcpServer) ||
      !mcpAccess ||
      !scheduleAccess ||
      !agentAccess ||
      rootAccess !== 'ok' ||
      !config?.obo?.scopes ||
      config.obo.scopes !== target.scopes ||
      config.source === 'user' ||
      (config.dbId && config.source !== 'config') ||
      !(await deps.isOboConfigTrusted(config))
    )
      throw missingGrant();
    const provider = getProvider();
    if (
      !provider?.clientId ||
      !provider.issuer ||
      !provider.tokenEndpoint ||
      !provider.authorizationEndpoint
    )
      throw missingGrant();
    await assertInvocationAuthorized(user, context, { ...target, url: config.url });
    return { user, schedule, config, provider };
  };

  const resourceBinding = (url: string): string =>
    `urn:librechat:scheduled-obo-url:${createHmac('sha256', deps.previewKey!)
      .update('scheduled-obo-resource-url-v1\0')
      .update(url)
      .digest('hex')}`;

  const credentialBinding = (authorized: Awaited<ReturnType<typeof validate>>): string =>
    JSON.stringify([
      authorized.user.openidId,
      authorized.user.openidIssuer,
      authorized.user.tenantId ?? '',
      authorized.config.url,
      authorized.config.obo?.scopes,
      authorized.provider.clientId,
      authorized.provider.issuer,
      authorized.provider.tokenEndpoint,
      authorized.provider.authorizationEndpoint,
    ]);

  const read = async (
    userId: string,
    context: ScheduledTokenContext,
    target: UpstreamTokenTarget,
    forceRefresh = false,
    activationPreflight = false,
    writePreflight?: ScheduleWritePreflight,
  ): Promise<MCPOAuthTokens> => {
    if (!target.url) throw missingGrant();
    const authorizeRead = async (): Promise<Awaited<ReturnType<typeof validate>>> => {
      try {
        return await validate(userId, context, target, activationPreflight, writePreflight);
      } catch (error) {
        if (error instanceof OboTokenResolutionError) throw error;
        throw new OboTokenResolutionError(
          'session_refresh_failed',
          'Temporary scheduled OBO authorization failure.',
          true,
          error,
        );
      }
    };
    const authorized = await authorizeRead();
    const binding = credentialBinding(authorized);
    const { user, config, provider } = authorized;
    if (config.url !== target.url) throw missingGrant();
    const key = scheduledOboGrantKey(context.scheduleId, target.mcpServer);
    const identifier = getMCPOAuthTokenIdentifier(key, true);
    const boundUrl = resourceBinding(target.url);
    const assertMetadata = (binding: Record<string, unknown>): void => {
      if (
        binding.server_url !== boundUrl ||
        binding.issuer !== provider.issuer ||
        binding.token_endpoint !== provider.tokenEndpoint ||
        binding.openid_subject !== user.openidId ||
        binding.openid_issuer !== user.openidIssuer ||
        binding.tenant_id !== (user.tenantId ?? '')
      )
        throw missingGrant();
    };
    const boundFindToken: TokenMethods['findToken'] = async (...args) => {
      const record = await tokens.findToken(...args);
      if (record && args[0].type === 'mcp_oauth_client') assertMetadata(metadata(record));
      return record;
    };
    // Hold only the persistence fence, never the network refresh flight. All writers
    // of this namespace use it, so the two rows form one coherent observation.
    const snapshot = async (expectedGeneration?: string): Promise<string> => {
      const lease = await deps.flowManager.acquireLease(
        getMCPOAuthLeaseId(userId, key, undefined, true),
      );
      if (!lease)
        throw new MCPTokenRefreshUnavailableError(
          key,
          new Error('Grant snapshot fence unavailable'),
        );
      try {
        const [refresh, client] = await Promise.all([
          tokens.findToken({
            userId,
            type: 'mcp_oauth_refresh',
            identifier: `${identifier}:refresh`,
          }),
          deps.tokenStorage.getClientInfoAndMetadata({
            userId,
            serverName: key,
            scheduledGrant: true as const,
            findToken: boundFindToken,
          }),
        ]);
        const generation = refresh && metadata(refresh).credential_set_id;
        if (
          !refresh ||
          !client ||
          typeof generation !== 'string' ||
          !generation ||
          refresh.expiresAt <= new Date() ||
          client.clientInfo.client_id !== provider.clientId ||
          (client.clientInfo as typeof client.clientInfo & { scope?: string }).scope !==
            `${target.scopes} offline_access`
        )
          throw missingGrant();
        const info: ScheduledOboClientInfo = client.clientInfo;
        if (
          !hasScheduledOboScopeBinding(
            target.scopes,
            provider,
            readScheduledOboScopeBinding(info.scheduled_obo_scope_binding),
          )
        )
          throw missingGrant();
        assertMetadata(client.clientMetadata);
        if (
          generation !== client.clientMetadata.credential_set_id ||
          (expectedGeneration != null && generation !== expectedGeneration)
        )
          throw new MCPTokenRefreshUnavailableError(
            key,
            new Error('Credential generation changed during read'),
          );
        return generation;
      } finally {
        await lease.release();
      }
    };
    let generation: string;
    let ownerGeneration: number | null;
    try {
      [generation, ownerGeneration] = await Promise.all([
        snapshot(),
        deps.flowManager.getLeaseGeneration(ownerGrantLeaseId(userId)),
      ]);
    } catch (error) {
      if (error instanceof OboTokenResolutionError) throw error;
      throw new OboTokenResolutionError(
        'session_refresh_failed',
        'Temporary scheduled OBO credential-store failure.',
        true,
        error,
      );
    }
    const refreshTokens: NonNullable<
      Parameters<typeof deps.tokenStorage.getTokens>[0]['refreshTokens']
    > = async (secret, stored, signal) => {
      if (
        !stored.credentialSetId ||
        stored.storedServerUrl !== boundUrl ||
        stored.storedTokenEndpoint !== provider.tokenEndpoint ||
        stored.clientInfo?.client_id !== provider.clientId ||
        (stored.clientInfo as typeof stored.clientInfo & { scope?: string })?.scope !==
          `${target.scopes} offline_access`
      )
        throw new ReauthenticationRequiredError(key, 'binding');
      const rejectRenewal = async (reason: 'expired' | 'invalid_client'): Promise<never> => {
        const lease = await deps.flowManager.acquireLease(
          getMCPOAuthLeaseId(userId, key, undefined, true),
        );
        if (!lease)
          throw new MCPTokenRefreshUnavailableError(
            key,
            new Error('Grant retirement fence unavailable'),
          );
        try {
          const current = await tokens.findToken({
            userId,
            type: 'mcp_oauth_refresh',
            identifier: `${identifier}:refresh`,
          });
          if (current && metadata(current).credential_set_id !== stored.credentialSetId)
            throw new MCPTokenRefreshUnavailableError(
              key,
              new Error('Failed renewal was superseded'),
            );
          const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          await tokens.deleteTokens({
            userId,
            identifier: new RegExp(`^${escaped}(?::refresh|:client)?$`),
            metadataCredentialSetId: stored.credentialSetId,
          });
          throw new ReauthenticationRequiredError(key, reason);
        } finally {
          await lease.release();
        }
      };
      let next: GrantResponse;
      try {
        next = await provider.refresh(secret, target.scopes, signal);
      } catch (error) {
        signal?.throwIfAborted();
        if (isRetryableOboExchangeError(error))
          throw new MCPTokenRefreshUnavailableError(key, error);
        const code =
          error && typeof error === 'object' && 'error' in error ? error.error : undefined;
        if (
          typeof code === 'string' &&
          [
            'invalid_grant',
            'invalid_client',
            'unauthorized_client',
            'unsupported_grant_type',
            'invalid_request',
            'invalid_scope',
            'invalid_target',
            'access_denied',
          ].includes(code)
        )
          return rejectRenewal(code === 'invalid_client' ? 'invalid_client' : 'expired');
        throw error;
      }
      signal?.throwIfAborted();
      const info: ScheduledOboClientInfo | undefined = stored.clientInfo;
      const consent = resolveScheduledOboScopes(
        next,
        target.scopes,
        provider,
        readScheduledOboScopeBinding(info?.scheduled_obo_scope_binding),
      );
      let expiresIn: number;
      try {
        if (!next.access_token || !consent.ok)
          throw new ReauthenticationRequiredError(key, 'expired');
        expiresIn = expiresInSeconds(next);
      } catch {
        // A received response may have consumed the refresh token. Retire only
        // its generation; a new owner enrollment is a transient supersession,
        // not evidence that the schedule has lost unattended authorization.
        return rejectRenewal('expired');
      }
      return {
        access_token: next.access_token,
        ...(next.refresh_token ? { refresh_token: next.refresh_token } : {}),
        ...(next.refresh_token && next.refresh_token_expires_in != null
          ? { refresh_token_expires_in: next.refresh_token_expires_in }
          : {}),
        token_type: 'Bearer',
        obtained_at: Date.now(),
        expires_at: Date.now() + expiresIn * 1000,
      };
    };
    let result: MCPOAuthTokens | null;
    try {
      const params = {
        userId,
        serverName: key,
        scheduledGrant: true as const,
        findToken: boundFindToken,
        createToken: tokens.createToken,
        updateToken: tokens.updateToken,
        deleteTokens: tokens.deleteTokens,
        flowManager: deps.flowManager,
        coordinateRefresh: true,
        rejectedCredentialSetId: generation,
        singleFlightScope: JSON.stringify([
          target.url,
          target.scopes,
          user.openidId,
          user.openidIssuer,
          provider.clientId,
        ]),
        withPersistence: withOwnerPersistence(userId, ownerGeneration),
        refreshTokens,
      };
      result = forceRefresh
        ? await deps.tokenStorage.forceRefreshTokens(params)
        : await deps.tokenStorage.getTokens(params);
      if (result?.expires_at && result.expires_at - Date.now() < 45_000 && !forceRefresh) {
        result = await deps.tokenStorage.forceRefreshTokens(params);
      }
      if (!result?.access_token || !result.expires_at || result.expires_at <= Date.now())
        throw missingGrant();
      if (!result.credential_set_id) throw missingGrant();
    } catch (error) {
      if (
        (error instanceof ReauthenticationRequiredError && error.reason !== 'binding') ||
        (error instanceof OboTokenResolutionError && !error.retryable)
      ) {
        try {
          await snapshot(generation);
        } catch (current) {
          if (current instanceof OboTokenResolutionError) throw current;
          throw new OboTokenResolutionError(
            'session_refresh_failed',
            'Scheduled OBO authorization changed during renewal.',
            true,
          );
        }
        throw missingGrant();
      }
      if (
        error instanceof MCPTokenRefreshUnavailableError ||
        error instanceof ReauthenticationRequiredError
      ) {
        throw new OboTokenResolutionError(
          'session_refresh_failed',
          'Temporary OBO grant refresh failure.',
          true,
        );
      }
      if (error instanceof OboTokenResolutionError) throw error;
      logger.warn('[schedules] scheduled OBO credential read failed', getSafeErrorMetadata(error));
      throw new OboTokenResolutionError(
        'session_refresh_failed',
        'Temporary OBO credential failure.',
        true,
      );
    }
    if (credentialBinding(await authorizeRead()) !== binding) throw missingGrant();
    // No authority/provider I/O may follow the last teardown-fenced generation observation.
    try {
      await snapshot(result.credential_set_id);
    } catch (error) {
      if (error instanceof OboTokenResolutionError) throw error;
      throw new OboTokenResolutionError(
        'session_refresh_failed',
        'Temporary scheduled OBO credential-store failure.',
        true,
        error,
      );
    }
    return result;
  };

  const resolve: HostUpstreamTokenProviderResolver = async (
    user,
    { context, target, activationPreflight, writePreflight },
  ) => {
    if (!isAvailable() || !context || !target || user.id !== context.ownerId) return undefined;
    return async ({ forceRefresh, forceDownstreamRefresh } = {}) => {
      const result = await read(
        user.id,
        context,
        target,
        forceRefresh || forceDownstreamRefresh,
        activationPreflight,
        writePreflight,
      );
      return {
        scheduledObo: true,
        access_token: result.access_token,
        expires_at: Math.floor(result.expires_at! / 1000),
      };
    };
  };

  const enroll = async (
    userId: string,
    scheduleId: string,
    serverName: string,
    accessToken: string,
    expectedScopes?: string,
    expectedBinding?: string,
  ): Promise<void> => {
    if (!isAvailable()) throw missingGrant();
    const scheduleLease = scheduleGrantLeaseId(userId, scheduleId);
    const [scheduleGeneration, ownerGeneration] = await Promise.all([
      deps.flowManager.getLeaseGeneration(scheduleLease),
      deps.flowManager.getLeaseGeneration(ownerGrantLeaseId(userId)),
    ]);
    if (scheduleGeneration == null)
      throw new MCPTokenRefreshUnavailableError(
        scheduledOboGrantKey(scheduleId, serverName),
        new Error('Schedule grant teardown in progress'),
      );
    const [user, schedule] = await Promise.all([
      deps.getUser(userId),
      deps.getSchedule(scheduleId, userId),
    ]);
    if (
      !user ||
      !schedule ||
      String(schedule.user) !== userId ||
      (user.id && user.id !== userId) ||
      !user.openidId ||
      !accessToken
    )
      throw missingGrant();
    user.id = userId;
    const context: ScheduledTokenContext = {
      scheduleId,
      ownerId: userId,
      tenantId: user.tenantId,
      agentId: schedule.agent_id,
      invocationMode: 'delegated',
    };
    await inspectTarget(schedule.agent_id, user, scheduleId, serverName, async (selected) => {
      if (
        !selected.obo?.scopes ||
        (expectedScopes != null && selected.obo.scopes !== expectedScopes) ||
        (expectedBinding != null &&
          previewBinding(userId, schedule, serverName, selected.url!, selected.obo.scopes) !==
            expectedBinding)
      )
        throw missingGrant();
      const target = { mcpServer: serverName, scopes: selected.obo.scopes };
      const authorized = await validate(userId, context, target, true);
      const binding = credentialBinding(authorized);
      const { config, provider } = authorized;
      const key = scheduledOboGrantKey(scheduleId, serverName);
      const leaseId = getMCPOAuthLeaseId(userId, key, undefined, true);
      const generation = await deps.flowManager.getLeaseGeneration(leaseId);
      if (generation == null)
        throw new MCPTokenRefreshUnavailableError(key, new Error('Grant teardown in progress'));
      if (
        config.url !== selected.url ||
        config.obo?.scopes !== selected.obo.scopes ||
        (expectedBinding != null &&
          previewBinding(userId, schedule, serverName, config.url!, config.obo!.scopes) !==
            expectedBinding)
      )
        throw missingGrant();
      let response: GrantResponse;
      try {
        response = await provider.exchange(accessToken, `${target.scopes} offline_access`);
      } catch (error) {
        if (isRetryableOboExchangeError(error))
          throw new MCPTokenRefreshUnavailableError(key, error);
        throw missingGrant();
      }
      const consent = resolveScheduledOboScopes(response, target.scopes, provider);
      if (!response.access_token || !response.refresh_token || !consent.ok) throw missingGrant();
      let expiresIn: number;
      try {
        expiresIn = expiresInSeconds(response);
      } catch {
        throw missingGrant();
      }
      // The token was issued for the downstream MCP resource, not for LibreChat's
      // login session. Persist only this separately requested OBO refresh grant.
      const metadata = {
        issuer: provider.issuer,
        authorization_endpoint: provider.authorizationEndpoint,
        token_endpoint: provider.tokenEndpoint,
        server_url: resourceBinding(config.url!),
        client_source: 'configured' as const,
        openid_subject: user.openidId,
        openid_issuer: user.openidIssuer,
        tenant_id: user.tenantId ?? '',
      };
      const scheduleLock = await deps.flowManager.acquireLease(scheduleLease, {
        expectedGeneration: scheduleGeneration,
      });
      if (!scheduleLock)
        throw new MCPTokenRefreshUnavailableError(key, new Error('Schedule grant changed'));
      try {
        const lease = await deps.flowManager.acquireLease(leaseId, {
          expectedGeneration: generation,
        });
        if (!lease)
          throw new MCPTokenRefreshUnavailableError(key, new Error('Grant is being changed'));
        try {
          const current = await validate(userId, context, target, true);
          if (credentialBinding(current) !== binding) throw missingGrant();
          const fresh = current.schedule;
          if (
            !fresh ||
            fresh.configRevision !== schedule.configRevision ||
            fresh.agent_id !== schedule.agent_id ||
            fresh.tenantId !== user.tenantId
          )
            throw missingGrant();
          if (expectedBinding != null) {
            const currentServer = current.config;
            if (
              !currentServer?.url ||
              currentServer.obo?.scopes !== expectedScopes ||
              previewBinding(userId, fresh, serverName, currentServer.url, expectedScopes!) !==
                expectedBinding
            )
              throw missingGrant();
          }
          const clientInfo: ScheduledOboClientInfo = {
            client_id: provider.clientId,
            scope: `${target.scopes} offline_access`,
            ...(consent.binding && { scheduled_obo_scope_binding: consent.binding }),
          };
          await deps.tokenStorage.storeTokens({
            withPersistence: withOwnerPersistence(userId, ownerGeneration),
            userId,
            serverName: key,
            scheduledGrant: true as const,
            tokens: {
              access_token: response.access_token,
              refresh_token: response.refresh_token,
              token_type: 'Bearer',
              expires_in: expiresIn,
              ...(response.refresh_token_expires_in != null && {
                refresh_token_expires_in: response.refresh_token_expires_in,
              }),
            },
            clientInfo,
            metadata,
            createToken: tokens.createToken,
            findToken: tokens.findToken,
            updateToken: tokens.updateToken,
            deleteTokens: tokens.deleteTokens,
          });
        } finally {
          await lease.release();
        }
      } finally {
        await scheduleLock.release();
      }
    });
  };

  const legacyGrant = async (userId: string, key: string): Promise<string | undefined> => {
    const [client, refresh] = await Promise.all([
      tokens.findToken({ userId, type: 'mcp_oauth_client', identifier: `mcp:${key}:client` }),
      tokens.findToken({ userId, type: 'mcp_oauth_refresh', identifier: `mcp:${key}:refresh` }),
    ]);
    const binding = client && metadata(client);
    const generation = binding?.credential_set_id;
    const refreshBinding = refresh && metadata(refresh);
    if (
      refreshBinding?.credential_purpose === 'scheduled_obo' &&
      typeof refreshBinding.credential_set_id === 'string'
    )
      return refreshBinding.credential_set_id;
    if (
      typeof binding?.openid_subject === 'string' &&
      typeof binding.openid_issuer === 'string' &&
      typeof generation === 'string' &&
      refresh &&
      metadata(refresh).credential_set_id === generation
    )
      return generation;
  };

  const deleteLegacyGrant = async (
    userId: string,
    key: string,
    generation: string,
  ): Promise<void> => {
    const identifier = `mcp:${key}`;
    const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await tokens.deleteTokens({
      userId,
      identifier: new RegExp(`^${escaped}(?::refresh|:client)?$`),
      metadataCredentialSetId: generation,
    });
  };

  const revoke = async (userId: string, scheduleId: string, serverName: string) => {
    const schedule = await deps.getSchedule(scheduleId, userId);
    if (!schedule || String(schedule.user) !== userId) throw missingGrant();
    const key = scheduledOboGrantKey(scheduleId, serverName);
    const [refresh, legacyGeneration] = await Promise.all([
      tokens.findToken({
        userId,
        type: 'mcp_oauth_refresh',
        identifier: `${getMCPOAuthTokenIdentifier(key, true)}:refresh`,
      }),
      legacyGrant(userId, key),
    ]);
    if (!refresh && !legacyGeneration) throw missingGrant();
    const purposes: Array<true | undefined> = legacyGeneration ? [undefined, true] : [true];
    const releases: Array<() => void> = [];
    const leases: Array<{ release: () => Promise<void> }> = [];
    try {
      for (const purpose of purposes) {
        releases.push(await deps.tokenStorage.beginRefreshTeardown(userId, key, purpose));
        const leaseId = getMCPOAuthLeaseId(userId, key, undefined, purpose);
        const generation = await deps.flowManager.getLeaseGeneration(leaseId);
        if (generation == null)
          throw new MCPTokenRefreshUnavailableError(key, new Error('Grant teardown in progress'));
        const lease = await deps.flowManager.acquireLease(leaseId, {
          expectedGeneration: generation,
          advanceGeneration: true,
        });
        if (!lease)
          throw new MCPTokenRefreshUnavailableError(key, new Error('Grant is being changed'));
        leases.push(lease);
      }
      if (!(await deps.pauseSchedule(scheduleId, userId, schedule.configRevision)))
        throw new MCPTokenRefreshUnavailableError(
          key,
          new Error('Schedule changed during revocation'),
        );
      await deps.tokenStorage.deleteUserTokens({
        userId,
        serverName: key,
        scheduledGrant: true,
        deleteToken: async (filter) => {
          await tokens.deleteTokens(filter);
        },
      });
      if (legacyGeneration) {
        const currentGeneration = await legacyGrant(userId, key);
        if (currentGeneration) await deleteLegacyGrant(userId, key, currentGeneration);
      }
    } finally {
      try {
        await Promise.all(leases.reverse().map((lease) => lease.release()));
      } finally {
        for (const release of releases) release();
      }
    }
  };

  const listEnrolled = async (userId: string): Promise<Record<string, string[]>> => {
    const identifiers = await tokens.listScheduledOboGrantIdentifiers(userId);
    const grants: Record<string, string[]> = Object.create(null);
    const prefix = 'scheduled-mcp:schedule-obo:';
    const suffix = ':refresh';
    for (const identifier of identifiers) {
      const storedPrefix = identifier.startsWith(prefix) ? prefix : 'mcp:schedule-obo:';
      if (!identifier.startsWith(storedPrefix) || !identifier.endsWith(suffix)) continue;
      const name = identifier.slice(storedPrefix.length, -suffix.length);
      const separator = name.indexOf(':');
      if (separator < 1) continue;
      const scheduleId = name.slice(0, separator);
      const server = name.slice(separator + 1);
      if (server && !grants[scheduleId]?.includes(server)) (grants[scheduleId] ??= []).push(server);
    }
    return grants;
  };

  const enrollFromRequest = async (req: ServerRequest, res: Response): Promise<void> => {
    const userId = req.user?.id;
    const { id: scheduleId, server: serverName } = req.params as { id: string; server: string };
    const session = (
      req.session as (typeof req.session & { openidTokens?: SessionOpenIDTokens }) | undefined
    )?.openidTokens;
    let user: IUser | null = null;
    try {
      user = userId ? await deps.getUser(userId) : null;
    } catch {
      res.status(503).json({ error: 'Scheduled OBO authorization unavailable. Try again later.' });
      return;
    }
    if (
      !user ||
      !user.openidId ||
      !user.openidIssuer ||
      !session ||
      session.appUserId !== userId ||
      session.openidSubject !== user.openidId ||
      session.openidIssuer !== user.openidIssuer ||
      session.tenantId !== user.tenantId ||
      !session.accessToken ||
      !deps.isLiveAccessTokenValid(session)
    ) {
      res
        .status(401)
        .json({ error: 'Sign in with a live OpenID session to authorize scheduled OBO' });
      return;
    }
    try {
      const { expectedScopes, expectedBinding } = (req.body ?? {}) as {
        expectedScopes?: string;
        expectedBinding?: string;
      };
      if (
        typeof expectedScopes !== 'string' ||
        !expectedScopes ||
        expectedScopes.length > 2048 ||
        typeof expectedBinding !== 'string' ||
        !/^[a-f0-9]{64}$/.test(expectedBinding)
      ) {
        res
          .status(400)
          .json({ error: 'Confirm the current OBO endpoint and scopes before authorizing' });
        return;
      }
      await enroll(
        userId!,
        scheduleId,
        serverName,
        session.accessToken,
        expectedScopes,
        expectedBinding,
      );
      res.status(204).end();
    } catch (error) {
      if (
        (error instanceof OboTokenResolutionError && !error.retryable) ||
        (error instanceof ScheduleMCPError && error.code !== 'mcp_unavailable')
      ) {
        res.status(400).json({ error: 'This schedule or OBO server cannot be authorized offline' });
      } else {
        res
          .status(503)
          .json({ error: 'Scheduled OBO authorization unavailable. Try again later.' });
      }
    }
  };
  const describeFromRequest = async (req: ServerRequest, res: Response): Promise<void> => {
    const userId = req.user?.id;
    const { id: scheduleId, server: serverName } = req.params as { id: string; server: string };
    if (!userId) {
      res.status(401).end();
      return;
    }
    try {
      const [user, schedule] = await Promise.all([
        deps.getUser(userId),
        deps.getSchedule(scheduleId, userId),
      ]);
      if (!user || !schedule || String(schedule.user) !== userId) throw missingGrant();
      user.id = userId;
      await inspectTarget(schedule.agent_id, user, scheduleId, serverName, async (selected) => {
        if (!selected.obo?.scopes) throw missingGrant();
        const context: ScheduledTokenContext = {
          scheduleId,
          ownerId: userId,
          tenantId: user.tenantId,
          agentId: schedule.agent_id,
          invocationMode: 'delegated',
        };
        const target = { mcpServer: serverName, scopes: selected.obo.scopes };
        const { config } = await validate(userId, context, target, true, undefined, true);
        if (config.url !== selected.url || !config.displayUrl) throw missingGrant();
        res.json({
          server: serverName,
          scopes: target.scopes,
          url: config.displayUrl,
          binding: previewBinding(userId, schedule, serverName, config.url!, target.scopes),
        });
      });
    } catch (error) {
      if (
        (error instanceof OboTokenResolutionError && !error.retryable) ||
        (error instanceof ScheduleMCPError && error.code !== 'mcp_unavailable')
      ) {
        res.status(400).json({ error: 'This agent cannot authorize the requested OBO server' });
      } else {
        res.status(503).json({ error: 'Could not inspect scheduled OBO authorization' });
      }
    }
  };

  const revokeFromRequest = async (req: ServerRequest, res: Response): Promise<void> => {
    const userId = req.user?.id;
    const { id: scheduleId, server: serverName } = req.params as { id: string; server: string };
    if (!userId) {
      res.status(401).end();
      return;
    }
    try {
      await revoke(userId, scheduleId, serverName);
      res.status(204).end();
    } catch (error) {
      res
        .status(error instanceof OboTokenResolutionError && !error.retryable ? 400 : 503)
        .json({ error: 'Scheduled OBO grant could not be revoked. Try again.' });
    }
  };

  const purge = async <T>(
    userId: string,
    scheduleId: string,
    afterPurge?: () => Promise<T>,
  ): Promise<T | undefined> => {
    const leaseId = scheduleGrantLeaseId(userId, scheduleId);
    const generation = await deps.flowManager.getLeaseGeneration(leaseId);
    if (generation == null) throw new Error('Scheduled OBO grant cleanup is in progress');
    const lease = await deps.flowManager.acquireLease(leaseId, {
      expectedGeneration: generation,
      advanceGeneration: true,
    });
    if (!lease) throw new Error('Scheduled OBO grant cleanup is in progress');
    const releases: Array<() => void> = [];
    const grantLeases: Array<{ release: () => Promise<void> }> = [];
    try {
      const modernPrefix = `scheduled-mcp:schedule-obo:${scheduleId}:`;
      const legacyPrefix = `mcp:schedule-obo:${scheduleId}:`;
      const identifiers = [
        ...new Set(await tokens.listScheduledOboGrantIdentifiers(userId)),
      ].filter(
        (identifier) =>
          identifier.endsWith(':refresh') &&
          (identifier.startsWith(modernPrefix) || identifier.startsWith(legacyPrefix)),
      );
      // Keep redemption, persistence and rollback quiesced through schedule deletion.
      for (const identifier of identifiers) {
        const modern = identifier.startsWith(modernPrefix);
        const purpose = modern ? true : undefined;
        const key = identifier.slice(
          modern ? 'scheduled-mcp:'.length : 'mcp:'.length,
          -':refresh'.length,
        );
        releases.push(await deps.tokenStorage.beginRefreshTeardown(userId, key, purpose));
        const grantLease = await deps.flowManager.acquireLease(
          getMCPOAuthLeaseId(userId, key, undefined, purpose),
          { advanceGeneration: true },
        );
        if (!grantLease) throw new Error('Scheduled OBO grant cleanup is in progress');
        grantLeases.push(grantLease);
      }
      const escaped = scheduleId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      await tokens.deleteTokens({
        userId,
        identifier: new RegExp(`^scheduled-mcp:schedule-obo:${escaped}:`),
      });
      for (const identifier of identifiers) {
        if (!identifier.startsWith(legacyPrefix)) continue;
        const key = identifier.slice('mcp:'.length, -':refresh'.length);
        const generation = await legacyGrant(userId, key);
        if (generation) await deleteLegacyGrant(userId, key, generation);
      }
      return await afterPurge?.();
    } finally {
      try {
        await Promise.all(grantLeases.map((grantLease) => grantLease.release()));
      } finally {
        for (const release of releases) release();
        await lease.release();
      }
    }
  };

  return {
    isAvailable,
    resolve,
    enroll,
    revoke,
    listEnrolled,
    drainOwnerWrites,
    enrollFromRequest,
    describeFromRequest,
    revokeFromRequest,
    purge,
    setInspector,
  };
}

/** Keep the scheduled credential host out of ordinary API startup paths. Existing
 * Schedules/index uses the same lazily constructed service pattern. */
export function createLazyScheduledOboGrantService(
  factory: () => ScheduledOboGrantService,
): ScheduledOboGrantService {
  let instance: ScheduledOboGrantService | undefined;
  let inspector: ScheduleMCPPreflight | undefined;
  const get = (): ScheduledOboGrantService => {
    if (!instance) {
      instance = factory();
      if (inspector) instance.setInspector(inspector);
    }
    return instance;
  };
  return {
    isAvailable: () => get().isAvailable(),
    setInspector: (preflight) => {
      inspector = preflight;
      instance?.setInspector(preflight);
    },
    resolve: (...args) => get().resolve(...args),
    enroll: (...args) => get().enroll(...args),
    revoke: (...args) => get().revoke(...args),
    listEnrolled: (...args) => get().listEnrolled(...args),
    drainOwnerWrites: (...args) => get().drainOwnerWrites(...args),
    enrollFromRequest: (...args) => get().enrollFromRequest(...args),
    describeFromRequest: (...args) => get().describeFromRequest(...args),
    revokeFromRequest: (...args) => get().revokeFromRequest(...args),
    purge: (...args) => get().purge(...args),
  };
}

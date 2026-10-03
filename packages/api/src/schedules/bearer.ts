import {
  extractEnvVariable,
  scheduledMCPIdentitySchema,
  scheduledMCPTargetSchema,
} from 'librechat-data-provider';
import type {
  ScheduledMCPIdentity,
  ScheduledMCPTarget,
  ScheduledMCPToolSelection,
} from 'librechat-data-provider';
import type {
  ScheduledMCPAuthority,
  ScheduledMCPResourceBearerResolver,
  ScheduledMCPFailure,
} from './authorization/contract';
import type { ParsedServerConfig, RequestScopedMCPConnectionStore } from '~/mcp/types';
import type { ScheduleMCPEnrollmentResolver } from './authorization/service';
import type { ScheduledTokenContext } from './context';
import { getScheduledMCPConfigurationRevision } from './authorization/configuration';
import { readScheduleFireContext, isScheduleFireRequest } from './trigger';
import { ScheduleMCPConsentError } from './authorization/service';
import { usesDirectOpenIDBearerRecovery } from '~/mcp/openid';
import { ScheduledMCPBearerError } from '~/mcp/errors';
import { getMCPRequestContext } from '~/mcp/request';
import { awaitOboOperation } from '~/mcp/oauth/obo';
import { applyRequestHeaders } from '~/mcp/utils';

export { ScheduledMCPBearerError } from '~/mcp/errors';

export interface ScheduledMCPBearerHost {
  bind: (
    identity: ScheduledMCPIdentity,
    stage: 'activation' | 'invoke' | 'resume',
    signal?: AbortSignal,
  ) => ScheduledBearerScope;
}
interface BearerInput {
  user?: { id: string; tenantId?: string };
  serverName: string;
  config: ParsedServerConfig;
  signal?: AbortSignal;
  selection?: ScheduledMCPToolSelection;
}
interface ScheduledBearerScope {
  readonly identity: ScheduledMCPIdentity;
  resolve: (input: BearerInput) => Promise<ParsedServerConfig>;
  reject: (serverName: string) => void;
}
const scopes = new WeakMap<RequestScopedMCPConnectionStore, ScheduledBearerScope>();

/** The host owns credential issuance; this module caches only within one bound occurrence. */
export function createScheduledMCPBearerHost(deps: {
  authority: ScheduledMCPAuthority;
  resolveEnrollment: ScheduleMCPEnrollmentResolver;
  resolveBearer: ScheduledMCPResourceBearerResolver;
  now?: () => number;
}): ScheduledMCPBearerHost {
  const now = deps.now ?? Date.now;
  return {
    bind(identity, stage, ownerSignal) {
      const captured = Object.freeze(scheduledMCPIdentitySchema.parse(identity));
      const cached = new Map<string, { token: string; expiresAtMs: number }>();
      const flights = new Map<string, Promise<{ token: string; expiresAtMs: number }>>();
      const rejected = new Set<string>();
      const fail: (reason: ScheduledMCPFailure['reason'], server: string) => never = (
        reason,
        server,
      ) => {
        throw new ScheduledMCPBearerError(reason, server);
      };
      const authorize = async (
        target: ScheduledMCPTarget,
        selection: ScheduledMCPToolSelection,
        phase: 'activation' | 'mint' | 'invoke' | 'resume',
        signal?: AbortSignal,
      ) => {
        const result = await awaitOboOperation(
          deps.authority.authorize(
            {
              identity: captured,
              resource: target.resource,
              selection,
              stage: phase,
            },
            { signal },
          ),
          signal,
        );
        if (result.state === 'denied') fail(result.failure.reason, target.resource.serverName);
        if (result.state !== 'authorized')
          fail('dependency_unavailable', target.resource.serverName);
        if (!Number.isSafeInteger(result.validUntilMs) || result.validUntilMs <= now())
          fail('consent_expired', target.resource.serverName);
        return result;
      };
      return {
        identity: captured,
        reject(server) {
          rejected.add(server);
          cached.clear();
        },
        async resolve({ user, serverName, config, signal, selection }) {
          if (ownerSignal) signal = signal ? AbortSignal.any([ownerSignal, signal]) : ownerSignal;
          signal?.throwIfAborted();
          const effective = applyRequestHeaders(config);
          if (!usesDirectOpenIDBearerRecovery(effective)) return config;
          if (!('headers' in effective)) return fail('unsupported_mode', serverName);
          try {
            if (user?.id !== captured.ownerId || (user.tenantId ?? null) !== captured.tenantId)
              fail('binding_mismatch', serverName);
            if (rejected.has(serverName)) fail('credential_rejected', serverName);
            const targets = await awaitOboOperation(
              deps.resolveEnrollment(captured, { signal }),
              signal,
            );
            const candidates = targets.filter(
              (target) => target.resource.serverName === serverName,
            );
            if (candidates.length !== 1) fail('resource_unverified', serverName);
            const parsed = scheduledMCPTargetSchema.safeParse(candidates[0]);
            if (!parsed.success) fail('resource_unverified', serverName);
            const target = parsed.data;
            const resource = target.resource;
            if (
              resource.credentialMode !== 'resource_bearer' ||
              !resource.issuer ||
              !resource.audience
            )
              fail('unsupported_mode', serverName);
            if (
              getScheduledMCPConfigurationRevision(config, resource) !==
              resource.configurationRevision
            )
              fail('binding_mismatch', serverName);
            // No resource token in URL, subprocess, OAuth exchange or non-Authorization headers.
            const authorization = Object.entries(effective.headers ?? {}).filter(
              ([name]) => name.toLowerCase() === 'authorization',
            );
            if (
              authorization.length !== 1 ||
              !/^Bearer \{\{LIBRECHAT_OPENID_(?:ACCESS_TOKEN|TOKEN)\}\}$/i.test(
                extractEnvVariable(authorization[0][1]),
              )
            )
              fail('unsupported_mode', serverName);
            const { [authorization[0][0]]: _authorization, ...headers } = effective.headers ?? {};
            if (/\{\{LIBRECHAT_(?:OPENID_|GRAPH_)/.test(JSON.stringify({ ...effective, headers })))
              fail('unsupported_mode', serverName);
            const selections = selection ? [selection] : target.permittedTools;
            if (!selections.length) fail('tool_policy_denied', serverName);
            const authorizations = await Promise.all(
              selections.map((item) => authorize(target, item, stage, signal)),
            );
            const authorizationKey = [
              ...new Set(
                authorizations.map((item) =>
                  JSON.stringify([item.consentId, item.consentRevision, item.policyRevision]),
                ),
              ),
            ].sort();
            const key = JSON.stringify([
              captured,
              resource,
              target.policyRevision,
              authorizationKey,
            ]);
            let credential = cached.get(key);
            const validUntil = Math.min(...authorizations.map((item) => item.validUntilMs));
            if (!credential || credential.expiresAtMs <= now()) {
              let pending = flights.get(key);
              if (!pending) {
                pending = (async () => {
                  for (const item of selections) await authorize(target, item, 'mint', ownerSignal);
                  const result = await awaitOboOperation(
                    deps.resolveBearer(
                      {
                        identity: captured,
                        resource: { ...resource, credentialMode: 'resource_bearer' },
                        selection: selections[0],
                        stage: 'mint',
                      },
                      { signal: ownerSignal },
                    ),
                    ownerSignal,
                  );
                  if (result.state === 'denied') fail(result.failure.reason, serverName);
                  if (result.state !== 'ready') fail('dependency_unavailable', serverName);
                  if (
                    !result.accessToken ||
                    /[\r\n]/.test(result.accessToken) ||
                    !Number.isSafeInteger(result.expiresAtMs) ||
                    result.expiresAtMs <= now() ||
                    result.issuer !== resource.issuer ||
                    result.audience !== resource.audience ||
                    result.resourceUrl !== resource.url
                  )
                    fail('binding_mismatch', serverName);
                  return {
                    token: result.accessToken,
                    expiresAtMs: Math.min(result.expiresAtMs, validUntil),
                  };
                })().finally(() => {
                  flights.delete(key);
                });
                flights.set(key, pending);
              }
              credential = await awaitOboOperation(pending, signal);
              cached.set(key, credential);
            }
            // Recheck authority after provider I/O, including cache hits and peer-flight adoption.
            for (const item of selections) {
              const fresh = await authorize(target, item, stage, signal);
              if (
                fresh.consentRevision !==
                  authorizations[selections.indexOf(item)].consentRevision ||
                fresh.policyRevision !== authorizations[selections.indexOf(item)].policyRevision
              )
                fail('binding_mismatch', serverName);
            }
            signal?.throwIfAborted();
            if (rejected.has(serverName)) fail('credential_rejected', serverName);
            if (credential.expiresAtMs <= now()) fail('credential_missing', serverName);
            return {
              ...effective,
              headers: {
                ...effective.headers,
                [authorization[0][0]]: `Bearer ${credential.token}`,
              },
            };
          } catch (error) {
            signal?.throwIfAborted();
            if (error instanceof ScheduledMCPBearerError) throw error;
            if (error instanceof ScheduleMCPConsentError)
              throw new ScheduledMCPBearerError('binding_mismatch', serverName);
            throw new ScheduledMCPBearerError('dependency_unavailable', serverName);
          }
        },
      };
    },
  };
}

/** An absent adapter is an explicit deny, never browser-token fallback. */
export function attachScheduledMCPBearer(
  context: RequestScopedMCPConnectionStore,
  identity: ScheduledMCPIdentity,
  host?: ScheduledMCPBearerHost,
  stage: 'activation' | 'invoke' | 'resume' = 'invoke',
  signal?: AbortSignal,
): void {
  if (scopes.has(context)) throw new ScheduledMCPBearerError('binding_mismatch', '');
  scopes.set(
    context,
    host
      ? host.bind(identity, stage, signal)
      : {
          identity: Object.freeze({ ...identity }),
          async resolve(input) {
            if (usesDirectOpenIDBearerRecovery(applyRequestHeaders(input.config)))
              throw new ScheduledMCPBearerError('provider_missing', input.serverName);
            return input.config;
          },
          reject() {},
        },
  );
}

export function isScheduledMCPBearer(context?: RequestScopedMCPConnectionStore): boolean {
  return context != null && scopes.has(context);
}
export async function resolveScheduledMCPBearerConfig(
  input: BearerInput & {
    context?: RequestScopedMCPConnectionStore;
  },
): Promise<ParsedServerConfig> {
  if (input.context?.cleanupStarted)
    throw new ScheduledMCPBearerError('binding_mismatch', input.serverName);
  const config =
    input.context && scopes.has(input.context)
      ? await scopes.get(input.context)!.resolve(input)
      : input.config;
  if (input.context?.cleanupStarted)
    throw new ScheduledMCPBearerError('binding_mismatch', input.serverName);
  return config;
}
export function rejectScheduledMCPBearer(
  context: RequestScopedMCPConnectionStore | undefined,
  serverName: string,
): void {
  if (context) scopes.get(context)?.reject(serverName);
}

export function prepareScheduledMCPBearer(input: {
  req: Parameters<typeof isScheduleFireRequest>[0] & { user: { id: string; tenantId?: string } };
  context?: RequestScopedMCPConnectionStore;
  restoredContext?: ScheduledTokenContext;
  host?: ScheduledMCPBearerHost;
  signal?: AbortSignal;
}): void {
  if (!isScheduleFireRequest(input.req)) return;
  const fire = readScheduleFireContext(input.req);
  const root = input.restoredContext;
  const identity =
    root ??
    (fire && typeof input.req.body?.agent_id === 'string'
      ? {
          scheduleId: fire.scheduleId,
          ownerId: input.req.user.id,
          tenantId: input.req.user.tenantId,
          agentId: input.req.body.agent_id,
          invocationMode: 'delegated' as const,
        }
      : undefined);
  const context = input.context ?? getMCPRequestContext(input.req);
  if (context && !identity) {
    attachScheduledMCPBearer(context, {
      scheduleId: '',
      ownerId: input.req.user.id,
      tenantId: input.req.user.tenantId ?? null,
      agentId: '',
      invocationMode: 'delegated',
    });
    return;
  }
  if (
    !context ||
    !identity ||
    identity.ownerId !== input.req.user.id ||
    (identity.tenantId ?? null) !== (input.req.user.tenantId ?? null)
  )
    throw new ScheduledMCPBearerError('binding_mismatch', '');
  attachScheduledMCPBearer(
    context,
    { ...identity, tenantId: identity.tenantId ?? null },
    input.host,
    root ? 'resume' : 'invoke',
    input.signal,
  );
}

/** Capture outside runnable/model config, just like the occurrence identity. */
export function bindScheduledMCPBearerInvocation(
  context: RequestScopedMCPConnectionStore | undefined,
  agentId: string | undefined,
  tool: string,
): ScheduledMCPBearerInvocation | undefined {
  if (!context || !scopes.has(context)) return;
  return Object.freeze({
    context,
    identity: scopes.get(context)!.identity,
    agentId,
    async resolve(input: Omit<BearerInput, 'selection'>) {
      try {
        return await resolveScheduledMCPBearerConfig({
          ...input,
          context,
          selection: { agentId: agentId ?? '', tools: [tool] },
        });
      } catch (error) {
        if (error instanceof ScheduledMCPBearerError)
          throw new ScheduledMCPBearerError(error.failure.reason, input.serverName, agentId);
        throw error;
      }
    },
  });
}
export interface ScheduledMCPBearerInvocation {
  readonly identity: ScheduledMCPIdentity;
  readonly agentId?: string;
  readonly context: RequestScopedMCPConnectionStore;
  readonly resolve: (input: Omit<BearerInput, 'selection'>) => Promise<ParsedServerConfig>;
}

/** Preserve ordinary tool errors; resource-bearer authorization denials retain schedule evidence. */
export function createMCPPermissionDeniedError(
  invocation: ScheduledMCPBearerInvocation | undefined,
  serverName: string,
  config?: ParsedServerConfig,
): Error {
  return invocation && config && usesDirectOpenIDBearerRecovery(applyRequestHeaders(config))
    ? new ScheduledMCPBearerError('rbac_denied', serverName, invocation.agentId)
    : new Error('Forbidden: Insufficient MCP server permissions');
}

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
import type {
  ParsedServerConfig,
  RequestScopedMCPConnectionStore,
  MCPRequestHeaderResolver,
} from '~/mcp/types';
import type { ScheduleMCPFailureInput, ScheduleMCPSettlementBoundary } from './types';
import type { ScheduleMCPEnrollmentResolver } from './authorization/service';
import type { ScheduledTokenContext } from './context';
import {
  getMCPRequestContext,
  getMCPRequestSignal,
  quiesceMCPRequestContext,
  MCPRequestQuiescedError,
} from '~/mcp/request';
import {
  ScheduledMCPBearerError,
  isMCPTransportAuthenticationError,
  createScheduledMCPTransportError,
} from '~/mcp/errors';
import { getScheduledMCPConfigurationRevision } from './authorization/configuration';
import { readScheduleFireContext, isScheduleFireRequest } from './trigger';
import { getScheduleMCPExecution } from './authorization/execution';
import { ScheduleMCPConsentError } from './authorization/service';
import { usesDirectOpenIDBearerRecovery } from '~/mcp/openid';
import { holdMCPRequestFailure } from '~/mcp/signal';
import { awaitOboOperation } from '~/mcp/oauth/obo';
import { isOwnedAbortError } from '~/utils/errors';
import { applyRequestHeaders } from '~/mcp/utils';

export { ScheduledMCPBearerError } from '~/mcp/errors';

export interface ScheduledMCPBearerHost {
  bind: (
    identity: ScheduledMCPIdentity,
    stage: 'activation' | 'invoke' | 'resume',
    signal?: AbortSignal,
    options?: { manual?: boolean },
  ) => ScheduledBearerScope;
}
interface BearerInput {
  user?: { id: string; tenantId?: string };
  serverName: string;
  config: ParsedServerConfig;
  signal?: AbortSignal;
  selection?: ScheduledMCPToolSelection;
  /** Registers a typed denial before waiter cancellation can detach its propagation. */
  onFailure?: (error: ScheduledMCPBearerError) => void;
}
interface ScheduledBearerScope {
  readonly identity: ScheduledMCPIdentity;
  resolve: (input: BearerInput) => Promise<ParsedServerConfig>;
  reject: (serverName: string, reason?: ScheduledMCPFailure['reason']) => void;
}
const scopes = new WeakMap<RequestScopedMCPConnectionStore, ScheduledBearerScope>();
const scopeSignals = new WeakMap<RequestScopedMCPConnectionStore, AbortSignal>();
type BearerFailureRecorder = (error: ScheduledMCPBearerError) => Promise<boolean>;
const failureRecorders = new WeakMap<RequestScopedMCPConnectionStore, BearerFailureRecorder>();
interface BearerAdmissions {
  reports: WeakMap<object, Promise<boolean>>;
  pending: Set<Promise<boolean>>;
}
const failureAdmissions = new WeakMap<RequestScopedMCPConnectionStore, BearerAdmissions>();

/** Admission belongs to the occurrence; a cancelled waiter cannot discard already-observed evidence. */
function admitBearerFailure(
  context: RequestScopedMCPConnectionStore,
  error: ScheduledMCPBearerError,
  cause: object = error,
): Promise<boolean> | undefined {
  const recorder = failureRecorders.get(context);
  if (!recorder) return;
  let state = failureAdmissions.get(context);
  if (!state) {
    state = { reports: new WeakMap(), pending: new Set() };
    failureAdmissions.set(context, state);
  }
  let admission = state.reports.get(cause) ?? state.reports.get(error);
  if (!admission) {
    // The trusted recorder publishes exact-owner pending evidence before its first await.
    admission = recorder(error);
    state.reports.set(cause, admission);
    state.reports.set(error, admission);
    state.pending.add(admission);
    const receipt = admission;
    void admission.then(
      (acknowledged) => {
        if (acknowledged) state.pending.delete(receipt);
      },
      () => undefined,
    );
  }
  return admission;
}

/** The host owns credential issuance; this module caches only within one bound occurrence. */
export function createScheduledMCPBearerHost(deps: {
  authority: ScheduledMCPAuthority;
  resolveEnrollment: ScheduleMCPEnrollmentResolver;
  resolveBearer: ScheduledMCPResourceBearerResolver;
  now?: () => number;
}): ScheduledMCPBearerHost {
  const now = deps.now ?? Date.now;
  return {
    bind(identity, stage, ownerSignal, options) {
      const manual = options?.manual === true;
      const mintStage = stage === 'activation' ? 'activation' : 'mint';
      const captured = Object.freeze(scheduledMCPIdentitySchema.parse(identity));
      const cached = new Map<string, { token: string; expiresAtMs: number }>();
      const flights = new Map<string, Promise<{ token: string; expiresAtMs: number }>>();
      const rejected = new Map<string, ScheduledMCPFailure['reason']>();
      const fail: (
        reason: ScheduledMCPFailure['reason'],
        server: string,
        onFailure?: BearerInput['onFailure'],
      ) => never = (reason, server, onFailure) => {
        const error = new ScheduledMCPBearerError(reason, server);
        onFailure?.(error);
        throw error;
      };
      const authorize = async (
        target: ScheduledMCPTarget,
        selection: ScheduledMCPToolSelection,
        phase: 'activation' | 'mint' | 'invoke' | 'resume',
        signal?: AbortSignal,
        onFailure?: BearerInput['onFailure'],
      ) => {
        return awaitOboOperation(
          deps.authority
            .authorize(
              {
                identity: captured,
                resource: target.resource,
                selection,
                stage: phase,
                ...(manual && { manual: true }),
              },
              { signal },
            )
            .then((result) => {
              signal?.throwIfAborted();
              if (result.state === 'denied')
                fail(result.failure.reason, target.resource.serverName, onFailure);
              if (result.state !== 'authorized')
                fail('dependency_unavailable', target.resource.serverName, onFailure);
              if (!Number.isSafeInteger(result.validUntilMs) || result.validUntilMs <= now())
                fail('consent_expired', target.resource.serverName, onFailure);
              return result;
            }),
          signal,
        );
      };
      return {
        identity: captured,
        reject(server, reason = 'credential_rejected') {
          rejected.set(server, reason);
          cached.clear();
        },
        async resolve({ user, serverName, config, signal, selection, onFailure }) {
          const deny: (reason: ScheduledMCPFailure['reason'], server: string) => never = (
            reason,
            server,
          ) => fail(reason, server, onFailure);
          if (ownerSignal) signal = signal ? AbortSignal.any([ownerSignal, signal]) : ownerSignal;
          signal?.throwIfAborted();
          const effective = applyRequestHeaders(config);
          if (!usesDirectOpenIDBearerRecovery(effective)) return config;
          if (!('headers' in effective)) return deny('unsupported_mode', serverName);
          try {
            if (user?.id !== captured.ownerId || (user.tenantId ?? null) !== captured.tenantId)
              deny('binding_mismatch', serverName);
            if (rejected.has(serverName)) deny(rejected.get(serverName)!, serverName);
            const targets = await awaitOboOperation(
              deps.resolveEnrollment(captured, { signal }),
              signal,
            );
            const candidates = targets.filter(
              (target) => target.resource.serverName === serverName,
            );
            if (candidates.length !== 1) deny('resource_unverified', serverName);
            const parsed = scheduledMCPTargetSchema.safeParse(candidates[0]);
            if (!parsed.success) deny('resource_unverified', serverName);
            const target = parsed.data;
            const resource = target.resource;
            if (
              resource.credentialMode !== 'resource_bearer' ||
              !resource.issuer ||
              !resource.audience
            )
              deny('unsupported_mode', serverName);
            if (
              getScheduledMCPConfigurationRevision(config, resource) !==
              resource.configurationRevision
            )
              deny('binding_mismatch', serverName);
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
              deny('unsupported_mode', serverName);
            const { [authorization[0][0]]: _authorization, ...headers } = effective.headers ?? {};
            if (/\{\{LIBRECHAT_(?:OPENID_|GRAPH_)/.test(JSON.stringify({ ...effective, headers })))
              deny('unsupported_mode', serverName);
            const selections = selection ? [selection] : target.permittedTools;
            if (!selections.length) deny('tool_policy_denied', serverName);
            const authorizations = await Promise.all(
              selections.map((item) => authorize(target, item, stage, signal, onFailure)),
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
                  for (const item of selections)
                    await authorize(target, item, mintStage, ownerSignal, onFailure);
                  const result = await awaitOboOperation(
                    deps
                      .resolveBearer(
                        {
                          identity: captured,
                          resource: { ...resource, credentialMode: 'resource_bearer' },
                          selection: selections[0],
                          stage: mintStage,
                          ...(manual && { manual: true }),
                        },
                        { signal: ownerSignal },
                      )
                      .then((result) => {
                        ownerSignal?.throwIfAborted();
                        if (result.state === 'denied') deny(result.failure.reason, serverName);
                        if (result.state !== 'ready') deny('dependency_unavailable', serverName);
                        return result;
                      }),
                    ownerSignal,
                  );
                  if (
                    !result.accessToken ||
                    /[\r\n]/.test(result.accessToken) ||
                    !Number.isSafeInteger(result.expiresAtMs) ||
                    result.expiresAtMs <= now() ||
                    result.issuer !== resource.issuer ||
                    result.audience !== resource.audience ||
                    result.resourceUrl !== resource.url
                  )
                    deny('binding_mismatch', serverName);
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
              const fresh = await authorize(target, item, stage, signal, onFailure);
              if (
                fresh.consentRevision !==
                  authorizations[selections.indexOf(item)].consentRevision ||
                fresh.policyRevision !== authorizations[selections.indexOf(item)].policyRevision
              )
                deny('binding_mismatch', serverName);
            }
            signal?.throwIfAborted();
            if (rejected.has(serverName)) deny(rejected.get(serverName)!, serverName);
            if (credential.expiresAtMs <= now()) deny('credential_missing', serverName);
            return {
              ...effective,
              headers: {
                ...effective.headers,
                [authorization[0][0]]: `Bearer ${credential.token}`,
              },
            };
          } catch (error) {
            if (error instanceof ScheduledMCPBearerError) throw error;
            signal?.throwIfAborted();
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
  options?: { manual?: boolean; onFailure?: BearerFailureRecorder },
): void {
  if (scopes.has(context)) throw new ScheduledMCPBearerError('binding_mismatch', '');
  const requestSignal = getMCPRequestSignal(context);
  signal = signal ? AbortSignal.any([signal, requestSignal]) : requestSignal;
  scopeSignals.set(context, signal);
  if (options?.onFailure) failureRecorders.set(context, options.onFailure);
  scopes.set(
    context,
    host
      ? host.bind(identity, stage, signal, options && { manual: options.manual })
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

/** Transport/session opens, SDK SSE retries and catalog refresh all use this closure. */
export function createScheduledMCPBearerHeaderResolver(
  input: BearerInput & {
    context?: RequestScopedMCPConnectionStore;
  },
): MCPRequestHeaderResolver | undefined {
  if (!input.context || !requiresScheduledMCPBearerConnection(input.context, input.config)) return;
  const { context, config, serverName } = input;
  const user = input.user && Object.freeze({ id: input.user.id, tenantId: input.user.tenantId });
  const onFailure = failureRecorders.get(context);

  const assertOpen = () => {
    getMCPRequestSignal(context).throwIfAborted();
    scopeSignals.get(context)?.throwIfAborted();

    if (context.quiesceStarted || context.cleanupStarted) throw new MCPRequestQuiescedError();
  };
  const resolver: MCPRequestHeaderResolver = async (signal, onDenied) => {
    const ownerSignal = scopeSignals.get(context);
    if (ownerSignal) signal = signal ? AbortSignal.any([ownerSignal, signal]) : ownerSignal;
    signal?.throwIfAborted();
    if (context.quiesceStarted) throw new MCPRequestQuiescedError();
    if (context.cleanupStarted) throw new ScheduledMCPBearerError('binding_mismatch', serverName);
    const resolved = await resolveScheduledMCPBearerConfig({
      config,
      serverName,
      user,
      signal,
      context,
      onFailure: onDenied,
    });
    signal?.throwIfAborted();
    if (context.quiesceStarted) throw new MCPRequestQuiescedError();
    if (context.cleanupStarted) throw new ScheduledMCPBearerError('binding_mismatch', serverName);
    const authorization = Object.entries(
      'headers' in resolved ? (resolved.headers ?? {}) : {},
    ).find(([name]) => name.toLowerCase() === 'authorization');
    if (!authorization) throw new ScheduledMCPBearerError('binding_mismatch', serverName);
    return { authorization: authorization[1] };
  };
  resolver.assertOpen = assertOpen;
  if (onFailure)
    resolver.recordFailure = async (cause) => {
      const rejection = isMCPTransportAuthenticationError(cause);
      let error = cause instanceof ScheduledMCPBearerError ? cause : undefined;
      if (!error && rejection) error = createScheduledMCPTransportError(cause, serverName);
      if (!error) return;
      if (rejection) rejectScheduledMCPBearer(context, serverName, error.failure.reason);
      const key = cause != null && typeof cause === 'object' ? cause : error;
      const admission = admitBearerFailure(context, error, key);
      if (!(await admission) || rejection) throw error;
    };
  if (onFailure)
    resolver.settle = async () => {
      const pending = failureAdmissions.get(context)?.pending;
      while (pending && pending.size > 0) {
        if ((await Promise.all(pending)).some((acknowledged) => !acknowledged))
          throw new ScheduledMCPBearerError('dependency_unavailable', serverName);
      }
    };
  return resolver;
}

export function isScheduledMCPBearer(context?: RequestScopedMCPConnectionStore): boolean {
  return context != null && scopes.has(context);
}

/** Request identity is captured by the trusted host, never reconstructed from tool input. */
export function getScheduledMCPBearerIdentity(
  context?: RequestScopedMCPConnectionStore,
): ScheduledMCPIdentity | undefined {
  return context ? scopes.get(context)?.identity : undefined;
}

export function requiresScheduledMCPBearerConnection(
  context: RequestScopedMCPConnectionStore | undefined,
  config: ParsedServerConfig,
): boolean {
  return (
    isScheduledMCPBearer(context) && usesDirectOpenIDBearerRecovery(applyRequestHeaders(config))
  );
}
export async function resolveScheduledMCPBearerConfig(
  input: BearerInput & {
    context?: RequestScopedMCPConnectionStore;
  },
): Promise<ParsedServerConfig> {
  if (input.context?.quiesceStarted) throw new MCPRequestQuiescedError();
  if (input.context?.cleanupStarted)
    throw new ScheduledMCPBearerError('binding_mismatch', input.serverName);
  const scope = input.context && scopes.get(input.context);
  let config = input.config;
  if (scope && input.context) {
    const requestSignal = getMCPRequestSignal(input.context);
    const signal = input.signal ? AbortSignal.any([input.signal, requestSignal]) : requestSignal;
    signal.throwIfAborted();
    let knownFailure: Promise<never> | undefined;
    let observedError: ScheduledMCPBearerError | undefined;
    const observe = (error: ScheduledMCPBearerError): void => {
      if (observedError === error) return;
      observedError = error;
      input.onFailure?.(error);
      const admission = admitBearerFailure(input.context!, error);
      const failure = Promise.resolve(admission).then((): never => {
        throw error;
      });
      knownFailure ??= failure;
      holdMCPRequestFailure(failure);
    };
    // Observe before any outer waiter detaches; receipt admission has a separate lifetime.
    const operation = scope.resolve({ ...input, signal, onFailure: observe }).catch((error) => {
      if (error instanceof ScheduledMCPBearerError) observe(error);
      throw error;
    });
    try {
      config = await awaitOboOperation(operation, signal);
    } catch (error) {
      if (knownFailure) return await knownFailure;
      throw error;
    }
  }
  if (input.context?.quiesceStarted) throw new MCPRequestQuiescedError();
  if (input.context?.cleanupStarted)
    throw new ScheduledMCPBearerError('binding_mismatch', input.serverName);
  return config;
}
export function rejectScheduledMCPBearer(
  context: RequestScopedMCPConnectionStore | undefined,
  serverName: string,
  reason: ScheduledMCPFailure['reason'] = 'credential_rejected',
): void {
  if (context) scopes.get(context)?.reject(serverName, reason);
}

export function prepareScheduledMCPBearer(input: {
  req: Parameters<typeof isScheduleFireRequest>[0] & { user: { id: string; tenantId?: string } };
  context?: RequestScopedMCPConnectionStore;
  restoredContext?: ScheduledTokenContext;
  host?: ScheduledMCPBearerHost;
  signal?: AbortSignal;
  streamId?: string | null;
  jobCreatedAt?: number;
  /** Host facade waits for durable admission, or fences a retired generation. */
  recordFailure?: (input: ScheduleMCPFailureInput) => Promise<boolean>;
  registerSettlement?: (boundary: ScheduleMCPSettlementBoundary) => void;
}): void {
  const context = input.context ?? getMCPRequestContext(input.req);
  const execution = getScheduleMCPExecution(context);
  if (!isScheduleFireRequest(input.req) && !execution) return;
  input.signal?.throwIfAborted();
  const fire = readScheduleFireContext(input.req);
  const root = input.restoredContext;
  const identity =
    execution?.identity ??
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
  const captured = Object.freeze({ ...identity, tenantId: identity.tenantId ?? null });
  const { streamId, jobCreatedAt, recordFailure } = input;
  const onFailure: BearerFailureRecorder | undefined = recordFailure
    ? (error) =>
        recordFailure({
          error,
          identity: captured,
          streamId: streamId ?? undefined,
          jobCreatedAt,
          userId: captured.ownerId,
          serverName: error.outcomes[0].server,
        })
    : undefined;
  if (streamId && jobCreatedAt != null)
    input.registerSettlement?.({
      identity: captured,
      streamId,
      jobCreatedAt,
      quiesce: () => quiesceMCPRequestContext(context),
    });
  attachScheduledMCPBearer(
    context,
    captured,
    input.host,
    execution?.stage ?? (root ? 'resume' : 'invoke'),
    input.signal,
    { manual: execution?.manual === true || (!execution && fire?.manual === true), onFailure },
  );
}

/** A3 establishes execution identity before credential scope is attached. */
export function initializeWithScheduledMCPBearer<T>(
  input: Parameters<typeof prepareScheduledMCPBearer>[0],
  initialize: () => Promise<T>,
): Promise<T> {
  try {
    prepareScheduledMCPBearer(input);
  } catch (error) {
    if (isOwnedAbortError(error, input.signal) || error instanceof ScheduledMCPBearerError)
      throw error;
    throw new ScheduledMCPBearerError('dependency_unavailable', '');
  }
  return initialize();
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

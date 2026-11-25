import type { ScheduledMCPIdentity } from 'librechat-data-provider';
import type {
  UpstreamTokenProvider,
  UpstreamTokenProviderResolver,
  UpstreamTokenTarget,
} from '../mcp/oauth/obo';
import type { ExecutionContext } from '~/agents/authority/context';
import type { PreflightDeps } from '~/agents/authority/preflight';
import type { ScheduledTokenContext } from './context';
import type { ScheduledMCPBearerHost } from './bearer';
import type { ScheduleMCPPreflight } from './types';
import { toScheduledTokenContext } from '~/agents/authority/context';
import { createPreflight } from '~/agents/authority/preflight';
import { attachScheduledMCPBearer } from './bearer';
import { isScheduleFireRequest } from './trigger';

export interface ScheduledTokenIdentity {
  readonly id: string;
  readonly tenantId?: string;
  readonly role?: string;
  readonly provider?: string;
  readonly openidId?: string;
  readonly openidIssuer?: string;
}

export type HostUpstreamTokenProviderResolver = (
  user: ScheduledTokenIdentity,
  options: {
    signal?: AbortSignal;
    context?: ScheduledTokenContext;
    target?: UpstreamTokenTarget;
  },
) => ReturnType<UpstreamTokenProviderResolver>;

/** Bind a credential lookup to the trusted principal and owning run's cancellation. */
export function bindUpstreamTokenProviderResolver(
  user: ScheduledTokenIdentity,
  resolve: HostUpstreamTokenProviderResolver | undefined,
  signal?: AbortSignal,
  context?: ScheduledTokenContext,
): UpstreamTokenProviderResolver | undefined {
  if (!resolve) return undefined;
  const capturedContext = context && Object.freeze({ ...context });
  const pending = new Map<string, Promise<UpstreamTokenProvider | undefined>>();
  return (options) => {
    signal?.throwIfAborted();
    const target = options?.target && Object.freeze({ ...options.target });
    const key = JSON.stringify([target?.mcpServer, target?.scopes]);
    const cached = pending.get(key);
    if (cached) return cached;
    const lookup = Promise.resolve()
      .then(() => {
        signal?.throwIfAborted();
        return resolve(user, {
          signal,
          ...(capturedContext ? { context: capturedContext } : {}),
          ...(target ? { target } : {}),
        });
      })
      .then((provider) => {
        if (!provider) pending.delete(key);
        return provider;
      })
      .catch((error) => {
        pending.delete(key);
        throw error;
      });
    pending.set(key, lookup);
    return lookup;
  };
}

export function createScheduleUpstreamTokenProviderResolver(
  req: Parameters<typeof isScheduleFireRequest>[0] & { user: ScheduledTokenIdentity },
  resolve: HostUpstreamTokenProviderResolver | undefined,
  signal?: AbortSignal,
  executionContext?: ExecutionContext,
): UpstreamTokenProviderResolver | undefined {
  if (!isScheduleFireRequest(req)) return undefined;
  return bindUpstreamTokenProviderResolver(
    req.user,
    resolve,
    signal,
    toScheduledTokenContext(executionContext),
  );
}

interface ScheduleMCPDeps extends PreflightDeps {
  scheduledBearerHost?: ScheduledMCPBearerHost;
  resolveUpstreamTokenProvider?: HostUpstreamTokenProviderResolver;
}

/**
 * A schedule's readiness check. The check itself is `createPreflight`; what is the schedule's
 * own is its identity, the bearer a probe connects with, and its renewable credentials.
 */
export function createScheduleMCPPreflight(deps: ScheduleMCPDeps): ScheduleMCPPreflight {
  const preflight = createPreflight<ScheduledMCPIdentity>(deps, {
    tokens: (user, identity, signal) =>
      bindUpstreamTokenProviderResolver(
        user,
        deps.resolveUpstreamTokenProvider,
        signal,
        identity && {
          scheduleId: identity.scheduleId,
          ownerId: identity.ownerId,
          ...(identity.tenantId ? { tenantId: identity.tenantId } : {}),
          agentId: identity.agentId,
          invocationMode: identity.invocationMode,
        },
      ),
    attach: (context, identity, stage, signal, options) =>
      attachScheduledMCPBearer(context, identity, deps.scheduledBearerHost, stage, signal, options),
  });
  return (agentId, principal, { scheduleId, ...options }) =>
    preflight(agentId, principal, {
      ...options,
      ...(scheduleId && {
        identity: {
          scheduleId,
          ownerId: principal.id,
          tenantId: principal.tenantId ?? null,
          agentId,
          invocationMode: 'delegated',
        },
      }),
    });
}

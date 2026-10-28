import { DEFAULT_HOOK_TIMEOUT_MS } from '@librechat/agents';
import { normalizeServerName, stripServerNamePrefix } from 'librechat-data-provider';
import type { ScheduledMCPIdentity, ScheduledMCPReadOnlyPolicy } from 'librechat-data-provider';
import type { ScheduleMCPConsentStorage } from '@librechat/data-schemas';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ParsedServerConfig, RequestScopedMCPConnectionStore } from '~/mcp/types';
import type { MCPToolsSnapshot } from '~/mcp/connection';
import type { ScheduledMCPAuthority } from './contract';
import type { ScheduledTokenContext } from '../context';
import { isScheduledMCPToolReadOnly, ScheduledMCPPolicyError } from './policy';
import { getScheduledMCPConfigurationRevision } from './configuration';
import { ScheduledMCPBearerError } from '~/mcp/errors';
import { ScheduleMCPConsentError } from './service';
import { isOwnedAbortError } from '~/utils/errors';
import { waitUntilDeadline } from '~/mcp/utils';

export interface ScheduledMCPInvocation {
  readonly identity: ScheduledMCPIdentity;
  /** False only for a monitored legacy occurrence. */
  readonly enrolled?: boolean;
  readonly agentId?: string;
  readonly authorize: (input: {
    user?: { id: string; tenantId?: string };
    serverName: string;
    serverConfig: ParsedServerConfig;
    toolName: string;
    loadTools: () => Promise<MCPToolsSnapshot>;
    signal?: AbortSignal;
  }) => Promise<void>;
}

export interface ScheduleMCPExecution {
  readonly identity: ScheduledMCPIdentity;
  readonly stage: 'activation' | 'invoke' | 'resume';
  /** Trusted admission provenance retained through credential/session preparation. */
  readonly manual?: boolean;
  readonly enrolled: boolean;
  /** Legacy admits only while enrollment is still absent; it never acquires a later grant. */
  readonly checkEnrollment: () => Promise<void>;
  readonly bind: (agentId: string | undefined, selectionName: string) => ScheduledMCPInvocation;
}

const executions = new WeakMap<RequestScopedMCPConnectionStore, ScheduleMCPExecution>();

/** Captured at tool construction. Runnable config cannot remove or replace this guard. */
export function bindScheduledMCPInvocation(
  context: RequestScopedMCPConnectionStore | undefined,
  agentId: string | undefined,
  selectionName: string,
): ScheduledMCPInvocation | undefined {
  return context && executions.get(context)?.bind(agentId, selectionName);
}

export function getScheduleMCPExecution(
  context?: RequestScopedMCPConnectionStore,
): ScheduleMCPExecution | undefined {
  return context && executions.get(context);
}

export interface ScheduleMCPExecutionDeps {
  storage: ScheduleMCPConsentStorage;
  /** Fresh for each call; only this attempt may reuse its principal/configuration. */
  loadAuthorization: (identity: ScheduledMCPIdentity) => Promise<{
    authority: ScheduledMCPAuthority;
    policy?: Record<string, ScheduledMCPReadOnlyPolicy>;
  }>;
}

export function createScheduleMCPExecution(deps: ScheduleMCPExecutionDeps): {
  resolve: (
    identity: ScheduledMCPIdentity,
    stage: ScheduleMCPExecution['stage'],
    options?: { manual?: boolean; legacy?: boolean },
  ) => Promise<ScheduleMCPExecution | undefined>;
  attach: (
    context: RequestScopedMCPConnectionStore,
    identity: ScheduledMCPIdentity,
    stage: ScheduleMCPExecution['stage'],
    requireEnrollment?: boolean,
    options?: { manual?: boolean; legacy?: boolean },
  ) => Promise<void>;
} {
  async function resolve(
    identity: ScheduledMCPIdentity,
    stage: ScheduleMCPExecution['stage'],
    options: { manual?: boolean; legacy?: boolean } = {},
  ): Promise<ScheduleMCPExecution | undefined> {
    const snapshot = await deps.storage.readScheduleMCPConsent(identity);
    if (snapshot?.compatible === false) throw new ScheduledMCPPolicyError('binding_mismatch', '');
    if (!snapshot) return;
    const enrolled = snapshot.enrollment != null;
    if (enrolled && options.legacy === true)
      throw new ScheduledMCPPolicyError('binding_mismatch', '');
    const capturedIdentity = Object.freeze({ ...identity });
    const manual = options.manual === true;
    const resources = new Map(
      (snapshot.enrollment?.consents ?? []).map(({ resource }) => [
        resource.serverName,
        structuredClone(resource),
      ]),
    );
    let fenced = false;
    const checkEnrollment = async (): Promise<void> => {
      if (enrolled) return;
      if (fenced) throw new ScheduledMCPPolicyError('binding_mismatch', '');
      // Finish before the SDK discards a timed-out hook's contribution. No allow decision cached.
      const observed = await waitUntilDeadline(
        deps.storage.readScheduleMCPConsent(capturedIdentity),
        Date.now() + DEFAULT_HOOK_TIMEOUT_MS / 2,
      );
      if (!observed.settled) throw new ScheduledMCPPolicyError('dependency_unavailable', '');
      if (
        !observed.value ||
        observed.value.compatible === false ||
        observed.value.enrollment != null
      ) {
        fenced = true;
        throw new ScheduledMCPPolicyError('binding_mismatch', '');
      }
    };
    return Object.freeze({
      identity: capturedIdentity,
      stage,
      ...(manual && { manual: true }),
      enrolled,
      checkEnrollment,
      bind(agentId: string | undefined, selectionName: string): ScheduledMCPInvocation {
        return Object.freeze({
          identity: capturedIdentity,
          agentId,
          enrolled,
          async authorize({
            user,
            serverName,
            serverConfig,
            toolName,
            loadTools,
            signal,
          }: Parameters<ScheduledMCPInvocation['authorize']>[0]): Promise<void> {
            signal?.throwIfAborted();
            const deny = (
              reason: ConstructorParameters<typeof ScheduledMCPPolicyError>[0],
            ): never => {
              throw new ScheduledMCPPolicyError(reason, serverName, agentId);
            };
            if (
              !agentId ||
              user?.id !== capturedIdentity.ownerId ||
              (user.tenantId ?? null) !== capturedIdentity.tenantId
            )
              deny('binding_mismatch');
            if (!enrolled) {
              try {
                await checkEnrollment();
              } catch (error) {
                signal?.throwIfAborted();
                deny(
                  error instanceof ScheduledMCPPolicyError
                    ? error.failure.reason
                    : 'dependency_unavailable',
                );
              }
              signal?.throwIfAborted();
              return;
            }
            // Only the recipient is captured. Authority re-resolves live graph/policy below.
            const resource = resources.get(serverName);
            if (!resource) deny('tool_policy_denied');
            try {
              if (
                getScheduledMCPConfigurationRevision(serverConfig, resource!) !==
                resource!.configurationRevision
              )
                deny('binding_mismatch');
            } catch (error) {
              if (error instanceof ScheduleMCPConsentError) deny('binding_mismatch');
              throw error;
            }
            // Resolve the actual upstream operation, including legacy and prefix-stripped keys.
            if (
              selectionName !== toolName &&
              selectionName !== stripServerNamePrefix(toolName, normalizeServerName(serverName))
            )
              deny('tool_policy_denied');
            try {
              const [evaluation, catalog] = await Promise.all([
                deps.loadAuthorization(capturedIdentity),
                loadTools(),
              ]);
              signal?.throwIfAborted();
              if (catalog.authenticationError != null) deny('credential_rejected');
              const definitions = catalog.tools.filter((tool: Tool) => tool.name === toolName);
              if (
                !catalog.complete ||
                definitions.length !== 1 ||
                !isScheduledMCPToolReadOnly(definitions[0], evaluation.policy?.[serverName])
              )
                deny('tool_policy_denied');
              const authorization = await evaluation.authority.authorize(
                {
                  identity: capturedIdentity,
                  resource: resource!,
                  stage,
                  ...(manual && { manual: true }),
                  selection: { agentId: agentId!, tools: [selectionName] },
                },
                { signal },
              );
              if (authorization.state === 'denied') deny(authorization.failure.reason);
              if (authorization.state === 'cancelled') {
                signal?.throwIfAborted();
                deny('dependency_unavailable');
              }
              signal?.throwIfAborted();
            } catch (error) {
              if (
                error instanceof ScheduledMCPPolicyError ||
                error instanceof ScheduledMCPBearerError ||
                isOwnedAbortError(error, signal)
              )
                throw error;
              deny('dependency_unavailable');
            }
          },
        });
      },
    });
  }
  return {
    resolve,
    async attach(context, identity, stage, requireEnrollment = false, options) {
      const execution = await resolve(identity, stage, options);
      if ((!execution || !execution.enrolled) && requireEnrollment)
        throw new ScheduledMCPPolicyError('consent_missing', '');
      if (execution) executions.set(context, execution);
    },
  };
}

/** The trusted trigger/resume host owns the context. No body-provided schedule opt-in. */
export function scheduledMCPIdentity(context: ScheduledTokenContext): ScheduledMCPIdentity {
  return {
    scheduleId: context.scheduleId,
    ownerId: context.ownerId,
    tenantId: context.tenantId ?? null,
    agentId: context.agentId,
    invocationMode: 'delegated',
  };
}

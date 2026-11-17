import { DEFAULT_HOOK_TIMEOUT_MS } from '@librechat/agents';
import { Constants, normalizeServerName, stripServerNamePrefix } from 'librechat-data-provider';
import type { MCPGrantIdentity, ScheduledMCPIdentity } from 'librechat-data-provider';
import type { MCPConsentStorage } from '@librechat/data-schemas';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ParsedServerConfig, RequestScopedMCPConnectionStore } from '~/mcp/types';
import type { ResolvedToolApprovalHook } from '~/agents/hitl/hooks';
import type { MCPToolsSnapshot } from '~/mcp/connection';
import type { ScheduledMCPAuthority } from './contract';
import type { ScheduledTokenContext } from '../context';
import { getScheduledMCPToolDefinitionDigest, ScheduledMCPPolicyError } from './policy';
import { getScheduledMCPConfigurationRevision } from './configuration';
import { ScheduledMCPBearerError } from '~/mcp/errors';
import { ScheduleMCPConsentError } from './service';
import { isOwnedAbortError } from '~/utils/errors';
import { waitUntilDeadline } from '~/mcp/utils';

export interface ScheduledMCPInvocation<Identity extends MCPGrantIdentity = ScheduledMCPIdentity> {
  readonly identity: Identity;
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
    /** The call being made, as the approval layer knows it. Absent when nothing can approve. */
    toolCallId?: string;
    /** A readiness check, which calls nothing. Anything else must hold the owner's approval. */
    readiness?: true;
  }) => Promise<void>;
}

export interface ScheduleMCPExecution<Identity extends MCPGrantIdentity = ScheduledMCPIdentity> {
  readonly identity: Identity;
  readonly stage: 'activation' | 'invoke' | 'resume';
  /** Trusted admission provenance retained through credential/session preparation. */
  readonly manual?: boolean;
  readonly enrolled: boolean;
  /** Legacy admits only while enrollment is still absent; it never acquires a later grant. */
  readonly checkEnrollment: () => Promise<void>;
  /** Whether the grant asks the owner about any tool, so this run may pause. */
  readonly mayAsk: boolean;
  /** Whether the owner approves each use of this tool, by the name the run calls it. */
  readonly asksAbout: (agentId: string, toolKey: string) => boolean;
  readonly bind: (
    agentId: string | undefined,
    selectionName: string,
  ) => ScheduledMCPInvocation<Identity>;
}

const executions = new WeakMap<
  RequestScopedMCPConnectionStore,
  ScheduleMCPExecution<MCPGrantIdentity>
>();

/**
 * Captured at tool construction. Runnable config cannot remove or replace this guard.
 * Whatever the grant's subject, a schedule or an API key, the tool is checked the same way.
 */
export function bindScheduledMCPInvocation(
  context: RequestScopedMCPConnectionStore | undefined,
  agentId: string | undefined,
  selectionName: string,
): ScheduledMCPInvocation<MCPGrantIdentity> | undefined {
  return context && executions.get(context)?.bind(agentId, selectionName);
}

function actsForSchedule(
  execution: ScheduleMCPExecution<MCPGrantIdentity>,
): execution is ScheduleMCPExecution {
  return 'scheduleId' in execution.identity;
}

/** The run's execution when it acts for a schedule. A run that acts for an API key has none. */
export function getScheduleMCPExecution(
  context?: RequestScopedMCPConnectionStore,
): ScheduleMCPExecution | undefined {
  const execution = context && executions.get(context);
  return execution && actsForSchedule(execution) ? execution : undefined;
}

export interface ScheduleMCPExecutionDeps<
  Identity extends MCPGrantIdentity = ScheduledMCPIdentity,
> {
  storage: MCPConsentStorage<Identity>;
  /** Fresh for each call; only this attempt may reuse its principal/configuration. */
  loadAuthorization: (identity: Identity) => Promise<{
    authority: ScheduledMCPAuthority<Identity>;
  }>;
  /** Whether a subject with no grant may not use MCP tools. Absent, it always may. */
  requiresGrant?: (identity: Identity) => Promise<boolean>;
}

export interface ScheduleMCPExecutionOptions {
  manual?: boolean;
  legacy?: boolean;
  /** Tool calls the owner approved in the request that resumed this run. */
  approvedToolCalls?: readonly string[];
}

export interface ScheduleMCPExecutionFactory<
  Identity extends MCPGrantIdentity = ScheduledMCPIdentity,
> {
  resolve: (
    identity: Identity,
    stage: ScheduleMCPExecution['stage'],
    options?: ScheduleMCPExecutionOptions,
  ) => Promise<ScheduleMCPExecution<Identity> | undefined>;
  attach: (
    context: RequestScopedMCPConnectionStore,
    identity: Identity,
    stage: ScheduleMCPExecution['stage'],
    requireEnrollment?: boolean,
    options?: ScheduleMCPExecutionOptions,
  ) => Promise<void>;
}

export function createScheduleMCPExecution<
  Identity extends MCPGrantIdentity = ScheduledMCPIdentity,
>(deps: ScheduleMCPExecutionDeps<Identity>): ScheduleMCPExecutionFactory<Identity> {
  async function resolve(
    identity: Identity,
    stage: ScheduleMCPExecution['stage'],
    options: ScheduleMCPExecutionOptions = {},
  ): Promise<ScheduleMCPExecution<Identity> | undefined> {
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
    const approved = new Set(options.approvedToolCalls ?? []);
    /** Every spelling a run may call an ask tool by, per agent. A miss is refused, not run. */
    const asking = new Map<string, Set<string>>();
    for (const consent of snapshot.enrollment?.consents ?? []) {
      const { serverName } = consent.resource;
      for (const { agentId, tools } of consent.permittedTools) {
        const keys = asking.get(agentId) ?? new Set<string>();
        for (const tool of tools) {
          if (!consent.askTools?.includes(tool)) continue;
          keys.add(`${tool}${Constants.mcp_delimiter}${serverName}`);
          keys.add(`${tool}${Constants.mcp_delimiter}${normalizeServerName(serverName)}`);
        }
        if (keys.size > 0) asking.set(agentId, keys);
      }
    }
    let fenced = false;
    /** Asked at the first MCP call, so a run that uses none pays nothing. Kept for the run. */
    let required: Promise<boolean> | undefined;
    const requiresGrant = (): Promise<boolean> => {
      required ??= (deps.requiresGrant?.(capturedIdentity) ?? Promise.resolve(false)).catch(
        (error: unknown) => {
          required = undefined;
          throw error;
        },
      );
      return required;
    };
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
      mayAsk: asking.size > 0,
      asksAbout: (agentId: string, toolKey: string) => asking.get(agentId)?.has(toolKey) === true,
      bind(agentId: string | undefined, selectionName: string): ScheduledMCPInvocation<Identity> {
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
            toolCallId,
            readiness,
          }: Parameters<ScheduledMCPInvocation<Identity>['authorize']>[0]): Promise<void> {
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
                if (await requiresGrant()) deny('consent_missing');
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
              if (!catalog.complete || definitions.length !== 1) deny('tool_policy_denied');
              const authorization = await evaluation.authority.authorize(
                {
                  identity: capturedIdentity,
                  resource: resource!,
                  stage,
                  ...(manual && { manual: true }),
                  selection: { agentId: agentId!, tools: [selectionName] },
                  definitions: {
                    [selectionName]: getScheduledMCPToolDefinitionDigest(definitions[0]),
                  },
                },
                { signal },
              );
              if (authorization.state === 'denied') deny(authorization.failure.reason);
              if (authorization.state === 'cancelled') {
                signal?.throwIfAborted();
                deny('dependency_unavailable');
              }
              // The pause is a hook, and a hook that times out says nothing. This is the gate.
              if (
                authorization.state === 'authorized' &&
                authorization.approvalRequired &&
                readiness !== true &&
                !(toolCallId != null && approved.has(toolCallId))
              )
                deny('approval_required');
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

/**
 * Tells run admission that this schedule's grant can pause the run, so the requirements of
 * a paused scheduled run are checked before any provider work. Never asked for a decision.
 */
export function buildScheduledApprovalAdmissionHooks(
  execution?: Pick<ScheduleMCPExecution, 'mayAsk'>,
): ResolvedToolApprovalHook[] {
  return execution?.mayAsk === true ? [{ hook: async () => ({}) }] : [];
}

/** The tool calls the owner let through, as proposed or edited, in a validated resume value. */
export function collectApprovedToolCalls(resumeValue: unknown): string[] {
  if (resumeValue == null || typeof resumeValue !== 'object' || Array.isArray(resumeValue))
    return [];
  return Object.entries(resumeValue)
    .filter(
      ([, decision]) =>
        decision != null &&
        typeof decision === 'object' &&
        'type' in decision &&
        (decision.type === 'approve' || decision.type === 'edit'),
    )
    .map(([toolCallId]) => toolCallId);
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

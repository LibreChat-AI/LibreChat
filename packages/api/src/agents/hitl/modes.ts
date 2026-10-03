import { digestMCPAuthorityValue, logger } from '@librechat/data-schemas';
import type {
  AgentToolOptions,
  ToolApprovalGrantStorage,
  ToolApprovalGrantScope,
  ToolApprovalGrantBinding,
  Agents,
} from 'librechat-data-provider';
import type { HookCallback } from '@librechat/agents';
import type { ParsedServerConfig } from '~/mcp/types';
import { bindToolApproval, getToolApprovalBinding, getToolApprovalName } from '~/tools/approval';
import { requiresEphemeralUserConnection } from '~/mcp/utils';

export interface AgentApprovalDefinition {
  name: string;
  description?: string;
  parameters?: object;
  serverName?: string;
}

export interface AgentApprovalSource {
  id: string;
  tool_options?: AgentToolOptions;
  toolDefinitions?: AgentApprovalDefinition[];
}

/** A changed connection, raw schema, mode or revision requires fresh consent. */
export function buildMCPToolApprovalBinding(
  serverName: string,
  config: ParsedServerConfig | undefined,
): string | undefined {
  if (
    !config ||
    requiresEphemeralUserConnection(config) ||
    /\{\{[^{}]+\}\}|\$\{[^{}]+\}/.test(JSON.stringify(config))
  )
    return undefined;
  return digestMCPAuthorityValue({ serverName, config });
}

export function attachMCPToolApprovalBindings(
  definitions: AgentApprovalDefinition[],
  bindings: ReadonlyMap<string, string | undefined>,
): void {
  for (const definition of definitions) {
    if (definition.serverName) bindToolApproval(definition, bindings.get(definition.serverName));
  }
}

export function resolveAgentToolGrantBinding(
  agent: AgentApprovalSource,
  toolName: string,
  scope: ToolApprovalGrantScope,
): ToolApprovalGrantBinding | undefined {
  const options = agent.tool_options?.[toolName];
  if (
    (options?.approval_mode !== 'chat' && options?.approval_mode !== 'always') ||
    options.approval_revision == null
  )
    return undefined;
  const definition = agent.toolDefinitions?.find((tool) => tool.name === toolName);
  if (!definition) return undefined;
  const sourceBinding = getToolApprovalBinding(definition);
  if (!sourceBinding) return undefined;
  const canonicalName = getToolApprovalName(definition) ?? toolName;
  return {
    canRemember: true,
    instanceName: toolName,
    agentId: agent.id,
    toolName: canonicalName,
    scope: options.approval_mode,
    binding: digestMCPAuthorityValue({
      userId: scope.userId,
      tenantId: scope.tenantId ?? null,
      agentId: agent.id,
      toolName: canonicalName,
      revision: options.approval_revision,
      mode: options.approval_mode,
      source: sourceBinding,
      parameters: definition.parameters,
      description: definition.description,
    }),
  };
}

export interface AgentToolApprovalSession {
  hook: HookCallback<'PreToolUse'>;
  rememberHook: HookCallback<'PostToolUse'>;
  addAgent: (agent: AgentApprovalSource) => void;
  unavailableFor: (callId: string) => ToolApprovalGrantBinding['unavailable'];
  bindingsFor: (
    payload: Agents.ToolApprovalInterruptPayload,
  ) => Record<string, ToolApprovalGrantBinding>;
}

/** Coalesce parallel lookups at the invocation boundary; do not cache revocable grants. */
export function createAgentToolApprovalSession({
  agents,
  scope,
  storage,
  lookupTimeoutMs = 3000,
  reviewed,
}: {
  lookupTimeoutMs?: number;
  reviewed?: ReviewedToolApprovals;
  agents: readonly AgentApprovalSource[];
  scope?: ToolApprovalGrantScope;
  storage?: ToolApprovalGrantStorage;
}): AgentToolApprovalSession {
  const owners = new Map(agents.map((agent) => [agent.id, agent]));
  const calls = new Map<string, ToolApprovalGrantBinding | null>();
  const unavailable = new Map<string, ToolApprovalGrantBinding['unavailable']>();
  const approvedDecisions = new Set(
    reviewed?.decisions
      .filter((decision) => decision.decision === 'approve')
      .map((decision) => decision.tool_call_id),
  );
  const ready = new Map<string, ToolApprovalGrantBinding>();
  type GrantStatus = {
    binding: string;
    approved: boolean;
    revocation?: string;
    available?: boolean;
  };
  let pending: Array<{ grant: ToolApprovalGrantBinding; resolve: (status: GrantStatus) => void }> =
    [];
  let scheduled = false;
  const approved = (grant: ToolApprovalGrantBinding): Promise<GrantStatus> =>
    new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ binding: grant.binding, approved: false, available: false }),
        lookupTimeoutMs,
      );
      pending.push({
        grant,
        resolve: (status) => {
          clearTimeout(timer);
          resolve(status);
        },
      });
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        const batch = pending;
        pending = [];
        scheduled = false;
        const decline = () => {
          for (const item of batch)
            item.resolve({ binding: item.grant.binding, approved: false, available: false });
        };
        if (!storage || !scope) {
          decline();
          return;
        }
        void storage
          .getToolApprovalGrants(
            scope,
            batch.map((item) => item.grant),
          )
          .then((grants) => {
            const statuses = new Map(grants.map((status) => [status.binding, status]));
            for (const item of batch)
              item.resolve(
                statuses.get(item.grant.binding) ?? {
                  binding: item.grant.binding,
                  approved: false,
                },
              );
          }, decline);
      });
    });
  return {
    addAgent: (agent) => {
      owners.set(agent.id, agent);
    },
    unavailableFor: (callId) => unavailable.get(callId),
    bindingsFor(payload) {
      const result: Record<string, ToolApprovalGrantBinding> = {};
      for (const request of payload.action_requests) {
        const binding = calls.get(request.tool_call_id);
        if (binding?.instanceName === request.name) result[request.tool_call_id] = binding;
      }
      return result;
    },
    async rememberHook(input) {
      const grant = ready.get(input.toolUseId);
      if (
        !grant ||
        grant.canRemember !== true ||
        grant.agentId !== input.executingAgentId ||
        grant.instanceName !== input.toolName ||
        !storage ||
        !scope
      )
        return {};
      ready.delete(input.toolUseId);
      try {
        await storage.rememberToolApprovalGrants(scope, [grant]);
      } catch {
        logger.warn('[Tool approvals] Could not remember approval; future calls require review.');
      }
      return {};
    },
    async hook(input) {
      const agent = input.executingAgentId == null ? undefined : owners.get(input.executingAgentId);
      const mode = agent?.tool_options?.[input.toolName]?.approval_mode;
      const reviewedBinding = reviewed?.bindings?.[input.toolUseId];
      if (reviewedBinding) {
        const current =
          agent && scope && resolveAgentToolGrantBinding(agent, input.toolName, scope);
        if (
          current?.binding !== reviewedBinding.binding ||
          current.agentId !== reviewedBinding.agentId
        ) {
          return {
            decision: 'deny',
            reason: 'The reviewed tool binding changed. Please request approval again.',
          };
        }
        if (approvedDecisions.has(input.toolUseId) && reviewedBinding.canRemember === true)
          ready.set(input.toolUseId, reviewedBinding);
      }
      if (mode == null) return {};
      if (mode === 'ask') return { decision: 'ask' };
      if (mode === 'allow') return { decision: 'allow' };
      const binding = agent && scope && resolveAgentToolGrantBinding(agent, input.toolName, scope);
      if (!binding) {
        unavailable.set(input.toolUseId, 'connection');
        return { decision: 'ask' };
      }
      if (!storage) {
        binding.canRemember = false;
        binding.unavailable = 'disabled';
        calls.set(input.toolUseId, binding);
        return { decision: 'ask' };
      }
      const prior = calls.get(input.toolUseId);
      if (prior !== undefined && prior?.binding !== binding.binding) {
        calls.set(input.toolUseId, null);
        return { decision: 'ask' };
      }
      calls.set(input.toolUseId, binding);
      const status = await approved(binding);
      binding.revocation = status.revocation;
      if (status.available === false) {
        binding.canRemember = false;
        binding.unavailable = 'storage';
      }
      return { decision: status.approved ? 'allow' : 'ask' };
    },
  };
}

const sessions = new WeakMap<object, AgentToolApprovalSession>();
export function bindRunToolApprovalSession(run: object, session: AgentToolApprovalSession): void {
  sessions.set(run, session);
}

export function captureRunToolApprovalBindings(
  run: object,
  payload: Agents.HumanInterruptPayload,
): Record<string, ToolApprovalGrantBinding> | undefined {
  return payload.type === 'tool_approval' ? sessions.get(run)?.bindingsFor(payload) : undefined;
}

export function describeRememberedToolApprovals(
  payload: Agents.HumanInterruptPayload,
  bindings: Record<string, ToolApprovalGrantBinding> | undefined,
  run?: object,
): Agents.HumanInterruptPayload {
  if (payload.type !== 'tool_approval' || !bindings) return payload;
  return {
    ...payload,
    review_configs: payload.review_configs.map((config) => ({
      ...config,
      remember_scope:
        bindings[config.tool_call_id]?.canRemember === true
          ? bindings[config.tool_call_id]?.scope
          : undefined,
      remember_unavailable:
        bindings[config.tool_call_id]?.unavailable ??
        (run ? sessions.get(run)?.unavailableFor(config.tool_call_id) : undefined),
    })),
  };
}

export interface ReviewedToolApprovals {
  bindings?: Record<string, ToolApprovalGrantBinding>;
  decisions: readonly Agents.ToolApprovalResolution[];
}

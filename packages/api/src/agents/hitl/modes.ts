import { createToolPolicyHook } from '@librechat/agents';
import { digestMCPAuthorityValue, logger } from '@librechat/data-schemas';
import type {
  AgentToolOptions,
  ToolApprovalGrantStorage,
  ToolApprovalGrantScope,
  ToolApprovalGrantBinding,
  Agents,
} from 'librechat-data-provider';
import type { ToolApprovalAuthKind } from 'librechat-data-provider';
import type { TToolApprovalPolicy } from 'librechat-data-provider';
import type { HookCallback } from '@librechat/agents';
import type { Run, IState } from '@librechat/agents';
import type { ToolApprovalExecution } from '~/tools/approval';
import type { ParsedServerConfig } from '~/mcp/types';
import { bindToolApproval, getToolApprovalBinding, getToolApprovalName } from '~/tools/approval';
import { withToolApprovalExecution, getToolApprovalIdentity } from '~/tools/approval';
import { bindToolReviewAuthority, getToolReviewAuthority } from '~/tools/approval';
import { getToolApprovalExecutionScope } from '~/tools/approval';
import { requiresEphemeralUserConnection } from '~/mcp/utils';
import { projectMCPApprovalAuthority } from '~/mcp/approval';
import { getToolApprovalAuthKind } from '~/tools/approval';
import { mapToolApprovalPolicy } from './policy';

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
  if (config) config = projectMCPApprovalAuthority(config);
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
  reviewAuthorities?: ReadonlyMap<string, string | undefined>,
  authKinds?: ReadonlyMap<string, ToolApprovalAuthKind | undefined>,
): void {
  for (const definition of definitions) {
    if (!definition.serverName) continue;
    bindToolApproval(
      definition,
      bindings.get(definition.serverName),
      undefined,
      undefined,
      undefined,
      authKinds?.get(definition.serverName),
    );
    bindToolReviewAuthority(definition, reviewAuthorities?.get(definition.serverName));
  }
}

export function resolveAgentToolGrantBinding(
  agent: AgentApprovalSource,
  toolName: string,
  scope: ToolApprovalGrantScope,
  executingTool?: AgentApprovalDefinition,
): ToolApprovalGrantBinding | undefined {
  const options = agent.tool_options?.[toolName];
  if (
    options?.approval_mode == null ||
    ((options.approval_mode === 'chat' || options.approval_mode === 'always') &&
      options.approval_revision == null)
  )
    return undefined;
  const definition = executingTool ?? agent.toolDefinitions?.find((tool) => tool.name === toolName);
  if (!definition) return undefined;
  const sourceBinding = getToolApprovalBinding(definition);
  const identity = getToolApprovalIdentity(definition);
  if (!sourceBinding || !identity) return undefined;
  const canonicalName = getToolApprovalName(definition) ?? toolName;
  return {
    canRemember: options.approval_mode === 'chat' || options.approval_mode === 'always',
    instanceName: toolName,
    serverName: definition.serverName,
    authKind: getToolApprovalAuthKind(definition),
    oauthEpoch: null,
    agentId: agent.id,
    toolName: canonicalName,
    scope:
      options.approval_mode === 'ask' || options.approval_mode === 'allow'
        ? 'once'
        : options.approval_mode,
    binding: digestMCPAuthorityValue({
      userId: scope.userId,
      tenantId: scope.tenantId ?? null,
      agentId: agent.id,
      toolName: canonicalName,
      revision: options.approval_revision,
      mode: options.approval_mode,
      source: sourceBinding,
      authKind: getToolApprovalAuthKind(definition),
      identity,
    }),
  };
}

function approvalCallKey(
  agentId: string | undefined,
  callId: string,
  executionScope?: string,
): string {
  return JSON.stringify([agentId ?? null, executionScope ?? null, callId]);
}

/** Non-rememberable reviews still retain the executing agent and upstream identity. */
function resolveToolReviewBinding(
  agent: AgentApprovalSource,
  toolName: string,
  scope: ToolApprovalGrantScope,
): ToolApprovalGrantBinding | undefined {
  const grant = resolveAgentToolGrantBinding(agent, toolName, scope);
  if (grant) return grant;
  const definition = agent.toolDefinitions?.find((tool) => tool.name === toolName);
  if (!definition || !getToolReviewAuthority(definition)) return undefined;
  return {
    instanceName: toolName,
    serverName: definition.serverName,
    authKind: getToolApprovalAuthKind(definition),
    oauthEpoch: null,
    agentId: agent.id,
    toolName: getToolApprovalName(definition) ?? toolName,
    scope: 'once',
    canRemember: false,
    unavailable: 'connection',
    binding: digestMCPAuthorityValue({
      ...scope,
      agentId: agent.id,
      toolName,
      identity: getToolApprovalIdentity(definition),
      authority: getToolReviewAuthority(definition),
      authKind: getToolApprovalAuthKind(definition),
      mode: agent.tool_options?.[toolName]?.approval_mode,
      revision: agent.tool_options?.[toolName]?.approval_revision,
    }),
  };
}

export interface AgentToolApprovalSession extends ToolApprovalExecution {
  hook: HookCallback<'PreToolUse'>;
  rememberHook: HookCallback<'PostToolUse'>;
  settleBatchHook: HookCallback<'PostToolBatch'>;
  addAgent: (agent: AgentApprovalSource) => void;
  unavailableFor: (callId: string, toolName: string) => ToolApprovalGrantBinding['unavailable'];
  bindingsFor: (
    payload: Agents.ToolApprovalInterruptPayload,
  ) => Record<string, ToolApprovalGrantBinding>;
}

/** Coalesce parallel lookups at the invocation boundary; do not cache revocable grants. */
export function createAgentToolApprovalSession({
  agents,
  scope,
  storage,
  authorizationStorage = storage,
  lookupTimeoutMs = 3000,
  reviewed,
  policy,
}: {
  lookupTimeoutMs?: number;
  reviewed?: ReviewedToolApprovals;
  policy?: () => TToolApprovalPolicy;
  agents: readonly AgentApprovalSource[];
  scope?: ToolApprovalGrantScope;
  storage?: ToolApprovalGrantStorage;
  authorizationStorage?: Pick<ToolApprovalGrantStorage, 'getToolApprovalGrants'>;
}): AgentToolApprovalSession {
  const owners = new Map(agents.map((agent) => [agent.id, agent]));
  const calls = new Map<string, ToolApprovalGrantBinding | null>();
  const unavailable = new Map<string, ToolApprovalGrantBinding['unavailable']>();
  const reviewedBindings = new Map<string, ToolApprovalGrantBinding>();
  for (const [callId, binding] of Object.entries(reviewed?.bindings ?? {})) {
    reviewedBindings.set(approvalCallKey(binding.agentId, callId, binding.executionScope), binding);
  }
  const approvedDecisions = new Set<string>();
  const permittedDecisions = new Set<string>();
  const legacyDecisions = new Map<string, Agents.ToolApprovalDecisionType>();
  for (const decision of reviewed?.decisions ?? []) {
    const binding = reviewed?.bindings?.[decision.tool_call_id];
    if (!binding) {
      legacyDecisions.set(decision.tool_call_id, decision.decision);
      continue;
    }
    const key = approvalCallKey(binding.agentId, decision.tool_call_id, binding.executionScope);
    if (decision.decision === 'approve') approvedDecisions.add(key);
    if (decision.decision === 'approve' || decision.decision === 'edit')
      permittedDecisions.add(key);
  }
  const callOwners = new Map<string, Set<string>>();
  const proposals = new Map<
    string,
    {
      agentId: string;
      callId: string;
      toolName: string;
      executionScope?: string;
      dispatched: boolean;
      ownership: symbol;
    }
  >();
  const callCandidates = (callId: string, toolName: string): string[] =>
    Array.from(callOwners.get(callId) ?? []).filter(
      (key) => proposals.get(key)?.toolName === toolName && proposals.get(key)?.dispatched !== true,
    );
  const ready = new Map<string, ToolApprovalGrantBinding>();
  const executed = new Set<string>();
  const policyChecks = new Map<string, { agentId: string; toolName: string }>();
  const dispositions = new Map<string, boolean>();
  const transportWitnesses = new Map<
    symbol,
    { consent?: ToolApprovalGrantBinding; automatic: boolean }
  >();
  const retireCall = (key: string, ownership?: symbol, keepTransport = false): void => {
    const proposal = proposals.get(key);
    if (ownership && proposal?.ownership !== ownership) return;
    if (!keepTransport && proposal) transportWitnesses.delete(proposal.ownership);
    if (proposal) {
      const candidates = callOwners.get(proposal.callId);
      candidates?.delete(key);
      if (candidates?.size === 0) callOwners.delete(proposal.callId);
    }
    proposals.delete(key);
    calls.delete(key);
    unavailable.delete(key);
    ready.delete(key);
    executed.delete(key);
    policyChecks.delete(key);
    dispositions.delete(key);
    reviewedBindings.delete(key);
    approvedDecisions.delete(key);
    permittedDecisions.delete(key);
  };
  type GrantStatus = {
    binding: string;
    approved: boolean;
    revocation?: string;
    oauthEpoch?: string | null;
    consentBinding?: string | null;
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
        if (!authorizationStorage || !scope) {
          decline();
          return;
        }
        void authorizationStorage
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
    unavailableFor: (callId, toolName) => {
      const candidates = callCandidates(callId, toolName);
      return candidates.length === 1 ? unavailable.get(candidates[0]) : undefined;
    },
    noteDispatch(invocation) {
      if (!invocation.toolCallId) return;
      const key = approvalCallKey(
        invocation.agentId,
        invocation.toolCallId,
        invocation.executionScope,
      );
      const proposal = proposals.get(key);
      if (invocation.ownership && invocation.ownership !== proposal?.ownership) {
        throw new Error('Tool approval invocation ownership changed. Request approval again.');
      }
      invocation.ownership = proposal?.ownership;
      if (proposal) proposal.dispatched = true;
      dispositions.set(key, invocation.background === true);
      if (invocation.background === true) {
        ready.delete(key);
        executed.delete(key);
      }
    },
    finishDispatch(invocation) {
      if (invocation.background !== true || !invocation.toolCallId || !invocation.ownership) return;
      transportWitnesses.delete(invocation.ownership);
      retireCall(
        approvalCallKey(invocation.agentId, invocation.toolCallId, invocation.executionScope),
        invocation.ownership,
      );
    },
    async settleBatchHook(input) {
      const executionScope = getToolApprovalExecutionScope(input.executionContext);
      for (const entry of input.entries) {
        const key = approvalCallKey(input.executingAgentId, entry.toolUseId, executionScope);
        if (dispositions.get(key) !== true) retireCall(key);
      }
      return {};
    },
    bindingsFor(payload) {
      const result: Record<string, ToolApprovalGrantBinding> = {};
      for (const request of payload.action_requests) {
        const subagent = (
          payload as Agents.ToolApprovalInterruptPayload & {
            subagent?: { agent_id?: string; run_id?: string };
          }
        ).subagent;
        const ownerHint =
          subagent?.agent_id && owners.has(subagent.agent_id) ? subagent.agent_id : undefined;
        const candidates = callCandidates(request.tool_call_id, request.name).filter((key) => {
          const proposal = proposals.get(key)!;
          return (
            (ownerHint == null || proposal.agentId === ownerHint) &&
            (subagent?.run_id == null || proposal.executionScope === subagent.run_id)
          );
        });
        // The SDK binds finalized arguments. Owner/lineage must still identify exactly one call.
        if (candidates.length !== 1) continue;
        const binding = calls.get(candidates[0]);
        if (binding?.instanceName !== request.name) continue;
        const argumentsValue =
          typeof request.arguments === 'object' ? request.arguments : undefined;
        result[request.tool_call_id] =
          argumentsValue?.run_in_background === true
            ? { ...binding, canRemember: false, unavailable: 'background' }
            : binding;
      }
      return result;
    },
    async validateExecution(tool, invocation) {
      const owner = invocation.agentId == null ? undefined : owners.get(invocation.agentId);
      if (
        !owner &&
        (reviewedBindings.size > 0 ||
          Array.from(owners.values()).some((agent) =>
            ['ask', 'chat', 'always'].includes(
              agent.tool_options?.[tool.name]?.approval_mode ?? '',
            ),
          ))
      ) {
        throw new Error('MCP approval requires the executing agent identity.');
      }
      const options = owner?.tool_options?.[tool.name];
      const callId = invocation.toolCallId;
      const key = approvalCallKey(invocation.agentId, callId ?? '', invocation.executionScope);
      if (options?.approval_mode == null) {
        if (reviewedBindings.has(key)) {
          throw new Error(
            'The reviewed tool approval configuration changed. Request approval again.',
          );
        }
        return;
      }
      const check = callId && policyChecks.get(key);
      if (!check || check.agentId !== owner?.id || check.toolName !== tool.name) {
        throw new Error('Tool policy could not be verified. Run this tool in the foreground.');
      }
      const proposal = proposals.get(key);
      if (!proposal || (invocation.ownership && invocation.ownership !== proposal.ownership)) {
        throw new Error('Tool approval invocation ownership changed. Request approval again.');
      }
      invocation.ownership = proposal.ownership;
      const pinTransport = (consent?: ToolApprovalGrantBinding, automatic = false) => {
        if (proposals.get(key)?.ownership !== invocation.ownership) {
          throw new Error('Tool approval invocation ownership changed. Request approval again.');
        }
        proposal.dispatched = true;
        transportWitnesses.set(proposal.ownership, {
          consent: consent && { ...consent },
          automatic,
        });
      };
      policyChecks.delete(key);
      dispositions.set(key, invocation.background === true);
      if (invocation.background === true) {
        ready.delete(key);
        executed.delete(key);
      }
      const initialized = owner?.toolDefinitions?.find(
        (definition) => definition.name === tool.name,
      );
      const expectedIdentity = initialized && getToolApprovalIdentity(initialized);
      const actualIdentity = getToolApprovalIdentity(tool);
      const expectedSource = initialized && getToolApprovalBinding(initialized);
      const expectedAuthority = initialized && getToolReviewAuthority(initialized);
      if (
        (expectedIdentity != null && actualIdentity !== expectedIdentity) ||
        (initialized != null &&
          getToolApprovalAuthKind(tool) !== getToolApprovalAuthKind(initialized)) ||
        (expectedSource != null && getToolApprovalBinding(tool) !== expectedSource) ||
        (expectedAuthority != null && getToolReviewAuthority(tool) !== expectedAuthority)
      ) {
        throw new Error('The advertised MCP tool or connection changed. Retry the run.');
      }
      const baseline = policy
        ? await createToolPolicyHook(mapToolApprovalPolicy(policy()) ?? {})(
            {
              hook_event_name: 'PreToolUse',
              runId: '',
              executingAgentId: owner?.id,
              toolName: tool.name,
              toolInput: {},
              toolUseId: callId ?? '',
            },
            new AbortController().signal,
          )
        : undefined;
      if (baseline?.decision === 'deny') throw new Error('Administrator policy blocks this tool.');
      if (
        options.approval_mode === 'allow' &&
        baseline?.decision !== 'ask' &&
        !reviewedBindings.has(key)
      ) {
        pinTransport(undefined, true);
        return;
      }
      const consent = calls.get(key);
      const current = consent && (await approved(consent));
      if (
        !current ||
        current.available === false ||
        current.oauthEpoch === undefined ||
        current.oauthEpoch !== consent?.oauthEpoch
      ) {
        throw new Error('The MCP OAuth authorization changed. Request approval again.');
      }
      const expected = owner && scope && resolveAgentToolGrantBinding(owner, tool.name, scope);
      if (!expected) {
        if (invocation.background === true) {
          throw new Error(
            'This MCP connection requires foreground review. Run the tool without background execution.',
          );
        }
        // Unresolvable connections cannot learn consent. Only a reviewed SDK call may execute.
        const reviewTarget = owner && scope && resolveToolReviewBinding(owner, tool.name, scope);
        if (callId && reviewTarget && calls.has(key) && permittedDecisions.has(key)) {
          permittedDecisions.delete(key);
          pinTransport(consent ?? undefined);
          return;
        }
        throw new Error('Tool approval is required. Run this tool in the foreground for review.');
      }
      const actual = resolveAgentToolGrantBinding(owner!, tool.name, scope!, tool);
      if (actual?.binding !== expected.binding || !callId) {
        if (callId) ready.delete(key);
        throw new Error('The approved MCP tool or connection changed. Request approval again.');
      }
      const manual = reviewedBindings.get(key);
      if (manual && permittedDecisions.has(key) && manual.binding === actual.binding) {
        permittedDecisions.delete(key);
        if (
          invocation.background !== true &&
          manual.canRemember === true &&
          approvedDecisions.has(key)
        )
          executed.add(key);
        pinTransport(consent ?? undefined);
        return;
      }
      if (expected.scope === 'once' || baseline?.decision === 'ask') {
        throw new Error('Tool approval is required. Run this tool in the foreground for review.');
      }
      if (!current.approved || !storage) {
        ready.delete(key);
        throw new Error('Tool approval is required or was revoked. Request approval again.');
      }
      pinTransport(consent ?? undefined);
    },
    async validateTransport(serverName, oauthEpoch, invocation, checkStorage) {
      const witness = invocation.ownership && transportWitnesses.get(invocation.ownership);
      if (!witness) {
        const key = approvalCallKey(
          invocation.agentId,
          invocation.toolCallId ?? '',
          invocation.executionScope,
        );
        if (invocation.ownership || reviewedBindings.has(key)) {
          throw new Error(
            'Tool approval invocation could not be verified before transport dispatch.',
          );
        }
        return;
      }
      if (witness.automatic) return;
      const consent = witness.consent;
      if (!consent)
        throw new Error('Tool approval consent is unavailable before transport dispatch.');
      if (consent.serverName !== serverName || consent.oauthEpoch !== oauthEpoch) {
        throw new Error(
          'The approved MCP OAuth authorization changed before transport dispatch. Request approval again.',
        );
      }
      if (checkStorage) {
        const current = await approved(consent);
        if (
          current.available === false ||
          current.oauthEpoch === undefined ||
          current.oauthEpoch !== consent.oauthEpoch
        ) {
          throw new Error(
            'The approved MCP OAuth authorization changed before transport retry. Request approval again.',
          );
        }
      }
    },
    async rememberHook(input) {
      const key = approvalCallKey(
        input.executingAgentId,
        input.toolUseId,
        getToolApprovalExecutionScope(input.executionContext),
      );
      // A launch handle is not the detached invocation's successful completion.
      if (dispositions.get(key) === true) return {};
      const ownership = proposals.get(key)?.ownership;
      const grant = ready.get(key);
      try {
        if (
          grant &&
          executed.has(key) &&
          grant.canRemember === true &&
          grant.agentId === input.executingAgentId &&
          grant.instanceName === input.toolName &&
          storage &&
          scope
        ) {
          const current = await approved(grant);
          if (
            current.available !== false &&
            current.oauthEpoch !== undefined &&
            current.oauthEpoch === grant.oauthEpoch &&
            current.revocation === grant.revocation &&
            ((current.consentBinding ?? null) === (grant.consentBinding ?? null) ||
              current.consentBinding === grant.binding)
          ) {
            await storage.rememberToolApprovalGrants(scope, [grant]);
          }
        }
      } catch {
        logger.warn('[Tool approvals] Could not remember approval; future calls require review.');
      } finally {
        retireCall(key, ownership);
      }
      return {};
    },
    async hook(input) {
      const agent = input.executingAgentId == null ? undefined : owners.get(input.executingAgentId);
      const mode = agent?.tool_options?.[input.toolName]?.approval_mode;
      const executionScope = getToolApprovalExecutionScope(input.executionContext);
      const key = approvalCallKey(input.executingAgentId, input.toolUseId, executionScope);
      const previous = proposals.get(key);
      if (previous?.dispatched) retireCall(key, previous.ownership, dispositions.get(key) === true);
      if (!agent || mode == null) {
        if (reviewedBindings.has(key))
          return {
            decision: 'deny',
            reason:
              'The reviewed tool approval configuration changed. Please request approval again.',
          };
        return {};
      }
      const ownership =
        previous?.dispatched === false ? previous.ownership : Symbol('toolInvocation');
      const target = scope && resolveToolReviewBinding(agent, input.toolName, scope);
      const status = target ? await approved(target) : undefined;
      if (target) {
        target.executionScope = executionScope;
        target.oauthEpoch = status?.oauthEpoch;
        target.revocation = status?.revocation;
        target.consentBinding = status?.consentBinding;
      }
      const reviewedBinding = reviewedBindings.get(key);
      if (
        reviewedBinding &&
        (target?.binding !== reviewedBinding.binding ||
          target?.oauthEpoch !== reviewedBinding.oauthEpoch)
      ) {
        return {
          decision: 'deny',
          reason:
            'The reviewed tool or OAuth authorization changed. Please request approval again.',
        };
      }
      // Older owner-less pauses remain usable only for a single known agent.
      if (owners.size === 1 && legacyDecisions.has(input.toolUseId)) {
        const decision = legacyDecisions.get(input.toolUseId);
        legacyDecisions.delete(input.toolUseId);
        if (decision === 'approve' || decision === 'edit') permittedDecisions.add(key);
      }
      if (reviewedBinding && approvedDecisions.has(key) && reviewedBinding.canRemember === true) {
        ready.set(key, reviewedBinding);
      }
      policyChecks.set(key, { agentId: agent.id, toolName: input.toolName });
      const candidates = callOwners.get(input.toolUseId) ?? new Set<string>();
      candidates.add(key);
      callOwners.set(input.toolUseId, candidates);
      proposals.set(key, {
        agentId: agent.id,
        callId: input.toolUseId,
        dispatched: false,
        ownership,
        toolName: input.toolName,
        executionScope,
      });
      if (!target) {
        calls.set(key, null);
        unavailable.set(key, 'connection');
        return { decision: mode === 'allow' ? 'allow' : 'ask' };
      }
      const prior = calls.get(key);
      if (prior && (prior.binding !== target.binding || prior.oauthEpoch !== target.oauthEpoch)) {
        calls.set(key, null);
        return { decision: 'ask' };
      }
      if (status?.available === false || status?.oauthEpoch === undefined) {
        target.canRemember = false;
        target.unavailable = 'storage';
      } else if (!storage) {
        target.canRemember = false;
        target.unavailable = 'disabled';
      }
      if (input.toolInput.run_in_background === true) {
        target.canRemember = false;
        target.unavailable = 'background';
        ready.delete(key);
      }
      calls.set(key, target);
      if (mode === 'allow') return { decision: 'allow' };
      if (mode === 'ask') return { decision: 'ask' };
      return { decision: storage && status?.approved === true ? 'allow' : 'ask' };
    },
  };
}

const sessions = new WeakMap<object, AgentToolApprovalSession>();
export function bindRunToolApprovalSession(
  run: Pick<Run<IState>, 'processStream'>,
  session: AgentToolApprovalSession,
): void {
  if (!sessions.has(run)) {
    const processStream = run.processStream;
    run.processStream = function (...args) {
      const execution = sessions.get(this);
      return execution
        ? withToolApprovalExecution(execution, () => processStream.apply(this, args))
        : processStream.apply(this, args);
    };
  }
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
    review_configs: payload.review_configs.map((config) => {
      const binding = bindings[config.tool_call_id];
      const scope = binding?.scope;
      return {
        ...config,
        remember_scope:
          binding?.canRemember === true && (scope === 'chat' || scope === 'always')
            ? scope
            : undefined,
        remember_unavailable:
          binding?.unavailable ??
          (run
            ? sessions.get(run)?.unavailableFor(config.tool_call_id, config.action_name)
            : undefined),
      };
    }),
  };
}

export interface ReviewedToolApprovals {
  bindings?: Record<string, ToolApprovalGrantBinding>;
  decisions: readonly Agents.ToolApprovalResolution[];
}

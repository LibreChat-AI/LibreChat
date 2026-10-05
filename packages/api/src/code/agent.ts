import { Tools } from 'librechat-data-provider';
import type { Agent, StatefulCodeEnvironment } from 'librechat-data-provider';
import type { IConversation } from '@librechat/data-schemas';
import type { CodeEnvironmentConfig, CodeExecutionContext } from '~/agents/execution';
import type { RequestBody, ServerRequest } from '~/types';
import {
  resolveCodeExecutionContext,
  normalizeStatefulCodeEnvironment,
  resolveCodeExecutionWorkspaceSelections,
} from '~/agents/execution';
import { createStatefulCodeEnvironmentPolicyError } from '~/agents/errors';
import { isImplicitStatefulCodeRouteAvailable } from './config';

/** The saved agent fields that decide where an agent runs code. */
export type AgentCodeRouteAgent = Partial<
  Pick<
    Agent,
    | 'id'
    | 'tools'
    | 'stateful_code_sessions'
    | 'stateful_code_environment'
    | 'code_environment_id'
    | 'code_environment_ids'
  >
>;

/** A request body carrying the conversation's admitted code environment decision. */
export type CodeEnvironmentDecisionCarrier = Pick<
  RequestBody,
  'codeEnvironmentMode' | 'codeWorkspaces'
>;

/** Whether the conversation chose to run without attached machines ("No workspace"). */
export function runsWithoutAttachedCodeEnvironments(
  requestBody: CodeEnvironmentDecisionCarrier | null | undefined,
): boolean {
  return requestBody?.codeEnvironmentMode === 'without_attached';
}

/** Returns true when a conversation-level choice disables an attached environment. */
export function optsOutOfAttachedCodeEnvironment(
  agent: AgentCodeRouteAgent | null | undefined,
  requestBody: CodeEnvironmentDecisionCarrier | null | undefined,
  environments: readonly CodeEnvironmentConfig[] | undefined,
  implicitStatefulRouteAvailable = false,
): boolean {
  if (agent == null || !runsWithoutAttachedCodeEnvironments(requestBody)) return false;
  const configured = agent.code_environment_id
    ? environments?.find(({ id }) => id === agent.code_environment_id)
    : environments?.find(({ default: isDefault }) => isDefault === true);
  return (
    agent.stateful_code_sessions === true &&
    (configured?.type === 'attached' ||
      (configured == null &&
        (Boolean(agent.code_environment_id) || !implicitStatefulRouteAvailable)))
  );
}

export interface AgentCodeFlagsParams {
  /** The executing agent; a missing agent runs no agent-scoped code. */
  agent?: AgentCodeRouteAgent | null;
  /** Normalized request body; its `codeEnvironmentMode` is the conversation's decision. */
  requestBody?: CodeEnvironmentDecisionCarrier | null;
  /** Deployment `execute_code` capability AND the principal's run-code grant. */
  codeExecutionAvailable: boolean;
  /** Deployment `stateful_code_sessions` capability. */
  statefulSessionsAvailable: boolean;
  /** The requesting principal's tenant-scoped machine list. */
  environments?: readonly CodeEnvironmentConfig[];
  /** Enforced when present: a stateful agent outside this list is refused. */
  allowedStatefulCodeEnvironments?: readonly StatefulCodeEnvironment[];
  /** Whether the deployment's versioned implicit stateful route is live. */
  implicitStatefulRouteAvailable?: boolean;
  /**
   * The opt-out initialization already decided for this agent. A caller that only holds a
   * partial agent record (a tool loader) passes it so the decision is never lost; the rule
   * can add an opt-out but never clears one.
   */
  attachedEnvironmentOptOut?: boolean;
}

export interface AgentCodeFlags {
  /** The conversation's "No workspace" decision removed this agent's attached machine. */
  attachedEnvironmentOptOut: boolean;
  /** The agent gets code tools this request. */
  codeEnvAvailable: boolean;
  /** The agent runs stateful code sessions this request. */
  statefulSessions: boolean;
  statefulCodeEnvironment: StatefulCodeEnvironment;
}

/**
 * The single per-agent code rule. A conversation that chose to run without attached
 * machines turns off code for an agent whose default is an attached machine (or an
 * unresolvable stateful route), so it is never routed to that machine and never needs
 * a workspace selection, whichever path (request start, a subagent, a graph member, or
 * an execution-time tool load) asks.
 */
export function resolveAgentCodeFlags(params: AgentCodeFlagsParams): AgentCodeFlags {
  const { agent } = params;
  const attachedEnvironmentOptOut =
    params.attachedEnvironmentOptOut === true ||
    optsOutOfAttachedCodeEnvironment(
      agent,
      params.requestBody,
      params.environments,
      params.implicitStatefulRouteAvailable === true,
    );
  const codeEnvAvailable =
    params.codeExecutionAvailable &&
    agent?.tools?.includes(Tools.execute_code) === true &&
    !attachedEnvironmentOptOut;
  const statefulSessions =
    codeEnvAvailable && params.statefulSessionsAvailable && agent?.stateful_code_sessions === true;
  const statefulCodeEnvironment = normalizeStatefulCodeEnvironment(
    agent?.stateful_code_environment,
  );
  if (
    statefulSessions &&
    params.allowedStatefulCodeEnvironments != null &&
    !params.allowedStatefulCodeEnvironments.includes(statefulCodeEnvironment)
  ) {
    throw createStatefulCodeEnvironmentPolicyError(statefulCodeEnvironment);
  }
  return { attachedEnvironmentOptOut, codeEnvAvailable, statefulSessions, statefulCodeEnvironment };
}

export interface AgentCodeExecutionParams extends AgentCodeFlagsParams {
  /** The admitted conversation; its sealed workspace selections win over the request. */
  conversation?: Pick<Partial<IConversation>, 'codeWorkspaces'> | null;
  /** Deployment ceiling for per-chat machine selection. */
  allowEnvironmentSelection?: boolean;
  /** Request-scoped subagent inheritance, keyed by saved agent ID. */
  inheritedEnvironments?: ReadonlyMap<string, string>;
  userId?: string | null;
  conversationId?: string | null;
  /** A context initialization already resolved for this agent under this rule. */
  resolvedContext?: CodeExecutionContext;
}

export interface AgentCodeExecution extends AgentCodeFlags {
  /** Base route; bind its workspace with `resolveCodeExecutionWorkspaceContext`. */
  context: CodeExecutionContext;
}

/**
 * Resolves an agent's code flags and base route under {@link resolveAgentCodeFlags}.
 * Every resolver of an agent's code route goes through here; an opted-out agent lands
 * on the managed default route, which workspace binding passes through unchanged.
 */
export function resolveAgentCodeExecution(params: AgentCodeExecutionParams): AgentCodeExecution {
  const flags = resolveAgentCodeFlags(params);
  if (params.resolvedContext != null) {
    return { ...flags, context: params.resolvedContext };
  }
  const { agent, requestBody } = params;
  const context = resolveCodeExecutionContext({
    statefulSessions: flags.statefulSessions,
    environment: flags.statefulCodeEnvironment,
    environmentId: agent?.code_environment_id,
    environmentIds: agent?.code_environment_ids,
    allowEnvironmentSelection: params.allowEnvironmentSelection,
    workspaceSelections: resolveCodeExecutionWorkspaceSelections({
      conversation: params.conversation,
      request: requestBody,
    }),
    inheritedEnvironments: params.inheritedEnvironments,
    environments: params.environments,
    userId: params.userId,
    agentId: agent?.id,
    conversationId: params.conversationId,
  });
  return { ...flags, context };
}

export type RequestAgentCodeExecutionParams = Omit<
  AgentCodeExecutionParams,
  | 'conversation'
  | 'allowEnvironmentSelection'
  | 'inheritedEnvironments'
  | 'environments'
  | 'implicitStatefulRouteAvailable'
> & {
  /** The authenticated request whose admitted conversation, config and principal apply. */
  req: Pick<
    ServerRequest,
    'body' | 'user' | 'config' | 'resolvedConversation' | 'codeWorkspaceInheritance'
  >;
};

/**
 * Fills the request-scoped inputs of the per-agent code rule from an authenticated request:
 * its admitted conversation, principal-scoped machines and inheritance, and the deployment's
 * implicit stateful route rollout.
 */
export function withRequestCodeInputs({
  req,
  ...params
}: RequestAgentCodeExecutionParams): AgentCodeExecutionParams {
  const statefulCodeSessions = req.config?.endpoints?.agents?.statefulCodeSessions;
  return {
    ...params,
    requestBody: params.requestBody ?? req.body,
    conversation: req.resolvedConversation,
    allowEnvironmentSelection: statefulCodeSessions?.allowEnvironmentSelection,
    inheritedEnvironments: req.codeWorkspaceInheritance,
    environments: statefulCodeSessions?.environments,
    userId: params.userId ?? req.user?.id,
    implicitStatefulRouteAvailable: isImplicitStatefulCodeRouteAvailable(
      process.env.CODE_ENVIRONMENT_DECISION_VERSION,
      process.env.LIBRECHAT_CODE_BASEURL_STATEFUL,
    ),
  };
}

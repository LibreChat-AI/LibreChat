import * as agentsSdk from '@librechat/agents';
import { isCodeWorkspaceSelections, stripAgentIdSuffix } from 'librechat-data-provider';
import type {
  CodeWorkspaceSelection,
  StatefulCodeEnvironment,
  CodeWorkspaceSelectionErrorReason,
} from 'librechat-data-provider';
import type { SubagentExecutionContext } from '@librechat/agents';
import type { CodeEnvironmentConfig, CodeExecutionContext } from '~/agents/execution';
import type { CodeCapabilityConfigLoader } from './capabilities';
import {
  resolveCodeExecutionContext,
  isExecutableAttachedEnvironment,
  resolveAgentCodeEnvironmentRouting,
} from '~/agents/execution';
import { CodeWorkspaceSelectionError, describeCodeWorkspaceUnavailableSubagent } from './errors';
import { resolveCodeExecutionWorkspaceContext } from './capabilities';
import { guardUnavailableSubagent } from '~/agents/lazySubagents';
import { isCodeEnvironmentSelectionEnabled } from './protocol';

/** Subagent call property naming the attached machine the child runs on. */
export const SUBAGENT_MACHINE_ARG = 'machine';
/** Subagent call property naming the workspace the child opens on that machine. */
export const SUBAGENT_WORKSPACE_ARG = 'workspace';

const MACHINE_DESCRIPTION =
  'ID of the attached code machine the subagent runs on. Pass the machine your own workspace tools use when the subagent must see the same files; omit it to let the subagent use its default placement.';
const WORKSPACE_DESCRIPTION =
  'ID of the workspace the subagent opens. Each machine has one workspace in this conversation, so this is an alternative to machine; when both are passed they must belong together.';

/**
 * Host argument declaration accepted by `@librechat/agents` subagent configs
 * (`SubagentConfig.hostArgs`, added after 4.0.2). Declared locally so this
 * package typechecks against older SDKs, which ignore the field.
 */
export interface SubagentCodeHostArgSpec {
  description: string;
  enum: string[];
}

export type SubagentCodeHostArgSpecs = Record<string, SubagentCodeHostArgSpec>;

/** Validated per-call host argument values delivered to a lazy resolver. */
export type SubagentHostArgValues = Readonly<Record<string, string>>;

type HostArgumentRejection = 'unavailable' | 'not_allowed';
type HostArgumentErrorConstructor = new (
  argument: string,
  rejection: HostArgumentRejection,
) => Error;

function getHostArgumentErrorConstructor(): HostArgumentErrorConstructor | undefined {
  const candidate = (agentsSdk as { SubagentHostArgumentError?: HostArgumentErrorConstructor })
    .SubagentHostArgumentError;
  return typeof candidate === 'function' ? candidate : undefined;
}

/** Whether the installed SDK accepts per-call subagent host arguments. */
export function isSubagentHostArgsSupported(): boolean {
  return getHostArgumentErrorConstructor() != null;
}

/**
 * A refusal the SDK turns into a fixed, model-visible message naming the
 * argument. The value and the reason detail never reach the model.
 */
export function createSubagentHostArgumentError(
  argument: string,
  rejection: HostArgumentRejection,
): Error {
  const HostArgumentError = getHostArgumentErrorConstructor();
  return HostArgumentError == null
    ? new Error(`Subagent host argument "${argument}" was rejected.`)
    : new HostArgumentError(argument, rejection);
}

/** Reads the host argument values the SDK attached to a resolver call. */
export function getSubagentHostArgValues(
  context: object | null | undefined,
): SubagentHostArgValues | undefined {
  const values = (context as { hostArgs?: unknown } | null | undefined)?.hostArgs;
  if (values == null || typeof values !== 'object' || Array.isArray(values)) {
    return undefined;
  }
  const entries = Object.entries(values).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/** One reachable machine for a subagent, with its fully resolved live route. */
export interface SubagentCodeTarget {
  environmentId: string;
  workspaceId: string;
  context: CodeExecutionContext;
}

export interface SubagentCodeTargets {
  targets: SubagentCodeTarget[];
  /** Authorized machines whose worker or workspace failed live checks. */
  unavailableMachines: ReadonlySet<string>;
  /** Workspaces of those machines. */
  unavailableWorkspaces: ReadonlySet<string>;
}

export interface SubagentCodeTargetParams {
  agentId: string;
  /** Whether this child runs stateful code sessions at all in this request. */
  statefulSessions: boolean;
  environment?: StatefulCodeEnvironment | string | null;
  /** The child's saved default machine. */
  environmentId?: string | null;
  /** The child's saved machine allowlist. */
  environmentIds?: readonly string[];
  allowEnvironmentSelection?: boolean;
  /** The conversation's sealed decision; authoritative over the request. */
  persistedSelections?: unknown;
  requestedSelections?: unknown;
  /** The requesting principal's tenant-scoped machine list. */
  environments?: readonly CodeEnvironmentConfig[];
  userId?: string | null;
  conversationId?: string | null;
  getAppConfig?: CodeCapabilityConfigLoader;
}

const NO_TARGETS: SubagentCodeTargets = Object.freeze({
  targets: [],
  unavailableMachines: new Set<string>(),
  unavailableWorkspaces: new Set<string>(),
});

function getDefaultEnvironmentId(params: SubagentCodeTargetParams): string | undefined {
  return (
    params.environmentId ??
    resolveAgentCodeEnvironmentRouting({ environments: params.environments }).defaultEnvironment?.id
  );
}

/**
 * Admitted selections this child may be routed to: its own sealed choice when
 * the conversation pinned one to it, otherwise every admitted machine that is
 * its default or on its allowlist and that the principal can use.
 */
function getAuthorizedSelections(
  params: SubagentCodeTargetParams,
  selections: CodeWorkspaceSelection[],
): CodeWorkspaceSelection[] {
  const stableAgentId = stripAgentIdSuffix(params.agentId);
  const owned = selections.find((selection) => selection.agentIds?.includes(stableAgentId));
  const pool = owned == null ? selections : [owned];
  const defaultId = getDefaultEnvironmentId(params);
  const allowlist = isCodeEnvironmentSelectionEnabled(params.allowEnvironmentSelection)
    ? new Set(params.environmentIds ?? [])
    : new Set<string>();
  return pool.filter(
    ({ environmentId }) =>
      (environmentId === defaultId || allowlist.has(environmentId)) &&
      isExecutableAttachedEnvironment(environmentId, params.environments),
  );
}

type CandidateResult =
  | { status: 'ready'; target: SubagentCodeTarget }
  | { status: 'unavailable'; selection: CodeWorkspaceSelection }
  | { status: 'unauthorized' };

async function resolveCandidate(
  params: SubagentCodeTargetParams,
  selections: CodeWorkspaceSelection[],
  selection: CodeWorkspaceSelection,
): Promise<CandidateResult> {
  let base: CodeExecutionContext;
  try {
    base = resolveCodeExecutionContext({
      statefulSessions: true,
      environment: params.environment,
      environmentId: selection.environmentId,
      environmentIds: params.environmentIds,
      allowEnvironmentSelection: params.allowEnvironmentSelection,
      workspaceSelections: selections,
      environments: params.environments,
      userId: params.userId,
      agentId: params.agentId,
      conversationId: params.conversationId,
    });
  } catch {
    return { status: 'unauthorized' };
  }
  if (base.environmentId !== selection.environmentId || base.environmentType !== 'attached') {
    return { status: 'unauthorized' };
  }
  try {
    const context = await resolveCodeExecutionWorkspaceContext({
      context: base,
      requestedSelections: params.requestedSelections,
      persistedSelections: params.persistedSelections,
      environments: params.environments,
      getAppConfig: params.getAppConfig,
    });
    if (context.codeWorkspace?.workspaceId !== selection.workspaceId) {
      return { status: 'unavailable', selection };
    }
    return {
      status: 'ready',
      target: {
        environmentId: selection.environmentId,
        workspaceId: selection.workspaceId,
        context,
      },
    };
  } catch {
    return { status: 'unavailable', selection };
  }
}

/**
 * Lists the machines a parent may route this child to: admitted in the
 * conversation's sealed decision, reachable by the requesting principal, on
 * the child's default or allowlist, and live on a ready worker. Never adds a
 * machine the conversation has not admitted.
 */
export async function resolveSubagentCodeTargets(
  params: SubagentCodeTargetParams,
): Promise<SubagentCodeTargets> {
  if (!params.statefulSessions) {
    return NO_TARGETS;
  }
  const selections = params.persistedSelections ?? params.requestedSelections;
  if (!isCodeWorkspaceSelections(selections) || selections.length === 0) {
    return NO_TARGETS;
  }
  const authorized = getAuthorizedSelections(params, selections);
  if (authorized.length === 0) {
    return NO_TARGETS;
  }
  const results = await Promise.all(
    authorized.map((selection) => resolveCandidate(params, selections, selection)),
  );
  const targets: SubagentCodeTarget[] = [];
  const unavailableMachines = new Set<string>();
  const unavailableWorkspaces = new Set<string>();
  for (const result of results) {
    if (result.status === 'ready') {
      targets.push(result.target);
    } else if (result.status === 'unavailable') {
      unavailableMachines.add(result.selection.environmentId);
      unavailableWorkspaces.add(result.selection.workspaceId);
    }
  }
  targets.sort((left, right) => (left.environmentId < right.environmentId ? -1 : 1));
  return { targets, unavailableMachines, unavailableWorkspaces };
}

/**
 * Declares `machine` (and `workspace` when each machine's workspace is
 * distinct) as enums of exactly the reachable targets. Returns nothing when
 * the child has no reachable machine, leaving its call schema unchanged.
 */
export function buildSubagentCodeHostArgs(
  targets: readonly SubagentCodeTarget[],
): SubagentCodeHostArgSpecs | undefined {
  if (targets.length === 0) {
    return undefined;
  }
  const workspaces = targets.map((target) => target.workspaceId);
  const distinctWorkspaces = new Set(workspaces).size === workspaces.length;
  return {
    [SUBAGENT_MACHINE_ARG]: {
      description: MACHINE_DESCRIPTION,
      enum: targets.map((target) => target.environmentId),
    },
    ...(distinctWorkspaces
      ? { [SUBAGENT_WORKSPACE_ARG]: { description: WORKSPACE_DESCRIPTION, enum: workspaces } }
      : {}),
  };
}

/**
 * Picks the target a call asked for, or `undefined` when it asked for none.
 * Throws an SDK host-argument refusal for anything not currently reachable,
 * so the parent sees which argument failed instead of a silent fallback.
 */
export function selectSubagentCodeTarget(
  hostArgs: SubagentHostArgValues | undefined,
  resolution: SubagentCodeTargets,
): SubagentCodeTarget | undefined {
  const machine = hostArgs?.[SUBAGENT_MACHINE_ARG];
  const workspace = hostArgs?.[SUBAGENT_WORKSPACE_ARG];
  if (machine == null && workspace == null) {
    return undefined;
  }
  if (machine != null) {
    const target = resolution.targets.find((candidate) => candidate.environmentId === machine);
    if (target == null) {
      throw createSubagentHostArgumentError(
        SUBAGENT_MACHINE_ARG,
        resolution.unavailableMachines.has(machine) ? 'unavailable' : 'not_allowed',
      );
    }
    if (workspace != null && target.workspaceId !== workspace) {
      throw createSubagentHostArgumentError(SUBAGENT_WORKSPACE_ARG, 'not_allowed');
    }
    return target;
  }
  const matches = resolution.targets.filter((candidate) => candidate.workspaceId === workspace);
  if (matches.length === 1) {
    return matches[0];
  }
  throw createSubagentHostArgumentError(
    SUBAGENT_WORKSPACE_ARG,
    matches.length === 0 && workspace != null && resolution.unavailableWorkspaces.has(workspace)
      ? 'unavailable'
      : 'not_allowed',
  );
}

/**
 * Routes a child agent document to the selected machine without mutating it.
 * The machine becomes its default and its only allowlisted choice, so neither
 * parent inheritance nor another admitted selection can move it elsewhere at
 * any routing site that reads this document.
 */
export function placeSubagentOnCodeTarget<
  T extends { code_environment_id?: string | null; code_environment_ids?: string[] | null },
>(agent: T, target: Pick<SubagentCodeTarget, 'environmentId'>): T {
  return {
    ...agent,
    code_environment_id: target.environmentId,
    code_environment_ids: [target.environmentId],
  };
}

/** Fails closed when initialization did not land on the selected route. */
export function assertSubagentCodePlacement(
  context: Pick<CodeExecutionContext, 'environmentId'> | null | undefined,
  target: Pick<SubagentCodeTarget, 'environmentId'>,
): void {
  if (context?.environmentId !== target.environmentId) {
    throw createSubagentHostArgumentError(SUBAGENT_MACHINE_ARG, 'unavailable');
  }
}

/**
 * Lists a lazy subagent whose default machine has no usable workspace. Without
 * per-call choices it stays guarded exactly as before; with them its resolver
 * stays live, the description tells the parent to pick a listed machine, and
 * `SubagentCodeRouting.place` still refuses a call that names none.
 */
export function guardRoutableSubagent<TContext, TConfig>({
  description,
  codeWorkspaceUnavailable,
  subagentHostArgs,
  resolve,
}: {
  description?: string;
  codeWorkspaceUnavailable?: CodeWorkspaceSelectionErrorReason;
  subagentHostArgs?: SubagentCodeHostArgSpecs;
  resolve: (context: TContext) => Promise<TConfig>;
}): { description?: string; resolve: (context: TContext) => Promise<TConfig> } {
  if (!codeWorkspaceUnavailable || subagentHostArgs == null) {
    return guardUnavailableSubagent({ description, codeWorkspaceUnavailable, resolve });
  }
  return {
    description: `${describeCodeWorkspaceUnavailableSubagent(
      description,
      codeWorkspaceUnavailable,
    )} Pass "${SUBAGENT_MACHINE_ARG}" to run it on one of its listed machines.`,
    resolve,
  };
}

/** The saved child fields that decide its code route. */
export interface SubagentCodeAgent {
  id: string;
  code_environment_id?: string | null;
  code_environment_ids?: string[] | null;
}

/** Child code flags the host already resolved for this request. */
export interface SubagentCodeFlags {
  statefulCodeSessions?: boolean;
  statefulCodeEnvironment?: StatefulCodeEnvironment | string | null;
}

/** Request-level inputs shared by every child of one parent request. */
export type SubagentCodeRequest = Omit<
  SubagentCodeTargetParams,
  'agentId' | 'statefulSessions' | 'environment' | 'environmentId' | 'environmentIds'
>;

export interface SubagentCodeDescription {
  /** `SubagentConfig.hostArgs` for the child's lazy descriptor. */
  subagentHostArgs?: SubagentCodeHostArgSpecs;
  /** Alternate routes covered by paused-approval bindings. */
  codeExecutionChoices?: CodeExecutionContext[];
}

export interface SubagentCodePlacement<T extends SubagentCodeAgent> {
  agent: T;
  /** The machine this execution was routed to per call. */
  target?: SubagentCodeTarget;
  /** The per-call route this execution's own subagents inherit. */
  childEnvironmentId?: string;
}

/** The parts of an SDK resolver context that routing reads. */
export interface SubagentCodeCallContext {
  /** This child execution; its own subagents name it as their `parentRunId`. */
  executionId?: string;
  parentRunId?: string;
  hostArgs?: SubagentHostArgValues;
  /** Cancels this call; a canceled call never claims a machine. */
  signal?: AbortSignal;
}

/** What one lazy child resolution needs to know about its call and parent. */
export interface SubagentCodePlacementInput<T extends SubagentCodeAgent> {
  agent: T;
  flags: SubagentCodeFlags;
  /** The SDK resolver context; graph members initialized outside a call pass only a signal. */
  context?: SubagentCodeCallContext | null;
  /** Why the child's default route is unusable this request, if it is. */
  unavailableReason?: CodeWorkspaceSelectionErrorReason;
}

/**
 * Request-scoped routing for subagents a parent may place per call. Owns the
 * per-execution state, so the legacy initializer only wires it in.
 */
export interface SubagentCodeRouting<TContext> {
  /** Builds a child's per-call machine choices; empty on SDKs without host arguments. */
  describe(agent: SubagentCodeAgent, flags: SubagentCodeFlags): Promise<SubagentCodeDescription>;
  /**
   * Routes one child execution: an explicit call choice (re-validated against
   * the current request), else the machine a per-call-routed parent runs on
   * when this child may reach it, else the child's default route. A child whose
   * default route is unavailable is refused unless one of those applies.
   */
  place<T extends SubagentCodeAgent>(
    input: SubagentCodePlacementInput<T>,
  ): Promise<SubagentCodePlacement<T>>;
  /**
   * Stores a resolved child's tool context. A routed child is kept per
   * execution and only seeds the per-agent entry when none exists, so it never
   * replaces the route a default-placed sibling is using.
   */
  attach<T extends SubagentCodeAgent>(
    contexts: Map<string, TContext>,
    input: {
      agentId: string;
      context?: Pick<SubagentCodeCallContext, 'executionId'> | null;
      placement: SubagentCodePlacement<T>;
      codeExecutionContext?: Pick<CodeExecutionContext, 'environmentId'> | null;
      toolContext: TContext;
    },
  ): void;
  /** The routed tool context for the executing child, if it was routed per call. */
  getToolContext(
    agentId: string | null | undefined,
    executionContext: SubagentExecutionContext | null | undefined,
  ): TContext | undefined;
  /** Whether an execution was routed per call (its config must not be shared). */
  isRouted(executionId: string | null | undefined): boolean;
  /** Whether an execution's own subagents (including graph members) inherit a per-call route. */
  routesChildren(executionId: string | null | undefined): boolean;
}

function throwIfCanceled(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw signal.reason ?? new Error('Subagent resolution was aborted.');
  }
}

export function createSubagentCodeRouting<TContext>({
  getInheritedEnvironments,
  ...request
}: SubagentCodeRequest & {
  /** Request-scoped parent inheritance (#16756), read when a default route is reserved. */
  getInheritedEnvironments?: () => ReadonlyMap<string, string> | undefined;
}): SubagentCodeRouting<TContext> {
  const routedContexts = new Map<string, { agentId: string; toolContext: TContext }>();
  const childRoutes = new Map<string, string>();
  /**
   * One machine per subagent per request, as with parent inheritance: run-wide
   * state such as the attached-machine permission policy is keyed by agent, so
   * no call may move a subagent off the machine an earlier call settled on.
   */
  const routeByAgent = new Map<string, { environmentId: string | null; routed: boolean }>();
  const conflicts = (agentId: string, environmentId: string | null): boolean => {
    const claimed = routeByAgent.get(agentId);
    return claimed != null && claimed.environmentId !== environmentId;
  };
  const paramsFor = (
    agent: SubagentCodeAgent,
    flags: SubagentCodeFlags,
  ): SubagentCodeTargetParams => ({
    ...request,
    agentId: agent.id,
    statefulSessions: flags.statefulCodeSessions === true,
    environment: flags.statefulCodeEnvironment,
    environmentId: agent.code_environment_id,
    environmentIds: agent.code_environment_ids ?? undefined,
  });
  /** The machine a call that names none lands on, as `initializeAgent` will resolve it. */
  const defaultRouteOf = (agent: SubagentCodeAgent, flags: SubagentCodeFlags): string | null => {
    try {
      const context = resolveCodeExecutionContext({
        statefulSessions: true,
        environment: flags.statefulCodeEnvironment,
        environmentId: agent.code_environment_id,
        environmentIds: agent.code_environment_ids ?? undefined,
        allowEnvironmentSelection: request.allowEnvironmentSelection,
        workspaceSelections: request.persistedSelections ?? request.requestedSelections,
        inheritedEnvironments: getInheritedEnvironments?.(),
        environments: request.environments,
        userId: request.userId,
        agentId: agent.id,
        conversationId: request.conversationId,
      });
      return context.environmentType === 'attached' ? (context.environmentId ?? null) : null;
    } catch {
      return null;
    }
  };
  const routeTo = <T extends SubagentCodeAgent>(
    agent: T,
    target: SubagentCodeTarget,
  ): SubagentCodePlacement<T> => {
    routeByAgent.set(agent.id, { environmentId: target.environmentId, routed: true });
    return {
      agent: placeSubagentOnCodeTarget(agent, target),
      target,
      childEnvironmentId: target.environmentId,
    };
  };
  /** The machine an omitted call should follow: this subagent's earlier per-call
   * route, else its routed parent's machine unless that would move it. */
  const inheritedRoute = (agentId: string, parentEnvironmentId?: string): string | undefined => {
    const claimed = routeByAgent.get(agentId);
    if (claimed?.routed === true && claimed.environmentId != null) {
      return claimed.environmentId;
    }
    if (parentEnvironmentId == null || conflicts(agentId, parentEnvironmentId)) {
      return undefined;
    }
    return parentEnvironmentId;
  };
  return {
    async describe(agent, flags) {
      if (!isSubagentHostArgsSupported() || flags.statefulCodeSessions !== true) {
        return {};
      }
      const { targets } = await resolveSubagentCodeTargets(paramsFor(agent, flags));
      const subagentHostArgs = buildSubagentCodeHostArgs(targets);
      return subagentHostArgs == null
        ? {}
        : { subagentHostArgs, codeExecutionChoices: targets.map((target) => target.context) };
    },
    async place({ agent, flags, context, unavailableReason }) {
      const hostArgs = getSubagentHostArgValues(context);
      const parentEnvironmentId = context?.parentRunId
        ? childRoutes.get(context.parentRunId)
        : undefined;
      const requested =
        hostArgs?.[SUBAGENT_MACHINE_ARG] != null || hostArgs?.[SUBAGENT_WORKSPACE_ARG] != null;
      if (requested) {
        const resolution = await resolveSubagentCodeTargets(paramsFor(agent, flags));
        throwIfCanceled(context?.signal);
        const target = selectSubagentCodeTarget(hostArgs, resolution);
        if (target != null) {
          if (conflicts(agent.id, target.environmentId)) {
            throw createSubagentHostArgumentError(
              hostArgs?.[SUBAGENT_MACHINE_ARG] != null
                ? SUBAGENT_MACHINE_ARG
                : SUBAGENT_WORKSPACE_ARG,
              'unavailable',
            );
          }
          return routeTo(agent, target);
        }
      }
      if (flags.statefulCodeSessions !== true) {
        /** An agent that runs no stateful code passes its parent's machine on. */
        return parentEnvironmentId == null
          ? { agent }
          : { agent, childEnvironmentId: parentEnvironmentId };
      }
      if (inheritedRoute(agent.id, parentEnvironmentId) != null) {
        const { targets } = await resolveSubagentCodeTargets(paramsFor(agent, flags));
        throwIfCanceled(context?.signal);
        /** Re-read after the await: a concurrent call may have settled this subagent meanwhile. */
        const inherited = inheritedRoute(agent.id, parentEnvironmentId);
        const target =
          inherited == null
            ? undefined
            : targets.find((candidate) => candidate.environmentId === inherited);
        if (target != null) {
          return routeTo(agent, target);
        }
        if (routeByAgent.get(agent.id)?.routed === true) {
          throw createSubagentHostArgumentError(SUBAGENT_MACHINE_ARG, 'unavailable');
        }
      }
      if (unavailableReason != null) {
        throw new CodeWorkspaceSelectionError(unavailableReason);
      }
      /** Reserved now, not after initialization, so a concurrent call cannot claim another machine. */
      if (!routeByAgent.has(agent.id)) {
        routeByAgent.set(agent.id, { environmentId: defaultRouteOf(agent, flags), routed: false });
      }
      return { agent };
    },
    routesChildren(executionId) {
      return executionId != null && childRoutes.has(executionId);
    },
    attach(contexts, { agentId, context, placement, codeExecutionContext, toolContext }) {
      const executionId = context?.executionId;
      if (placement.target != null) {
        assertSubagentCodePlacement(codeExecutionContext, placement.target);
      }
      if (executionId && placement.childEnvironmentId != null) {
        childRoutes.set(executionId, placement.childEnvironmentId);
      }
      if (placement.target == null && !routeByAgent.has(agentId)) {
        routeByAgent.set(agentId, {
          environmentId: codeExecutionContext?.environmentId ?? null,
          routed: false,
        });
      }
      if (placement.target == null || !executionId) {
        contexts.set(agentId, toolContext);
        return;
      }
      routedContexts.set(executionId, { agentId, toolContext });
      if (!contexts.has(agentId)) {
        contexts.set(agentId, toolContext);
      }
    },
    getToolContext(agentId, executionContext) {
      if (!agentId || routedContexts.size === 0) {
        return undefined;
      }
      const ancestry = executionContext?.ancestry ?? [];
      for (let index = ancestry.length - 1; index >= 0; index--) {
        const entry = ancestry[index];
        if (entry.subagentAgentId !== agentId) {
          continue;
        }
        const routed = routedContexts.get(entry.subagentRunId);
        return routed?.agentId === agentId ? routed.toolContext : undefined;
      }
      return undefined;
    },
    isRouted(executionId) {
      return executionId != null && routedContexts.has(executionId);
    },
  };
}

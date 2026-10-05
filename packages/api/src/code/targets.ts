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
import { createConcurrencyLimiter } from '~/utils/promise';

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
  /** Cancels the resolution; probes still queued are skipped. */
  signal?: AbortSignal;
}

/**
 * Live target probes run through the process-wide worker status poller, which
 * refuses requests past its own concurrency ceiling; queue them well below it so
 * concurrent descriptors never misreport a healthy machine as unavailable.
 */
const SUBAGENT_TARGET_PROBE_CONCURRENCY = 8;
const probeTarget = createConcurrencyLimiter(SUBAGENT_TARGET_PROBE_CONCURRENCY);

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
    authorized.map((selection) =>
      probeTarget(() =>
        params.signal?.aborted === true
          ? Promise.resolve<CandidateResult>({ status: 'unauthorized' })
          : resolveCandidate(params, selections, selection),
      ),
    ),
  );
  throwIfCanceled(params.signal);
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
  /** The agent that dispatched this call; read when its run was never placed (a self-spawn). */
  parentAgentId?: string;
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
  describe(
    agent: SubagentCodeAgent,
    flags: SubagentCodeFlags,
    signal?: AbortSignal,
  ): Promise<SubagentCodeDescription>;
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
      context?: Pick<SubagentCodeCallContext, 'executionId' | 'parentRunId'> | null;
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
  /**
   * Awaits a placed child's initialization. A failed initialization gives back
   * the machine its placement reserved unless another execution still holds it.
   */
  settle<T extends SubagentCodeAgent, TConfig>(
    placement: SubagentCodePlacement<T>,
    initialization: Promise<TConfig>,
  ): Promise<TConfig>;
  /**
   * Runs one lazy child's whole resolution, through to the inputs handed to the SDK.
   * The routes and per-agent tool contexts it and its graph members hold become
   * permanent only when it succeeds (then `onCommit` publishes the caller's own
   * state); when it fails they are given back unless another execution holds them.
   */
  settleExecution<TConfig>(
    context: Pick<SubagentCodeCallContext, 'executionId'> | null | undefined,
    resolve: () => Promise<TConfig>,
    hooks?: { onCommit?: () => void },
  ): Promise<TConfig>;
}

function throwIfCanceled(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw signal.reason ?? new Error('Subagent resolution was aborted.');
  }
}

type RouteClaim = {
  environmentId: string | null;
  routed: boolean;
  /** Set once an execution on this route initialized; a committed claim is never released. */
  committed: boolean;
  /** Placements still initializing on this route. */
  holders: number;
};

export function createSubagentCodeRouting<TContext>({
  getInheritedEnvironments,
  sharedRunFiles,
  ...request
}: SubagentCodeRequest & {
  /** Request-scoped parent inheritance (#16756), read when a default route is reserved. */
  getInheritedEnvironments?: () => ReadonlyMap<string, string> | undefined;
  /**
   * Run file sharing is active: shared children must run on managed code, so no
   * attached machine is offered or accepted per call.
   */
  sharedRunFiles?: boolean;
}): SubagentCodeRouting<TContext> {
  const routedContexts = new Map<string, { agentId: string; toolContext: TContext }>();
  const childRoutes = new Map<string, string>();
  /** Machines each agent that runs no stateful code passed on, for runs it never placed. */
  const passedOnByAgent = new Map<string, Set<string>>();
  /**
   * One machine per subagent per request, as with parent inheritance: run-wide
   * state such as the attached-machine permission policy is keyed by agent, so
   * no call may move a subagent off the machine an earlier call settled on.
   */
  const routeByAgent = new Map<string, RouteClaim>();
  /** Placements holding a claim until they are committed or given back. */
  const holds = new WeakMap<
    object,
    { agentId: string; executions: readonly string[]; stopWatching: () => void }
  >();
  /** Pending placements by the execution whose resolution decides them. */
  const holdsByExecution = new Map<string, Set<object>>();
  /**
   * Per-agent tool context entries pending placements use: each user's own context,
   * and the entry that preceded them, so the entry always belongs to a live placement.
   */
  const contextOwners = new Map<
    string,
    {
      contexts: Map<string, TContext>;
      users: Map<object, TContext>;
      previous?: { value: TContext };
    }
  >();
  const settleContext = (agentId: string, placement: object, keep: boolean): void => {
    const owner = contextOwners.get(agentId);
    const own = owner?.users.get(placement);
    if (owner == null || own === undefined) {
      return;
    }
    owner.users.delete(placement);
    if (keep) {
      owner.contexts.set(agentId, own);
      contextOwners.delete(agentId);
      return;
    }
    const survivor = owner.users.values().next();
    if (!survivor.done) {
      if (owner.contexts.get(agentId) === own) {
        owner.contexts.set(agentId, survivor.value);
      }
      return;
    }
    contextOwners.delete(agentId);
    if (owner.previous != null) {
      owner.contexts.set(agentId, owner.previous.value);
    } else {
      owner.contexts.delete(agentId);
    }
  };
  /** Ends a placement's hold, keeping its claim when `keep` is true. */
  const endHold = (placement: object, keep: boolean): void => {
    const held = holds.get(placement);
    if (held == null) {
      return;
    }
    holds.delete(placement);
    held.stopWatching();
    settleContext(held.agentId, placement, keep);
    for (const executionId of held.executions) {
      const pending = holdsByExecution.get(executionId);
      pending?.delete(placement);
      if (pending?.size === 0) {
        holdsByExecution.delete(executionId);
      }
    }
    const claimed = routeByAgent.get(held.agentId);
    if (claimed == null || claimed.committed) {
      return;
    }
    if (keep) {
      claimed.committed = true;
      return;
    }
    claimed.holders -= 1;
    if (claimed.holders <= 0) {
      routeByAgent.delete(held.agentId);
    }
  };
  const release = (placement: object): void => endHold(placement, false);
  const commit = (placement: object): void => endHold(placement, true);
  const recordPassedOn = (agentId: string, environmentId: string): void => {
    const passedOn = passedOnByAgent.get(agentId) ?? new Set<string>();
    passedOn.add(environmentId);
    passedOnByAgent.set(agentId, passedOn);
  };
  /** Pass-throughs recorded by a call, kept only if the resolution deciding them succeeds. */
  const passOnsByExecution = new Map<
    string,
    Array<{ agentId: string; environmentId: string; settled: boolean }>
  >();
  const settleHoldsOf = (executionId: string | undefined, keep: boolean): void => {
    if (executionId == null) {
      return;
    }
    const pending = holdsByExecution.get(executionId);
    for (const placement of [...(pending ?? [])]) {
      endHold(placement, keep);
    }
    for (const passOn of passOnsByExecution.get(executionId) ?? []) {
      if (!passOn.settled) {
        passOn.settled = true;
        if (keep) {
          recordPassedOn(passOn.agentId, passOn.environmentId);
        }
      }
    }
    passOnsByExecution.delete(executionId);
  };
  const conflicts = (agentId: string, environmentId: string | null): boolean => {
    const claimed = routeByAgent.get(agentId);
    return claimed != null && claimed.environmentId !== environmentId;
  };
  /**
   * Claims (or joins) a subagent's one route for a placement. A call's placement is
   * decided by its own resolution and a routed graph member's by its parent's; a
   * placement outside any call is committed when it attaches.
   */
  const hold = <T extends SubagentCodeAgent>(
    placement: SubagentCodePlacement<T>,
    route: { environmentId: string | null; routed: boolean },
    context?: SubagentCodeCallContext | null,
  ): SubagentCodePlacement<T> => {
    const signal = context?.signal;
    const agentId = placement.agent.id;
    const claimed = routeByAgent.get(agentId);
    if (claimed == null) {
      routeByAgent.set(agentId, { ...route, committed: false, holders: 1 });
    } else {
      claimed.holders += 1;
      claimed.routed = claimed.routed || route.routed;
    }
    const onAbort = (): void => release(placement);
    signal?.addEventListener('abort', onAbort, { once: true });
    const executions = [context?.executionId, context?.parentRunId].filter(
      (executionId): executionId is string => executionId != null && executionId !== '',
    );
    for (const executionId of executions) {
      const pending = holdsByExecution.get(executionId) ?? new Set<object>();
      pending.add(placement);
      holdsByExecution.set(executionId, pending);
    }
    holds.set(placement, {
      agentId,
      executions,
      stopWatching: () => signal?.removeEventListener('abort', onAbort),
    });
    return placement;
  };
  /** Live targets this request may place a subagent on per call. */
  /** Every per-call target is an attached machine, so a shared-file run probes none. */
  const resolveTargets = (params: SubagentCodeTargetParams): Promise<SubagentCodeTargets> =>
    sharedRunFiles === true ? Promise.resolve(NO_TARGETS) : resolveSubagentCodeTargets(params);
  const paramsFor = (
    agent: SubagentCodeAgent,
    flags: SubagentCodeFlags,
    signal?: AbortSignal,
  ): SubagentCodeTargetParams => ({
    ...request,
    signal,
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
    context?: SubagentCodeCallContext | null,
  ): SubagentCodePlacement<T> =>
    hold(
      {
        agent: placeSubagentOnCodeTarget(agent, target),
        target,
        childEnvironmentId: target.environmentId,
      },
      { environmentId: target.environmentId, routed: true },
      context,
    );
  /**
   * The machine a call's parent runs on per call: its execution's recorded route, else
   * the routed claim of the parent agent, since an agent keeps one machine per request
   * even in runs that were never placed (an `allowSelf` spawn reuses its inputs).
   */
  const parentRouteOf = (context?: SubagentCodeCallContext | null): string | undefined => {
    const recorded = context?.parentRunId ? childRoutes.get(context.parentRunId) : undefined;
    if (recorded != null || !context?.parentAgentId) {
      return recorded;
    }
    const claimed = routeByAgent.get(context.parentAgentId);
    if (claimed?.routed === true) {
      return claimed.environmentId ?? undefined;
    }
    /** Only an unambiguous pass-through is followed; otherwise static inheritance applies. */
    const passedOn = passedOnByAgent.get(context.parentAgentId);
    return passedOn?.size === 1 ? [...passedOn][0] : undefined;
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
    async describe(agent, flags, signal) {
      if (!isSubagentHostArgsSupported() || flags.statefulCodeSessions !== true) {
        return {};
      }
      const { targets } = await resolveTargets(paramsFor(agent, flags, signal));
      const subagentHostArgs = buildSubagentCodeHostArgs(targets);
      return subagentHostArgs == null
        ? {}
        : { subagentHostArgs, codeExecutionChoices: targets.map((target) => target.context) };
    },
    async place({ agent, flags, context, unavailableReason }) {
      const hostArgs = getSubagentHostArgValues(context);
      const parentEnvironmentId = parentRouteOf(context);
      const requested =
        hostArgs?.[SUBAGENT_MACHINE_ARG] != null || hostArgs?.[SUBAGENT_WORKSPACE_ARG] != null;
      if (requested) {
        const resolution = await resolveTargets(paramsFor(agent, flags, context?.signal));
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
          return routeTo(agent, target, context);
        }
      }
      if (flags.statefulCodeSessions !== true) {
        /** An agent that runs no stateful code passes its parent's machine on. */
        return parentEnvironmentId == null
          ? { agent }
          : { agent, childEnvironmentId: parentEnvironmentId };
      }
      if (inheritedRoute(agent.id, parentEnvironmentId) != null) {
        const { targets } = await resolveTargets(paramsFor(agent, flags, context?.signal));
        throwIfCanceled(context?.signal);
        /** Re-read after the await: a concurrent call may have settled this subagent meanwhile. */
        const inherited = inheritedRoute(agent.id, parentEnvironmentId);
        const target =
          inherited == null
            ? undefined
            : targets.find((candidate) => candidate.environmentId === inherited);
        if (target != null) {
          return routeTo(agent, target, context);
        }
        if (routeByAgent.get(agent.id)?.routed === true) {
          throw createSubagentHostArgumentError(SUBAGENT_MACHINE_ARG, 'unavailable');
        }
      }
      if (unavailableReason != null) {
        throw new CodeWorkspaceSelectionError(unavailableReason);
      }
      /** Reserved now, not after initialization, so a concurrent call cannot claim another machine. */
      const claimed = routeByAgent.get(agent.id);
      return hold(
        { agent },
        claimed ?? { environmentId: defaultRouteOf(agent, flags), routed: false },
        context,
      );
    },
    routesChildren(executionId) {
      return executionId != null && childRoutes.has(executionId);
    },
    attach(contexts, { agentId, context, placement, codeExecutionContext, toolContext }) {
      const executionId = context?.executionId;
      if (placement.target != null) {
        try {
          assertSubagentCodePlacement(codeExecutionContext, placement.target);
        } catch (error) {
          release(placement);
          throw error;
        }
      }
      if (executionId && placement.childEnvironmentId != null) {
        childRoutes.set(executionId, placement.childEnvironmentId);
      }
      if (placement.target == null && placement.childEnvironmentId != null) {
        const executions = [context?.executionId, context?.parentRunId].filter(
          (id): id is string => id != null && id !== '',
        );
        if (executions.length === 0) {
          recordPassedOn(agentId, placement.childEnvironmentId);
        }
        const passOn = { agentId, environmentId: placement.childEnvironmentId, settled: false };
        for (const id of executions) {
          passOnsByExecution.set(id, [...(passOnsByExecution.get(id) ?? []), passOn]);
        }
      }
      if ((holds.get(placement)?.executions.length ?? 0) === 0) {
        commit(placement);
      }
      if (placement.target == null && !routeByAgent.has(agentId)) {
        routeByAgent.set(agentId, {
          environmentId: codeExecutionContext?.environmentId ?? null,
          routed: false,
          committed: true,
          holders: 0,
        });
      }
      /** A pending placement is a user of the per-agent entry until its resolution settles. */
      const register = (replace: boolean): void => {
        const owner = contextOwners.get(agentId);
        if (!holds.has(placement) && (replace || !contexts.has(agentId))) {
          /** A committed placement now owns the entry; nothing pending may roll it back. */
          contextOwners.delete(agentId);
        }
        if (holds.has(placement)) {
          const record = owner ?? {
            contexts,
            users: new Map<object, TContext>(),
            ...(contexts.has(agentId) ? { previous: { value: contexts.get(agentId)! } } : {}),
          };
          record.users.set(placement, toolContext);
          contextOwners.set(agentId, record);
        }
        if (replace || !contexts.has(agentId)) {
          contexts.set(agentId, toolContext);
        }
      };
      if (placement.target == null || !executionId) {
        register(true);
        return;
      }
      routedContexts.set(executionId, { agentId, toolContext });
      register(false);
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
        /** An unplaced run of the agent (an `allowSelf` spawn) defers to an enclosing one. */
        const routed = routedContexts.get(entry.subagentRunId);
        if (routed?.agentId === agentId) {
          return routed.toolContext;
        }
      }
      return undefined;
    },
    isRouted(executionId) {
      return executionId != null && routedContexts.has(executionId);
    },
    async settle(placement, initialization) {
      try {
        return await initialization;
      } catch (error) {
        release(placement);
        throw error;
      }
    },
    async settleExecution(context, resolve, hooks) {
      try {
        const resolved = await resolve();
        settleHoldsOf(context?.executionId, true);
        hooks?.onCommit?.();
        return resolved;
      } catch (error) {
        settleHoldsOf(context?.executionId, false);
        throw error;
      }
    },
  };
}

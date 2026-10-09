import { stripAgentIdSuffix } from '../agents/identity';

export const CODE_WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Protocol-v1 ceiling enforced by the worker and Code API. */
export const CODE_WORKSPACE_MAX_COUNT = 32;
/** Wire/storage safety ceiling; deployments may set a lower per-agent choice limit. */
export const MAX_AGENT_CODE_ENVIRONMENT_CHOICES = 128;
export const DEFAULT_AGENT_CODE_ENVIRONMENT_CHOICES = 32;

/**
 * Per-chat machine choice is on unless a deployment sets `allowEnvironmentSelection: false`.
 * It only ever applies to agents whose author saved a machine allowlist; every other agent
 * keeps its fixed machine either way.
 */
export function isCodeEnvironmentSelectionAllowed(
  allowEnvironmentSelection?: boolean | null,
): boolean {
  return allowEnvironmentSelection !== false;
}

/**
 * Linked-worktree lanes are on unless an environment sets `workspaces.linkedWorktrees: false`.
 * They only apply where the worker advertises the `git_linked_worktree` scope.
 */
export function isLinkedWorktreeRoutingAllowed(linkedWorktrees?: boolean | null): boolean {
  return linkedWorktrees !== false;
}
/** API/client protocol for immutable conversation-owned environment decisions. */
export const CODE_ENVIRONMENT_DECISION_VERSION = 1 as const;
/** API/client protocol for an owner's explicit move of a sealed environment decision. */
export const CODE_ENVIRONMENT_MOVE_VERSION = 1 as const;
/**
 * API/client protocol for the other two replacements of a sealed decision: attaching an
 * environment to a chat that recorded running without one, and leaving attached execution behind.
 * Advertised beside the move version rather than replacing it, so a client that predates this
 * capability keeps the move it already had while a deployment rolls out, and a client that has it
 * never offers an attach a replica would refuse as `locked` or a detach it would call `invalid`.
 */
export const CODE_ENVIRONMENT_TRANSITION_VERSION = 2 as const;
/** Additive capability for replacing a missing workspace without disabling moves in V1 clients. */
export const CODE_WORKSPACE_RECOVERY_VERSION = 1 as const;
/**
 * API/client protocol for subagents that follow their parent's machine. A composer mirrors the
 * routing only when this is advertised, so it never omits a workspace an older API still needs.
 */
export const CODE_WORKSPACE_INHERITANCE_VERSION = 1 as const;
export const CODE_WORKSPACE_OPERATIONS = [
  'read_file',
  'search_text',
  'list_files',
  'write_file',
  'preview_edit',
  'edit_file',
  'execute_command',
] as const;
export const CODE_WORKSPACE_INSTANCE_TYPES = ['git_worktree'] as const;
export const CODE_WORKSPACE_CHECKOUT_MODES = ['source', 'isolated'] as const;
/** Scheduling scopes a worker can admit beneath one registered root. */
export const CODE_WORKSPACE_SCOPES = ['git_linked_worktree'] as const;
export const CODE_WORKSPACE_SELECTION_ERROR_REASONS = [
  'required',
  'invalid',
  'worker_unavailable',
  'unsupported',
  'missing',
  'locked',
] as const;
export const CODE_ENVIRONMENT_MODES = ['attached', 'without_attached'] as const;

export type CodeWorkspaceOperation = (typeof CODE_WORKSPACE_OPERATIONS)[number];
export type CodeWorkspaceInstanceType = (typeof CODE_WORKSPACE_INSTANCE_TYPES)[number];
export type CodeWorkspaceScope = (typeof CODE_WORKSPACE_SCOPES)[number];
export type CodeWorkspaceSelectionErrorReason =
  (typeof CODE_WORKSPACE_SELECTION_ERROR_REASONS)[number];
export type CodeEnvironmentMode = (typeof CODE_ENVIRONMENT_MODES)[number];

/** Public, path-free description of one root registered by an attached worker. */
export interface CodeWorkspaceDescriptor {
  id: string;
  name?: string;
  instructions?: RepositoryInstructionDescriptor[];
  /** Omitted when every worker-level operation applies to this workspace. */
  operations?: CodeWorkspaceOperation[];
  /** Optional worker-managed isolation modes available beneath this root. */
  workspaceInstances?: CodeWorkspaceInstanceType[];
  /** `git_linked_worktree`: each `.worktrees/<name>` runs in its own scheduling lane. */
  workspaceScopes?: CodeWorkspaceScope[];
  environment?: {
    fingerprint: string;
    repo?: string;
    ref?: string;
    actions: string[];
  };
}

export type RepositoryInstructionMode = 'prefer' | 'defer' | 'off';
export interface RepositoryInstructionDescriptor {
  path: 'AGENTS.md' | 'CLAUDE.md';
  bytes: number;
  sha256: string;
  truncated: boolean;
}
export function isRepositoryInstructionDescriptor(
  value: unknown,
): value is RepositoryInstructionDescriptor {
  if (value == null || typeof value !== 'object') return false;
  const descriptor = value as Record<string, unknown>;
  return (
    Object.keys(descriptor).every((key) =>
      ['path', 'bytes', 'sha256', 'truncated'].includes(key),
    ) &&
    (descriptor.path === 'AGENTS.md' || descriptor.path === 'CLAUDE.md') &&
    Number.isSafeInteger(descriptor.bytes) &&
    Number(descriptor.bytes) >= 0 &&
    Number(descriptor.bytes) <= 32768 &&
    typeof descriptor.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(descriptor.sha256) &&
    typeof descriptor.truncated === 'boolean'
  );
}

export function isCodeWorkspaceEnvironment(
  value: unknown,
): value is NonNullable<CodeWorkspaceDescriptor['environment']> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const environment = value as Record<string, unknown>;
  return (
    Object.keys(environment).every((key) =>
      ['fingerprint', 'repo', 'ref', 'actions'].includes(key),
    ) &&
    typeof environment.fingerprint === 'string' &&
    /^[a-f0-9]{64}$/.test(environment.fingerprint) &&
    (environment.repo === undefined ||
      (typeof environment.repo === 'string' &&
        environment.repo.length <= 256 &&
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(environment.repo))) &&
    (environment.ref === undefined ||
      (typeof environment.ref === 'string' &&
        environment.ref.trim().length > 0 &&
        environment.ref.length <= 256 &&
        !/[\0\r\n]/.test(environment.ref))) &&
    Array.isArray(environment.actions) &&
    environment.actions.length <= 32 &&
    environment.actions.every(
      (name) => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name),
    ) &&
    new Set(environment.actions).size === environment.actions.length
  );
}

/** Conversation-owned selection, bound to the environment that advertised it. */
export interface CodeWorkspaceSelection {
  environmentId: string;
  workspaceId: string;
  /** Omitted preserves the worker's legacy automatic isolation policy. */
  checkout?: (typeof CODE_WORKSPACE_CHECKOUT_MODES)[number];
  /** Explicit graph-agent ownership of a chat machine choice; absent on legacy selections. */
  agentIds?: string[];
}

/** Explicit isolation never falls back to shared files when a capability or policy disappears. */
export function isCodeWorkspaceCheckoutAvailable(
  selection: Pick<CodeWorkspaceSelection, 'checkout'>,
  workspace: Pick<CodeWorkspaceDescriptor, 'workspaceInstances'> | undefined,
  allowSelection: boolean,
): boolean {
  return (
    selection.checkout == null ||
    (allowSelection &&
      workspace != null &&
      (selection.checkout === 'source' ||
        workspace.workspaceInstances?.includes('git_worktree') === true))
  );
}

export function isCodeEnvironmentMode(value: unknown): value is CodeEnvironmentMode {
  return CODE_ENVIRONMENT_MODES.some((mode) => mode === value);
}

export function isCodeWorkspaceSelectionErrorReason(
  value: unknown,
): value is CodeWorkspaceSelectionErrorReason {
  return CODE_WORKSPACE_SELECTION_ERROR_REASONS.some((reason) => reason === value);
}

export function isCodeWorkspaceSelection(value: unknown): value is CodeWorkspaceSelection {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const selection = value as Record<string, unknown>;
  return (
    Object.keys(selection).every((key) =>
      ['environmentId', 'workspaceId', 'agentIds', 'checkout'].includes(key),
    ) &&
    typeof selection.environmentId === 'string' &&
    CODE_WORKSPACE_ID_PATTERN.test(selection.environmentId) &&
    typeof selection.workspaceId === 'string' &&
    CODE_WORKSPACE_ID_PATTERN.test(selection.workspaceId) &&
    (selection.checkout === undefined ||
      selection.checkout === 'source' ||
      selection.checkout === 'isolated') &&
    (selection.agentIds === undefined ||
      (Array.isArray(selection.agentIds) &&
        selection.agentIds.length > 0 &&
        selection.agentIds.length <= MAX_AGENT_CODE_ENVIRONMENT_CHOICES &&
        selection.agentIds.every(
          (id) => typeof id === 'string' && CODE_WORKSPACE_ID_PATTERN.test(id),
        ) &&
        new Set(selection.agentIds).size === selection.agentIds.length))
  );
}

/** One exact workspace per attached environment used by a conversation. */
export function isCodeWorkspaceSelections(value: unknown): value is CodeWorkspaceSelection[] {
  if (!Array.isArray(value)) return false;
  const environmentIds = new Set<string>();
  const agentIds = new Set<string>();
  return value.every((selection) => {
    if (!isCodeWorkspaceSelection(selection) || environmentIds.has(selection.environmentId)) {
      return false;
    }
    environmentIds.add(selection.environmentId);
    for (const id of selection.agentIds ?? []) {
      if (agentIds.has(id)) return false;
      agentIds.add(id);
      if (agentIds.size > MAX_AGENT_CODE_ENVIRONMENT_CHOICES) return false;
    }
    return true;
  });
}

/** Stable decision serialization includes ownership so replay cannot change an agent's route. */
export function canonicalizeCodeWorkspaceSelections(
  selections: CodeWorkspaceSelection[],
): CodeWorkspaceSelection[] {
  return selections
    .map(({ environmentId, workspaceId, agentIds, checkout }) => ({
      environmentId,
      workspaceId,
      ...(checkout == null ? {} : { checkout }),
      ...(agentIds == null ? {} : { agentIds: [...agentIds].sort() }),
    }))
    .sort((left, right) => left.environmentId.localeCompare(right.environmentId));
}

/** Whether an agent may run on `candidate`: its own default, or a machine its author allowlisted
 * where per-chat machine choice applies to it. */
function isAllowedCodeEnvironment(
  candidate: string,
  environmentId: string | null | undefined,
  environmentIds: readonly string[] | undefined,
  allowSelection: boolean | undefined,
): boolean {
  return (
    candidate === environmentId ||
    (allowSelection === true && environmentIds?.includes(candidate) === true)
  );
}

/** Resolves an agent's default or its chat-owned machine choice. Callers still authorize the
 * resolved ID against their principal-scoped environment list and verify live capabilities.
 *
 * Precedence: an explicit owner of a selection, then the machine inherited from the parent that
 * spawned this subagent (see `resolveCodeWorkspaceInheritance`), then the agent's own default,
 * then a single legacy selection. Inheritance is a separate input rather than an added owner: an
 * owner on a legacy selection would stop it serving as every other agent's fallback. */
export function resolveCodeEnvironmentSelection({
  environmentId,
  environmentIds,
  agentId,
  allowSelection,
  selections,
  inheritedEnvironmentId,
}: {
  environmentId?: string | null;
  environmentIds?: readonly string[];
  agentId?: string | null;
  allowSelection?: boolean;
  selections?: unknown;
  /** The parent's machine; applies only when the conversation selected it and this agent may use it. */
  inheritedEnvironmentId?: string | null;
}): { valid: true; environmentId?: string | null } | { valid: false } {
  if (selections == null) return { valid: true, environmentId };
  if (!isCodeWorkspaceSelections(selections)) return { valid: false };
  if (selections.length === 0) return { valid: true, environmentId };
  /** Ownership is persisted under the saved agent ID, not the parallel actor's runtime ID.
   * Check it before feature gates so revoked routes cannot silently revert to the default. */
  const stableAgentId = agentId == null ? undefined : stripAgentIdSuffix(agentId);
  const owned =
    stableAgentId == null
      ? undefined
      : selections.find((selection) => selection.agentIds?.includes(stableAgentId));
  if (owned != null) {
    if (owned.environmentId === environmentId) return { valid: true, environmentId };
    return allowSelection === true && environmentIds?.includes(owned.environmentId)
      ? { valid: true, environmentId: owned.environmentId }
      : { valid: false };
  }
  if (
    inheritedEnvironmentId != null &&
    isAllowedCodeEnvironment(
      inheritedEnvironmentId,
      environmentId,
      environmentIds,
      allowSelection,
    ) &&
    selections.some((selection) => selection.environmentId === inheritedEnvironmentId)
  ) {
    return { valid: true, environmentId: inheritedEnvironmentId };
  }
  if (!allowSelection) return { valid: true, environmentId };
  const allowed = new Set(environmentIds ?? []);
  if (environmentId) allowed.add(environmentId);
  const matches = selections.filter((selection) => allowed.has(selection.environmentId));
  /** A graph may need an alternative for a different agent. Preserve this agent's explicit
   * default when present; without it, require exactly one allowed target rather than guessing. */
  const selectedDefault = matches.find((selection) => selection.environmentId === environmentId);
  if (selectedDefault != null) return { valid: true, environmentId };
  const legacy = matches.filter((selection) => selection.agentIds == null);
  if (legacy.length !== 1) return { valid: false };
  return { valid: true, environmentId: legacy[0].environmentId };
}

/** One agent of a run's graph, reduced to the fields machine routing reads. */
export interface CodeWorkspaceRoutingAgent {
  /** Saved agent ID, the key conversation ownership is recorded under. */
  id: string;
  /** Runs code on a stateful machine. An agent that does not passes its parent's machine on. */
  routesCode: boolean;
  /** Effective default machine: the agent's own, or the deployment default. */
  environmentId?: string | null;
  environmentIds?: readonly string[];
  /** Both the deployment ceiling and this agent's allowlist admit a per-chat machine choice. */
  allowSelection: boolean;
  /** Subagents this agent may spawn: explicit subagents and the members of its subagent graphs. */
  subagentIds?: readonly string[];
  /** Machine already resolved for this agent, such as an initialized root; `null` for none. */
  resolvedEnvironmentId?: string | null;
}

/**
 * Subagents default to the attached machine, and so the workspace, their parent runs on. A
 * subagent inherits only when every one of these holds:
 * - no selection names it as an explicit owner, so a choice made for it still wins;
 * - the parent's machine is its own default or on its author's allowlist where per-chat choice
 *   applies to it;
 * - `isAttachedEnvironment` admits that machine, which callers scope to the principal;
 * - the conversation's decision already selected a workspace on that machine.
 *
 * Inheritance is derived from the sealed decision and the agents' current configuration, the same
 * inputs every other route reads, so the same decision and graph always route the same way. A run
 * resolves one route per saved agent, so a subagent considers every agent that can spawn it, at any
 * depth: it inherits only when they all run on the same machine, and otherwise keeps its own route.
 * A subagent that does not run code passes its parent's machine on to its own subagents. Subagents
 * that spawn each other follow the machine of every parent outside that group only when it routes
 * each of them there.
 *
 * @returns Saved agent ID to inherited environment ID, for subagents whose route changes.
 */
export function resolveCodeWorkspaceInheritance({
  selections,
  rootIds,
  agents,
  isAttachedEnvironment,
}: {
  selections: unknown;
  rootIds: readonly string[];
  agents: ReadonlyMap<string, CodeWorkspaceRoutingAgent>;
  isAttachedEnvironment: (environmentId: string) => boolean;
}): Map<string, string> {
  const inherited = new Map<string, string>();
  if (!isCodeWorkspaceSelections(selections) || selections.length === 0) return inherited;
  const selected = new Set(selections.map(({ environmentId }) => environmentId));
  const owned = new Set(selections.flatMap(({ agentIds }) => agentIds ?? []));
  const routes = new Map<string, string | undefined>();

  const routeOf = (
    agent: CodeWorkspaceRoutingAgent,
    parentRoute: string | undefined,
  ): string | undefined => {
    if (!agent.routesCode) return parentRoute;
    const resolved =
      agent.resolvedEnvironmentId !== undefined
        ? agent.resolvedEnvironmentId
        : resolveRoutedEnvironmentId(agent, selections, inherited.get(agent.id));
    return resolved != null && isAttachedEnvironment(resolved) ? resolved : undefined;
  };
  const inherits = (agent: CodeWorkspaceRoutingAgent, candidate: string): boolean =>
    agent.routesCode &&
    agent.resolvedEnvironmentId === undefined &&
    candidate !== agent.environmentId &&
    !owned.has(agent.id) &&
    selected.has(candidate) &&
    isAllowedCodeEnvironment(
      candidate,
      agent.environmentId,
      agent.environmentIds,
      agent.allowSelection,
    ) &&
    isAttachedEnvironment(candidate);

  const roots = new Set(rootIds.filter((id) => agents.has(id)));
  const parents = collectSpawningParents(roots, agents);
  roots.forEach((id) =>
    routes.set(id, routeOf(agents.get(id) as CodeWorkspaceRoutingAgent, undefined)),
  );
  const resolve = (id: string, candidate: string | undefined): void => {
    const agent = agents.get(id) as CodeWorkspaceRoutingAgent;
    if (candidate != null && inherits(agent, candidate)) {
      inherited.set(id, candidate);
    }
    routes.set(id, routeOf(agent, candidate));
  };

  /** A group follows the single machine every outside parent runs on when that routes each member
   *  there too; otherwise its members keep their own routes. */
  const resolveGroup = (members: string[]): void => {
    const group = new Set(members);
    const outside = new Set<string | undefined>();
    for (const id of members) {
      parents.get(id)?.forEach((parentId) => {
        if (!group.has(parentId)) outside.add(routes.get(parentId));
      });
    }
    const candidate = outside.size === 1 ? Array.from(outside)[0] : undefined;
    members.forEach((id) => resolve(id, candidate));
    if (candidate != null && members.some((id) => routes.get(id) !== candidate)) {
      members.forEach((id) => {
        inherited.delete(id);
        resolve(id, undefined);
      });
    }
  };

  let pending = Array.from(parents.keys());
  while (pending.length > 0) {
    const ready = pending.filter((id) =>
      Array.from(parents.get(id) ?? []).every((parentId) => routes.has(parentId)),
    );
    if (ready.length > 0) {
      for (const id of ready) {
        const candidates = new Set(
          Array.from(parents.get(id) ?? []).map((parentId) => routes.get(parentId)),
        );
        resolve(id, candidates.size === 1 ? Array.from(candidates)[0] : undefined);
      }
    } else {
      /** Every remaining agent waits on another, so some of them spawn each other. Each group of
       *  mutually spawning agents whose outside parents are all resolved settles on its own. */
      const groups = findSettledSpawnGroups(pending, parents, routes);
      for (const members of groups.length > 0 ? groups : [pending]) {
        resolveGroup(members);
      }
    }
    pending = pending.filter((id) => !routes.has(id));
  }
  return inherited;
}

/**
 * Every agent that can spawn each subagent reachable from the roots. A run never spawns an agent
 * beneath itself, so `parent → child` counts only when some spawn path reaches the parent without
 * passing through the child.
 */
function collectSpawningParents(
  roots: ReadonlySet<string>,
  agents: ReadonlyMap<string, CodeWorkspaceRoutingAgent>,
): Map<string, Set<string>> {
  const parents = new Map<string, Set<string>>();
  const reachable = reachableFrom(roots, agents);
  reachable.forEach((parentId) => {
    for (const childId of agents.get(parentId)?.subagentIds ?? []) {
      if (roots.has(childId) || !agents.has(childId)) continue;
      if (!reachableFrom(roots, agents, childId).has(parentId)) continue;
      const childParents = parents.get(childId) ?? new Set<string>();
      childParents.add(parentId);
      parents.set(childId, childParents);
    }
  });
  return parents;
}

function reachableFrom(
  roots: ReadonlySet<string>,
  agents: ReadonlyMap<string, CodeWorkspaceRoutingAgent>,
  avoid?: string,
): Set<string> {
  const visited = new Set<string>(roots);
  const queue = Array.from(roots);
  for (let index = 0; index < queue.length; index++) {
    for (const childId of agents.get(queue[index])?.subagentIds ?? []) {
      if (childId === avoid || visited.has(childId) || !agents.has(childId)) continue;
      visited.add(childId);
      queue.push(childId);
    }
  }
  return visited;
}

/**
 * Groups of agents that spawn each other (strongly connected among the waiting agents) whose every
 * parent outside the group already has a route.
 */
function findSettledSpawnGroups(
  pending: readonly string[],
  parents: ReadonlyMap<string, ReadonlySet<string>>,
  routes: ReadonlyMap<string, string | undefined>,
): string[][] {
  const waiting = new Set(pending);
  const ancestors = new Map(pending.map((id) => [id, waitingAncestors(id, waiting, parents)]));
  const grouped = new Set<string>();
  const groups: string[][] = [];
  for (const id of pending) {
    if (grouped.has(id)) continue;
    const members = pending.filter(
      (other) =>
        other === id ||
        (ancestors.get(id)?.has(other) === true && ancestors.get(other)?.has(id) === true),
    );
    members.forEach((member) => grouped.add(member));
    const group = new Set(members);
    const settled = members.every((member) =>
      Array.from(parents.get(member) ?? []).every(
        (parentId) => group.has(parentId) || routes.has(parentId),
      ),
    );
    if (settled && (members.length > 1 || ancestors.get(id)?.has(id) === true)) {
      groups.push(members);
    }
  }
  return groups;
}

function waitingAncestors(
  id: string,
  waiting: ReadonlySet<string>,
  parents: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
  const seen = new Set<string>();
  const stack = Array.from(parents.get(id) ?? []);
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (!waiting.has(current) || seen.has(current)) continue;
    seen.add(current);
    stack.push(...Array.from(parents.get(current) ?? []));
  }
  return seen;
}

function resolveRoutedEnvironmentId(
  agent: CodeWorkspaceRoutingAgent,
  selections: CodeWorkspaceSelection[],
  inheritedEnvironmentId: string | undefined,
): string | null | undefined {
  const resolution = resolveCodeEnvironmentSelection({
    agentId: agent.id,
    environmentId: agent.environmentId,
    environmentIds: agent.environmentIds,
    allowSelection: agent.allowSelection,
    selections,
    inheritedEnvironmentId,
  });
  return resolution.valid ? resolution.environmentId : undefined;
}

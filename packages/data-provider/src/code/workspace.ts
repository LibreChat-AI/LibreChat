import { stripAgentIdSuffix } from '../agents/identity';

export const CODE_WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Protocol-v1 ceiling enforced by the worker and Code API. */
export const CODE_WORKSPACE_MAX_COUNT = 32;
/** Wire/storage safety ceiling; deployments may set a lower per-agent choice limit. */
export const MAX_AGENT_CODE_ENVIRONMENT_CHOICES = 128;
export const DEFAULT_AGENT_CODE_ENVIRONMENT_CHOICES = 32;
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

/** Resolves an agent's default or its chat-owned machine choice. Callers still authorize the
 * resolved ID against their principal-scoped environment list and verify live capabilities. */
export function resolveCodeEnvironmentSelection({
  environmentId,
  environmentIds,
  agentId,
  allowSelection,
  selections,
}: {
  environmentId?: string | null;
  environmentIds?: readonly string[];
  agentId?: string | null;
  allowSelection?: boolean;
  selections?: unknown;
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

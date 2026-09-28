interface AgentWorkspaceUpdate {
  code_environment_id?: string | null;
  code_workspace_id?: string;
  [key: string]: unknown;
}

interface AgentWorkspaceEnvironment {
  id: string;
  type?: string;
}

interface AgentWorkspaceConfiguration {
  stateful_code_sessions?: boolean;
  stateful_code_environment?: string | null;
  code_environment_id?: string | null;
  code_workspace_id?: string;
}

export const AGENT_WORKSPACE_ATTACHED_ENVIRONMENT_ERROR =
  'Code workspace defaults require an explicit attached code environment';

export function isActiveAgentWorkspaceConfiguration(
  configuration?: AgentWorkspaceConfiguration,
): boolean {
  return configuration?.stateful_code_sessions === true;
}

/** Resolve workspace fields according to the version restore persistence contract. */
export function resolveAgentWorkspaceRestoreConfiguration({
  version,
  current,
}: {
  version: AgentWorkspaceConfiguration;
  current: AgentWorkspaceConfiguration;
}): AgentWorkspaceConfiguration {
  return {
    stateful_code_sessions: Object.prototype.hasOwnProperty.call(version, 'stateful_code_sessions')
      ? version.stateful_code_sessions
      : current.stateful_code_sessions,
    stateful_code_environment: Object.prototype.hasOwnProperty.call(
      version,
      'stateful_code_environment',
    )
      ? version.stateful_code_environment
      : current.stateful_code_environment,
    code_environment_id: Object.prototype.hasOwnProperty.call(version, 'code_environment_id')
      ? version.code_environment_id
      : undefined,
    code_workspace_id: Object.prototype.hasOwnProperty.call(version, 'code_workspace_id')
      ? version.code_workspace_id
      : undefined,
  };
}

export function shouldValidateAgentWorkspaceDefaultBinding({
  workspaceId,
  environmentId,
  currentWorkspaceId,
  currentEnvironmentId,
}: {
  workspaceId?: string;
  environmentId?: string | null;
  currentWorkspaceId?: string;
  currentEnvironmentId?: string | null;
}): boolean {
  return Boolean(
    workspaceId &&
      (workspaceId !== currentWorkspaceId ||
        (environmentId ?? undefined) !== (currentEnvironmentId ?? undefined)),
  );
}

/** Validate only a newly selected or rebound machine-scoped workspace default. */
export function validateAgentWorkspaceDefaultBinding({
  workspaceId,
  environmentId,
  currentWorkspaceId,
  currentEnvironmentId,
  environments,
}: {
  workspaceId?: string;
  environmentId?: string | null;
  currentWorkspaceId?: string;
  currentEnvironmentId?: string | null;
  environments?: readonly AgentWorkspaceEnvironment[];
}): { valid: true } | { valid: false; error: string } {
  if (
    !shouldValidateAgentWorkspaceDefaultBinding({
      workspaceId,
      environmentId,
      currentWorkspaceId,
      currentEnvironmentId,
    })
  ) {
    return { valid: true };
  }

  const configuredEnvironment = environments?.find(
    (environment) => environment.id === (environmentId ?? undefined),
  );
  if (configuredEnvironment?.type === 'attached') {
    return { valid: true };
  }

  return { valid: false, error: AGENT_WORKSPACE_ATTACHED_ENVIRONMENT_ERROR };
}

/** Clear a machine-scoped default when its environment changes without a replacement default. */
export function reconcileAgentWorkspaceDefault<T extends AgentWorkspaceUpdate>({
  update,
  request,
  currentEnvironmentId,
}: {
  update: T;
  request: AgentWorkspaceUpdate;
  currentEnvironmentId?: string | null;
}): T {
  const changesEnvironment =
    Object.prototype.hasOwnProperty.call(request, 'code_environment_id') &&
    request.code_environment_id !== currentEnvironmentId;
  if (!changesEnvironment || Object.prototype.hasOwnProperty.call(request, 'code_workspace_id')) {
    return update;
  }
  return { ...update, code_workspace_id: '' };
}

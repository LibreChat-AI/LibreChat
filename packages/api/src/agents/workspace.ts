import {
  DEFAULT_AGENT_CODE_ENVIRONMENT_CHOICES,
  resolveAllowedStatefulCodeEnvironments,
} from 'librechat-data-provider';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';

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
  code_environment_ids?: string[];
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
    code_environment_ids: Object.prototype.hasOwnProperty.call(version, 'code_environment_ids')
      ? version.code_environment_ids
      : undefined,
  };
}

/** Validate all new references against the request's already-loaded, principal-scoped config
 * before the persistence layer acquires deletion reservations. Unrelated edits omit the list. */
export function validateAgentCodeEnvironmentAllowlist(
  req: Pick<ServerRequest, 'config'>,
  res: Pick<Response, 'status'>,
  environmentIds?: readonly string[],
): boolean {
  if (environmentIds == null) return true;
  const policy = req.config?.endpoints?.agents?.statefulCodeSessions;
  const maximum = policy?.maxEnvironmentChoices ?? DEFAULT_AGENT_CODE_ENVIRONMENT_CHOICES;
  if (environmentIds.length > maximum) {
    res
      .status(400)
      .json({ error: `Agent machine choices exceed the configured maximum of ${maximum}` });
    return false;
  }
  for (const id of environmentIds) {
    const environment = policy?.environments?.find((candidate) => candidate.id === id);
    if (
      environment?.type !== 'attached' ||
      (environment.pairing?.allowPrincipalWorkers === true &&
        environment.pairing.workerId == null &&
        environment.workerId == null)
    ) {
      res.status(403).json({
        error: 'One or more agent machine choices are not authorized attached environments',
      });
      return false;
    }
  }
  return true;
}

/** Shared create/update/duplicate/restore policy. CJS controllers only wire the validated data
 * and loaded request config into this boundary; they do not implement routing authorization. */
export function validateStatefulCodeEnvironment(
  req: Pick<ServerRequest, 'config'>,
  res: Pick<Response, 'status'>,
  enabled?: boolean,
  environment?: string | null,
  environmentId?: string | null,
  environmentIdSelected = false,
  workspaceId?: string,
  currentWorkspaceId?: string,
  currentEnvironmentId?: string | null,
  environmentIds?: readonly string[],
): boolean {
  if (!validateAgentCodeEnvironmentAllowlist(req, res, environmentIds)) return false;
  const policy = req.config?.endpoints?.agents?.statefulCodeSessions;
  const configuredEnvironments = policy?.environments ?? [];
  const workspaceValidation = validateAgentWorkspaceDefaultBinding({
    workspaceId,
    environmentId,
    currentWorkspaceId,
    currentEnvironmentId,
    environments: configuredEnvironments,
  });
  if (!workspaceValidation.valid) {
    res.status(400).json({ error: workspaceValidation.error });
    return false;
  }
  if (enabled !== true && !environmentIdSelected) return true;
  if (environmentId != null) {
    const configured = configuredEnvironments.find((candidate) => candidate.id === environmentId);
    if (
      configured == null ||
      (configured.pairing?.allowPrincipalWorkers === true &&
        configured.pairing.workerId == null &&
        configured.workerId == null)
    ) {
      res
        .status(400)
        .json({ error: `Stateful code environment is not configured: ${environmentId}` });
      return false;
    }
  }
  if (enabled !== true) return true;
  const resolvedEnvironment = environment ?? 'user';
  if (
    resolveAllowedStatefulCodeEnvironments(policy?.allowedEnvironments).includes(
      resolvedEnvironment as 'user' | 'agent-user' | 'conversation',
    )
  )
    return true;
  res.status(403).json({
    error: `Stateful code environment is not allowed by this deployment: ${resolvedEnvironment}`,
  });
  return false;
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

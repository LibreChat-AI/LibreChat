import { logger } from '@librechat/data-schemas';
import { ErrorTypes, isCodeWorkspaceSelections } from 'librechat-data-provider';
import type {
  CodeWorkspaceSelection,
  CodeWorkspaceSelectionErrorReason,
} from 'librechat-data-provider';
import type { CodeEnvironmentConfig, CodeExecutionContext } from '~/agents/execution';
import type { createAppConfigService } from '~/app/service';
import type { CodeBridgeWorkerStatus } from './bridge';
export type { CodeWorkspaceSelectionErrorReason } from 'librechat-data-provider';
import {
  CodeBridgeStatusError,
  createCodeBridgeStatusPoller,
  readCodeBridgeSecret,
} from './bridge';

export type CodeCapabilityConfigLoader = ReturnType<typeof createAppConfigService>['getAppConfig'];

const pollWorkerStatus = createCodeBridgeStatusPoller();

function codeWorkspaceSelectionErrorMessage(reason: CodeWorkspaceSelectionErrorReason): string {
  switch (reason) {
    case 'required':
      return 'Choose an attached workspace before using this agent.';
    case 'invalid':
      return 'The selected attached workspace is invalid.';
    case 'worker_unavailable':
      return 'The attached code environment is unavailable. Reconnect the machine and try again.';
    case 'unsupported':
      return 'The attached code environment does not advertise selectable workspaces. Update the LibreChat Code worker and try again.';
    case 'missing':
      return 'The selected workspace is no longer registered on this machine. Restore the previous registration or start a new conversation.';
    case 'locked':
      return 'This conversation already has a different code environment decision.';
  }
}

export class CodeWorkspaceSelectionError extends Error {
  readonly code: ErrorTypes.CODE_WORKSPACE_UNAVAILABLE = ErrorTypes.CODE_WORKSPACE_UNAVAILABLE;
  readonly status: number = 409;
  readonly statusCode: number = 409;

  constructor(public readonly reason: CodeWorkspaceSelectionErrorReason) {
    super(codeWorkspaceSelectionErrorMessage(reason));
    this.name = 'CodeWorkspaceSelectionError';
  }
}

function canonicalWorkspaceSelections(
  selections: CodeWorkspaceSelection[],
): CodeWorkspaceSelection[] {
  return [...selections].sort((left, right) => {
    if (left.environmentId < right.environmentId) return -1;
    if (left.environmentId > right.environmentId) return 1;
    if (left.workspaceId < right.workspaceId) return -1;
    if (left.workspaceId > right.workspaceId) return 1;
    return 0;
  });
}

function sameWorkspaceSelections(
  left: CodeWorkspaceSelection[],
  right: CodeWorkspaceSelection[],
): boolean {
  return (
    JSON.stringify(canonicalWorkspaceSelections(left)) ===
    JSON.stringify(canonicalWorkspaceSelections(right))
  );
}

async function readAuthorizedAttachedWorkerStatus(
  context: CodeExecutionContext,
  environments: readonly CodeEnvironmentConfig[] | undefined,
  getAppConfig: CodeCapabilityConfigLoader | undefined,
): Promise<CodeBridgeWorkerStatus> {
  if (context.environmentType !== 'attached' || !context.bridgeWorkerId) {
    throw new CodeWorkspaceSelectionError('worker_unavailable');
  }
  const selected = environments?.find((environment) => environment.id === context.environmentId);
  const controlPlaneId = selected?.controlPlaneId ?? selected?.id;
  const effectiveControlPlane = environments?.find(
    (environment) =>
      environment.id === controlPlaneId &&
      environment.type === 'attached' &&
      environment.owner === 'deployment',
  );
  if (!effectiveControlPlane || !getAppConfig) {
    throw new CodeWorkspaceSelectionError('worker_unavailable');
  }
  const deploymentConfig = await getAppConfig({ baseOnly: true });
  const controlPlane = deploymentConfig.endpoints?.agents?.statefulCodeSessions?.environments?.find(
    (environment) =>
      environment.id === controlPlaneId &&
      environment.type === 'attached' &&
      environment.owner === 'deployment',
  );
  if (
    !controlPlane ||
    (selected?.workerId ?? selected?.pairing?.workerId) !== context.bridgeWorkerId ||
    (selected?.owner === 'deployment' &&
      controlPlane.pairing?.workerId !== context.bridgeWorkerId) ||
    controlPlane.baseURL.replace(/\/+$/, '') !== context.baseUrl.replace(/\/+$/, '')
  ) {
    throw new CodeWorkspaceSelectionError('worker_unavailable');
  }
  const tokenEnv = controlPlane.pairing?.tokenEnv;
  const token = tokenEnv == null ? undefined : readCodeBridgeSecret(tokenEnv)?.trim();
  if (!token) {
    throw new CodeWorkspaceSelectionError('worker_unavailable');
  }
  return await pollWorkerStatus({
    baseURL: controlPlane.baseURL,
    workerId: context.bridgeWorkerId,
    token,
  });
}

/** Resolves an immutable conversation selection into a live worker capability. */
export async function resolveCodeExecutionWorkspaceContext({
  context,
  requestedSelections,
  persistedSelections,
  environments,
  getAppConfig,
}: {
  context: CodeExecutionContext;
  requestedSelections?: unknown;
  persistedSelections?: unknown;
  environments?: readonly CodeEnvironmentConfig[];
  getAppConfig?: CodeCapabilityConfigLoader;
}): Promise<CodeExecutionContext> {
  if (context.environmentType !== 'attached') return context;
  if (
    persistedSelections !== undefined &&
    requestedSelections !== undefined &&
    (!isCodeWorkspaceSelections(persistedSelections) ||
      !isCodeWorkspaceSelections(requestedSelections) ||
      !sameWorkspaceSelections(persistedSelections, requestedSelections))
  ) {
    throw new CodeWorkspaceSelectionError('locked');
  }
  const rawSelections = persistedSelections ?? requestedSelections;
  if (rawSelections == null) {
    throw new CodeWorkspaceSelectionError('required');
  }
  if (!isCodeWorkspaceSelections(rawSelections)) {
    throw new CodeWorkspaceSelectionError('invalid');
  }
  const selection: CodeWorkspaceSelection | undefined = rawSelections.find(
    ({ environmentId }) => environmentId === context.environmentId,
  );
  if (selection == null) throw new CodeWorkspaceSelectionError('required');

  let status: CodeBridgeWorkerStatus;
  try {
    status = await readAuthorizedAttachedWorkerStatus(context, environments, getAppConfig);
  } catch (error) {
    if (error instanceof CodeWorkspaceSelectionError) throw error;
    logger.warn(
      '[codeCapabilities] Worker workspace capabilities unavailable; workspace selection rejected',
      error instanceof CodeBridgeStatusError ? { reason: error.reason } : undefined,
    );
    throw new CodeWorkspaceSelectionError('worker_unavailable');
  }
  /** Named workspace tools enforce their roots independently of runtime sessions. */
  if (status.status !== 'ready') {
    throw new CodeWorkspaceSelectionError('worker_unavailable');
  }
  if (!status.workspaces || !status.operations) {
    throw new CodeWorkspaceSelectionError('unsupported');
  }
  const workspace = status.workspaces.find(({ id }) => id === selection.workspaceId);
  if (!workspace) {
    throw new CodeWorkspaceSelectionError('missing');
  }
  return {
    ...context,
    codeWorkspace: {
      ...selection,
      operations: [...(workspace.operations ?? status.operations)],
      ...(context.conversationWorkspaceInstanceId &&
      workspace.workspaceInstances?.includes('git_worktree')
        ? { workspaceInstanceId: context.conversationWorkspaceInstanceId }
        : {}),
      ...(status.maxCommandTimeoutMs == null
        ? {}
        : { maxCommandTimeoutMs: status.maxCommandTimeoutMs }),
      ...(workspace.instructions ? { instructions: workspace.instructions } : {}),
      ...(workspace.environment ? { environment: workspace.environment } : {}),
    },
  };
}

/** Require explicit capability support for the selected execution route. */
export async function supportsProgrammaticCodeExecution(
  context?: CodeExecutionContext,
  environments?: readonly CodeEnvironmentConfig[],
  getAppConfig?: CodeCapabilityConfigLoader,
): Promise<boolean> {
  if (context?.environmentType !== 'attached') return true;
  try {
    const status = await readAuthorizedAttachedWorkerStatus(context, environments, getAppConfig);
    if (context.codeWorkspace != null) {
      const selected = context.codeWorkspace;
      const workspace = status.workspaces?.find(({ id }) => id === selected.workspaceId);
      return (
        status.status === 'ready' &&
        selected.environmentId === context.environmentId &&
        selected.operations.includes('execute_command') &&
        workspace != null &&
        (workspace.operations ?? status.operations)?.includes('execute_command') === true &&
        status.programmaticLanguages?.includes('bash') === true
      );
    }
    return (
      status.status === 'ready' &&
      status.statefulWorkspace === true &&
      status.runtimes?.includes('bash') === true
    );
  } catch {
    logger.warn('[codeCapabilities] Worker capabilities unavailable; programmatic Bash disabled');
    return false;
  }
}

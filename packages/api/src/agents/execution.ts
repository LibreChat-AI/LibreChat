import { createHash } from 'node:crypto';
import { logger } from '@librechat/data-schemas';
import { Constants, getCodeBaseURL } from '@librechat/agents';
import type {
  Agents,
  CodeWorkspaceOperation,
  CodeWorkspaceDescriptor,
  CodeWorkspaceSelection,
  CodeEnvironmentUserConfigSchema,
  CodeEnvironmentUserSettings,
  StatefulCodeEnvironment,
  TAgentsEndpoint,
} from 'librechat-data-provider';

export const CODE_API_EXPECTED_PROFILE_HEADER = 'X-CodeAPI-Expected-Profile';
export const CODE_API_BRIDGE_WORKER_HEADER = 'X-LibreChat-Code-Worker-ID';

export type CodeExecutionProfile = 'default' | 'stateful';
export type CodeEnvironmentConfig = NonNullable<
  NonNullable<TAgentsEndpoint['statefulCodeSessions']>['environments']
>[number] & {
  /** Server-resolved control plane for a principal-owned attached environment. */
  controlPlaneId?: string;
};

export interface CodeExecutionContext {
  baseUrl: string;
  codeSessionKey: string;
  executionProfile: CodeExecutionProfile;
  /** Stable server-side namespace for deployment-local file references and
   * priming work. Unlike `executionProfile`, this distinguishes configured
   * Code API deployments that all use the `stateful` wire profile. */
  executionRouteKey?: string;
  runtimeSessionHint?: string;
  statefulSessions: boolean;
  environmentId?: string;
  environmentType?: CodeEnvironmentConfig['type'];
  bridgeWorkerId?: string;
  codeEnvironmentConfigSchema?: CodeEnvironmentUserConfigSchema;
  codeEnvironmentSettings?: CodeEnvironmentUserSettings;
  /** Server-derived conversation identity, activated only after worker capability negotiation. */
  conversationWorkspaceInstanceId?: string;
  /** Live, server-validated directory selection. Never derive session reuse from this field. */
  codeWorkspace?: CodeWorkspaceSelection & {
    operations: CodeWorkspaceOperation[];
    workspaceInstanceId?: string;
    /** Live Code API execution ceiling. Omitted by older deployments. */
    maxCommandTimeoutMs?: number;
    instructions?: CodeWorkspaceDescriptor['instructions'];
    environment?: CodeWorkspaceDescriptor['environment'];
  };
}

/** Removes live capability data before a workspace binding is persisted. */
export function getCodeWorkspaceSelections(
  contexts: Array<
    | Pick<CodeExecutionContext, 'environmentId' | 'environmentType' | 'codeWorkspace'>
    | null
    | undefined
  >,
): CodeWorkspaceSelection[] | undefined {
  const selections = new Map<string, CodeWorkspaceSelection>();
  for (const context of contexts) {
    const workspace = context?.codeWorkspace;
    if (
      context?.environmentType !== 'attached' ||
      context.environmentId == null ||
      workspace == null ||
      workspace.environmentId !== context.environmentId
    ) {
      continue;
    }
    selections.set(workspace.environmentId, {
      environmentId: workspace.environmentId,
      workspaceId: workspace.workspaceId,
    });
  }
  if (selections.size === 0) return undefined;
  return [...selections.values()].sort((a, b) => a.environmentId.localeCompare(b.environmentId));
}

type CodeExecutionApprovalAgent = {
  id?: string | null;
  codeExecutionContext?: CodeExecutionContext | null;
};

const CODE_EXECUTION_TARGET_HASH = /^[a-f0-9]{64}$/;
const MAX_CODE_EXECUTION_APPROVAL_TARGETS = 128;

/**
 * Captures an opaque identity for every stateful code target reachable by a
 * paused run. Raw base URLs, worker IDs and session hints never enter the
 * pending-action client projection.
 */
export function captureCodeExecutionApprovalBinding(
  agents: readonly (CodeExecutionApprovalAgent | null | undefined)[],
): Agents.CodeExecutionApprovalBinding | undefined {
  const targetsByIdentity = new Map<string, Agents.CodeExecutionApprovalTargetBinding>();
  for (const agent of agents) {
    const context = agent?.codeExecutionContext;
    if (context?.statefulSessions !== true) {
      continue;
    }
    const targetHash = createHash('sha256')
      .update(
        JSON.stringify([
          agent?.id ?? null,
          context.executionProfile,
          context.baseUrl,
          context.codeSessionKey,
          context.executionRouteKey ?? null,
          context.runtimeSessionHint ?? null,
          context.environmentId ?? null,
          context.environmentType ?? null,
          context.bridgeWorkerId ?? null,
          context.codeWorkspace == null
            ? null
            : {
                environmentId: context.codeWorkspace.environmentId,
                workspaceId: context.codeWorkspace.workspaceId,
                workspaceInstanceId: context.codeWorkspace.workspaceInstanceId ?? null,
                operations: [...new Set(context.codeWorkspace.operations)].sort(),
                ...(context.codeWorkspace.environment
                  ? { definitionFingerprint: context.codeWorkspace.environment.fingerprint }
                  : {}),
              },
        ]),
      )
      .digest('hex');
    const target = { agentId: agent?.id ?? null, targetHash };
    targetsByIdentity.set(`${target.agentId ?? ''}\u0000${target.targetHash}`, target);
  }
  const targets = [...targetsByIdentity.values()];
  if (targets.length === 0) {
    return undefined;
  }
  /** Relational string comparison is defined over UTF-16 code units. Unlike
   * localeCompare, this produces the same canonical order on every replica
   * regardless of its ICU build or process locale. */
  targets.sort((left, right) => {
    const leftAgentId = left.agentId ?? '';
    const rightAgentId = right.agentId ?? '';
    if (leftAgentId !== rightAgentId) {
      return leftAgentId < rightAgentId ? -1 : 1;
    }
    if (left.targetHash === right.targetHash) {
      return 0;
    }
    return left.targetHash < right.targetHash ? -1 : 1;
  });
  return { version: 1, targets };
}

function isCodeExecutionApprovalBinding(
  value: unknown,
): value is Agents.CodeExecutionApprovalBinding {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const binding = value as Partial<Agents.CodeExecutionApprovalBinding>;
  if (
    binding.version !== 1 ||
    !Array.isArray(binding.targets) ||
    binding.targets.length === 0 ||
    binding.targets.length > MAX_CODE_EXECUTION_APPROVAL_TARGETS
  ) {
    return false;
  }
  const identities = new Set<string>();
  for (const target of binding.targets) {
    if (
      target == null ||
      typeof target !== 'object' ||
      Array.isArray(target) ||
      !(
        target.agentId === null ||
        (typeof target.agentId === 'string' && target.agentId.length <= 256)
      ) ||
      typeof target.targetHash !== 'string' ||
      !CODE_EXECUTION_TARGET_HASH.test(target.targetHash)
    ) {
      return false;
    }
    const identity = `${target.agentId ?? ''}\u0000${target.targetHash}`;
    if (identities.has(identity)) {
      return false;
    }
    identities.add(identity);
  }
  return true;
}

export class CodeExecutionApprovalTargetChangedError extends Error {
  readonly code = 'CODE_EXECUTION_APPROVAL_TARGET_CHANGED';

  constructor() {
    super(
      'The attached code environment changed while this action awaited approval. Retry the request and review the action again before running it.',
    );
    this.name = 'CodeExecutionApprovalTargetChangedError';
  }
}

/** Backward-compatible for old pauses; present bindings always fail closed. */
export function assertCodeExecutionApprovalBinding(
  expected: unknown,
  agents: readonly (CodeExecutionApprovalAgent | null | undefined)[],
): void {
  if (expected == null) {
    return;
  }
  const current = captureCodeExecutionApprovalBinding(agents);
  if (
    !isCodeExecutionApprovalBinding(expected) ||
    current == null ||
    JSON.stringify(expected.targets) !== JSON.stringify(current.targets)
  ) {
    throw new CodeExecutionApprovalTargetChangedError();
  }
}

export function createCodeExecutionRouteKey(
  profile: CodeExecutionProfile,
  environment?: Pick<CodeEnvironmentConfig, 'id' | 'baseURL' | 'workerId' | 'pairing'>,
): string {
  if (profile === 'default' || environment == null) {
    return profile;
  }
  const identity = JSON.stringify([
    environment.id,
    environment.baseURL.trim().replace(/\/+$/, ''),
    environment.workerId ?? environment.pairing?.workerId ?? '',
  ]);
  return `stateful:${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}

export function getCodeExecutionRouteKey(
  context: Pick<CodeExecutionContext, 'executionProfile' | 'executionRouteKey'>,
): string {
  return context.executionRouteKey ?? context.executionProfile;
}

export function normalizeStatefulCodeEnvironment(
  environment?: StatefulCodeEnvironment | string | null,
): StatefulCodeEnvironment {
  if (environment === 'agent-user') {
    return 'agent-user';
  }
  if (environment === 'conversation') {
    return 'conversation';
  }
  return 'user';
}

export function getCodeExecutionBaseUrl(
  profile: CodeExecutionProfile,
  environment?: CodeEnvironmentConfig,
): string {
  if (profile === 'default') {
    return getCodeBaseURL().replace(/\/+$/, '');
  }
  if (environment) {
    return environment.baseURL.trim().replace(/\/+$/, '');
  }
  const baseUrl = process.env.LIBRECHAT_CODE_BASEURL_STATEFUL?.trim().replace(/\/+$/, '');
  if (baseUrl) {
    return baseUrl;
  }
  throw new Error(
    'Stateful code execution is enabled for this agent, but LIBRECHAT_CODE_BASEURL_STATEFUL is not configured.',
  );
}

function resolveRuntimeSessionHint(params: {
  environment: StatefulCodeEnvironment;
  environmentId?: string;
  userId: string;
  agentId?: string | null;
  conversationId?: string | null;
}): string {
  const { environment, environmentId, userId, agentId, conversationId } = params;
  const scopeFingerprint = (...parts: string[]): string =>
    createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
  const prefix = environmentId ? `v3:${scopeFingerprint(environmentId).slice(0, 12)}` : 'v2';
  if (environment === 'agent-user') {
    if (!agentId) {
      throw new Error('Agent-user code environments require an agent ID.');
    }
    return `${prefix}:agent-user:${scopeFingerprint(userId, agentId)}`;
  }
  if (environment === 'conversation') {
    if (!conversationId) {
      throw new Error('Conversation code environments require a conversation ID.');
    }
    return `${prefix}:conversation:${scopeFingerprint(userId, conversationId)}`;
  }
  return `${prefix}:user:${scopeFingerprint(userId)}`;
}

function resolveConfiguredEnvironment(params: {
  environmentId?: string | null;
  environments?: readonly CodeEnvironmentConfig[];
}): CodeEnvironmentConfig | undefined {
  const { environmentId, environments } = params;
  const executableEnvironments = environments?.filter(
    (environment) =>
      !(
        environment.pairing?.allowPrincipalWorkers === true &&
        environment.pairing.workerId == null &&
        environment.workerId == null
      ),
  );
  if (environmentId) {
    const configured = executableEnvironments?.find(
      (environment) => environment.id === environmentId,
    );
    if (!configured) {
      throw new Error(`Stateful code environment "${environmentId}" is not configured.`);
    }
    return configured;
  }
  return executableEnvironments?.find((environment) => environment.default === true);
}

export function resolveCodeExecutionContext(params: {
  statefulSessions: boolean;
  environment?: StatefulCodeEnvironment | string | null;
  environmentId?: string | null;
  environments?: readonly CodeEnvironmentConfig[];
  userId?: string | null;
  agentId?: string | null;
  conversationId?: string | null;
}): CodeExecutionContext {
  if (!params.statefulSessions) {
    return {
      baseUrl: getCodeExecutionBaseUrl('default'),
      codeSessionKey: Constants.EXECUTE_CODE,
      executionProfile: 'default',
      statefulSessions: false,
    };
  }

  const environment = normalizeStatefulCodeEnvironment(params.environment);
  const configuredEnvironment = resolveConfiguredEnvironment(params);
  if (!params.userId) {
    throw new Error('Stateful code environments require an authenticated user ID.');
  }
  const runtimeSessionHint = resolveRuntimeSessionHint({
    environment,
    environmentId: configuredEnvironment?.id,
    userId: params.userId,
    agentId: params.agentId,
    conversationId: params.conversationId,
  });
  const executionRouteKey = createCodeExecutionRouteKey('stateful', configuredEnvironment);
  const conversationWorkspaceInstanceId =
    configuredEnvironment?.type === 'attached' && params.conversationId
      ? createHash('sha256')
          .update('librechat-conversation-workspace-v1\0')
          .update(JSON.stringify([params.userId, params.conversationId, configuredEnvironment.id]))
          .digest('hex')
      : undefined;
  return {
    baseUrl: getCodeExecutionBaseUrl('stateful', configuredEnvironment),
    codeSessionKey: `${Constants.EXECUTE_CODE}:${executionRouteKey}:${runtimeSessionHint}`,
    executionProfile: 'stateful',
    ...(configuredEnvironment ? { executionRouteKey } : {}),
    runtimeSessionHint,
    statefulSessions: true,
    environmentId: configuredEnvironment?.id,
    environmentType: configuredEnvironment?.type,
    bridgeWorkerId: configuredEnvironment?.workerId ?? configuredEnvironment?.pairing?.workerId,
    codeEnvironmentConfigSchema: configuredEnvironment?.configSchema,
    codeEnvironmentSettings: configuredEnvironment?.settings,
    ...(conversationWorkspaceInstanceId ? { conversationWorkspaceInstanceId } : {}),
  };
}

export function codeExecutionHeaders(
  context: Pick<CodeExecutionContext, 'executionProfile' | 'bridgeWorkerId'>,
): Record<string, string> {
  return {
    [CODE_API_EXPECTED_PROFILE_HEADER]: context.executionProfile,
    ...(context.bridgeWorkerId != null
      ? { [CODE_API_BRIDGE_WORKER_HEADER]: context.bridgeWorkerId }
      : {}),
  };
}

/**
 * The cause belongs in the message rather than in winston metadata. A caught
 * value passed as metadata is merged onto the log record, so a rejection
 * carrying `tenantId`, `userId` or `event_name` would overwrite the request
 * identity this log exists to provide; and any metadata makes `format.splat()`
 * treat a `%s` in the cause as a substitution token. Every read is guarded:
 * `String()` throws on a null-prototype object and a proxy can throw from a
 * `name` or `message` accessor, either of which would otherwise replace the
 * rejection with a formatting error and log nothing.
 */
function describeAuthFailure(error: unknown): string {
  try {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } catch {
    return 'undescribable rejection';
  }
}

/**
 * `@librechat/agents` replaces any throw from this callback with a fixed
 * "not authorized" string before the model or the operator sees it, and its own
 * console diagnostic carries no request or user id. This log is the only
 * request-correlated record of why the headers could not be resolved.
 */
export async function codeExecutionAuthHeaders(
  authHeaders: (
    bridgeWorkerId?: string,
  ) => Promise<Record<string, string>> | Record<string, string>,
  context: Pick<CodeExecutionContext, 'executionProfile' | 'bridgeWorkerId'>,
): Promise<Record<string, string>> {
  try {
    return {
      ...(await authHeaders(context.bridgeWorkerId)),
      ...codeExecutionHeaders(context),
    };
  } catch (error) {
    logger.error(
      `[codeExecutionAuthHeaders] Failed to resolve Code API auth headers | Profile: ${context.executionProfile}` +
        (context.bridgeWorkerId != null ? ` | Worker: ${context.bridgeWorkerId}` : '') +
        ` | Cause: ${describeAuthFailure(error)}`,
    );
    throw error;
  }
}

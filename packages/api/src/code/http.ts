import { nanoid } from 'nanoid';
import { EModelEndpoint } from 'librechat-data-provider';
import { logger, type AppConfig } from '@librechat/data-schemas';
import type { CodeEnvironmentMode, CodeWorkspaceSelection } from 'librechat-data-provider';
import type { Response } from 'express';
import type {
  CodeEnvironmentLifecycleTarget,
  CodeEnvironmentPrincipalContext,
  CodeEnvironmentRegistration,
  CodeEnvironmentSummary,
  AccessibleCodeEnvironmentDetails,
  AccessibleCodeEnvironmentConfiguration,
} from './environments';
import type { ConversationCodeEnvironmentMove, StoredConversationDecision } from './decision';
import type { CodeBridgeFetch, CodeBridgeWorkerStatus } from './bridge';
import type { JobStatus } from '~/stream/interfaces/IJobStore';
import type { GetAppConfigOptions } from '~/app/service';
import type { ServerRequest } from '~/types/http';
import {
  CodeBridgeLifecycleError,
  CodeBridgePairingError,
  CodeBridgeStatusError,
  createCodeBridgeStatusPoller,
  createCodeBridgePairing,
  readCodeBridgeSecret,
  revokeCodeBridgeWorker,
} from './bridge';
import {
  CodeEnvironmentInUseError,
  CodeEnvironmentLimitError,
  CodeEnvironmentValidationError,
  normalizeCodeEnvironmentName,
} from './environments';
import {
  assertCodeApiJwtSigningReady,
  getCodeApiTenantId,
  isCodeApiJwtAuthEnabled,
} from '~/auth/codeapi';
import {
  CodeEnvironmentSettingsValidationError,
  validateCodeEnvironmentUserSettings,
} from './settings';
import {
  resolveCodeEnvironmentMoveVersion,
  resolveCodeEnvironmentTransitionVersion,
} from './config';
import { resolveConversationCodeEnvironmentMove } from './decision';
import { resolveCodeWorkerEnrollmentLimit } from './enrollment';
import { CodeWorkspaceSelectionError } from './capabilities';
import { getAppConfigOptionsFromUser } from '~/app/service';

type Registry = {
  register: (params: {
    actor: CodeEnvironmentPrincipalContext;
    environment: CodeEnvironmentRegistration;
    maxOwned?: number;
  }) => Promise<CodeEnvironmentSummary>;
  listAccessible: (actor: CodeEnvironmentPrincipalContext) => Promise<CodeEnvironmentSummary[]>;
  listAccessibleDetails?: (
    actor: CodeEnvironmentPrincipalContext,
  ) => Promise<AccessibleCodeEnvironmentDetails>;
  listAccessibleConfigurations?: (
    actor: CodeEnvironmentPrincipalContext,
  ) => Promise<AccessibleCodeEnvironmentConfiguration[]>;
  resolvePrincipals?: (
    actor: CodeEnvironmentPrincipalContext,
  ) => Promise<NonNullable<CodeEnvironmentPrincipalContext['principals']>>;
  updateSettings?: (params: {
    actor: CodeEnvironmentPrincipalContext;
    environmentId: string;
    settings: import('librechat-data-provider').CodeEnvironmentUserSettings;
  }) => Promise<CodeEnvironmentSummary | null>;
  remove: (params: {
    actor: CodeEnvironmentPrincipalContext;
    environmentId: string;
    beforeDelete?: (target: CodeEnvironmentLifecycleTarget) => Promise<void>;
  }) => Promise<CodeEnvironmentSummary | null>;
  markRevocationPending?: (environmentId: string) => Promise<void>;
};

type StatefulCodeConfig = NonNullable<
  NonNullable<AppConfig['endpoints']>[EModelEndpoint.agents]
>['statefulCodeSessions'];
type ConfiguredCodeEnvironment = NonNullable<
  NonNullable<StatefulCodeConfig>['environments']
>[number];

/** Owner-scoped conversation access for moving a sealed code-environment decision. */
export interface CodeEnvironmentConversationDeps {
  get: (userId: string, conversationId: string) => Promise<StoredConversationDecision | null>;
  replaceDecision: (params: {
    user: string;
    conversationId: string;
    expected: Pick<
      StoredConversationDecision,
      'codeEnvironmentMode' | 'codeWorkspaces' | 'codeEnvironmentRevision'
    >;
    codeEnvironmentMode: CodeEnvironmentMode;
    /** Omitted by a detach, which leaves the conversation without any attached selection. */
    codeWorkspaces?: CodeWorkspaceSelection[];
  }) => Promise<StoredConversationDecision | null>;
}

/** Generation lookups a move needs to tell whether any run can still act for a conversation. */
export interface CodeEnvironmentGenerationDeps {
  getJob: (streamId: string) => Promise<CodeEnvironmentGenerationJob | null | undefined>;
  /** Remote API runs use response IDs as stream identities, so the conversation's own stream
   *  is not the only generation that can still act in its environment. */
  getCleanupBlockingJobIdsForConversations: (
    userId: string,
    conversationIds: readonly string[],
    tenantId?: string,
  ) => Promise<string[]>;
}

/** The generation state a move reads to tell whether a run can still save its own decision. */
export type CodeEnvironmentGenerationJob = {
  status: JobStatus;
  metadata?: { terminalPersistencePending?: boolean };
};

export interface CodeEnvironmentHttpDeps {
  getAppConfig: (options: GetAppConfigOptions) => Promise<AppConfig>;
  registry: Registry;
  conversations?: CodeEnvironmentConversationDeps;
  generations?: CodeEnvironmentGenerationDeps;
  createEnvironmentId?: () => string;
  readSecret?: (name: string) => string | undefined;
  resolveTenantId?: (req: ServerRequest) => string;
  principalAuthEnabled?: () => boolean;
  principalAuthReady?: () => Promise<void> | void;
  principalIsActive?: (userId: string) => Promise<boolean>;
  maxPrincipalEnvironments?: number;
  fetchImpl?: CodeBridgeFetch;
}

function actor(req: ServerRequest): CodeEnvironmentPrincipalContext | null {
  if (!req.user?.id) return null;
  return {
    userId: req.user.id,
    role: req.user.role ?? null,
    idOnTheSource: req.user.idOnTheSource ?? null,
  };
}

function configuredControlPlane(
  appConfig: AppConfig,
  controlPlaneId: string,
): ConfiguredCodeEnvironment | undefined {
  return appConfig.endpoints?.[EModelEndpoint.agents]?.statefulCodeSessions?.environments?.find(
    (environment) =>
      environment.id === controlPlaneId &&
      environment.type === 'attached' &&
      environment.owner === 'deployment' &&
      environment.pairing?.workerId != null,
  );
}

function configuredPrincipalControlPlane(
  appConfig: AppConfig,
  controlPlaneId: string,
): ConfiguredCodeEnvironment | undefined {
  return appConfig.endpoints?.[EModelEndpoint.agents]?.statefulCodeSessions?.environments?.find(
    (environment) =>
      environment.id === controlPlaneId &&
      environment.type === 'attached' &&
      environment.owner === 'deployment' &&
      environment.pairing?.allowPrincipalWorkers === true,
  );
}

function principalControlPlanes(appConfig: AppConfig): Array<{
  id: string;
  name: string;
  configSchema?: ConfiguredCodeEnvironment['configSchema'];
}> {
  return (
    appConfig.endpoints?.[EModelEndpoint.agents]?.statefulCodeSessions?.environments
      ?.filter(
        (environment) =>
          environment.type === 'attached' &&
          environment.owner === 'deployment' &&
          environment.pairing?.allowPrincipalWorkers === true,
      )
      .map(({ id, name, configSchema }) => ({ id, name, configSchema })) ?? []
  );
}

function configuredAttachedControlPlane(
  appConfig: AppConfig,
  controlPlaneId: string,
): ConfiguredCodeEnvironment | undefined {
  return appConfig.endpoints?.[EModelEndpoint.agents]?.statefulCodeSessions?.environments?.find(
    (environment) =>
      environment.id === controlPlaneId &&
      environment.type === 'attached' &&
      environment.owner === 'deployment',
  );
}

type WorkerPolicy = {
  configurations: AccessibleCodeEnvironmentConfiguration[];
  effectiveConfig: AppConfig;
  deploymentConfig: AppConfig;
};

type WorkerTarget = { controlPlane: ConfiguredCodeEnvironment; workerId: string };

/** Resolves the deployment control plane and worker a principal may poll for one environment. */
function selectWorkerTarget(policy: WorkerPolicy, environmentId: string): WorkerTarget | undefined {
  const { configurations, effectiveConfig, deploymentConfig } = policy;
  const configuration = configurations.find(({ id }) => id === environmentId);
  if (configuration == null) {
    const effectiveEnvironment = configuredControlPlane(effectiveConfig, environmentId);
    const deploymentEnvironment = configuredControlPlane(deploymentConfig, environmentId);
    const workerId = deploymentEnvironment?.pairing?.workerId;
    if (
      effectiveEnvironment == null ||
      deploymentEnvironment == null ||
      workerId == null ||
      effectiveEnvironment.pairing?.workerId !== workerId
    ) {
      return undefined;
    }
    return { controlPlane: deploymentEnvironment, workerId };
  }
  const { controlPlaneId, workerId } = configuration;
  if (
    controlPlaneId == null ||
    workerId == null ||
    configuredAttachedControlPlane(effectiveConfig, controlPlaneId) == null
  ) {
    return undefined;
  }
  const controlPlane = configuredAttachedControlPlane(deploymentConfig, controlPlaneId);
  return controlPlane == null ? undefined : { controlPlane, workerId };
}

/** A terminal claim marks the job settled before its response save lands, so that save still
 *  writes the decision the run started with until `terminalPersistencePending` clears. */
function isGenerationActive(job: CodeEnvironmentGenerationJob | null | undefined): boolean {
  return (
    job?.status === 'running' ||
    job?.status === 'requires_action' ||
    job?.metadata?.terminalPersistencePending === true
  );
}

function selectionErrorResponse(error: CodeWorkspaceSelectionError, res: Response): Response {
  return res
    .status(error.status)
    .json({ error: error.message, code: error.code, reason: error.reason });
}

class CodeEnvironmentLifecycleHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function pairingErrorResponse(error: unknown, res: Response): Response {
  if (!(error instanceof CodeBridgePairingError)) {
    return res.status(502).json({ error: 'Code API pairing request failed' });
  }
  if (error.reason === 'timeout') {
    return res.status(504).json({ error: 'Code API pairing request timed out' });
  }
  if (error.reason === 'rejected') {
    return res.status(502).json({
      error: 'Code API rejected the pairing request',
      upstreamStatus: error.upstreamStatus,
    });
  }
  return res.status(502).json({
    error:
      error.reason === 'invalid'
        ? 'Code API returned an invalid pairing response'
        : 'Code API pairing request failed',
  });
}

function statusErrorCode(reason: CodeBridgeStatusError['reason']): number {
  if (reason === 'timeout') return 504;
  if (reason === 'busy') return 503;
  return 502;
}

export function createCodeEnvironmentHttpHandlers(deps: CodeEnvironmentHttpDeps): {
  list: (req: ServerRequest, res: Response) => Promise<Response>;
  register: (req: ServerRequest, res: Response) => Promise<Response>;
  pair: (req: ServerRequest, res: Response) => Promise<Response>;
  status: (req: ServerRequest, res: Response) => Promise<Response>;
  updateSettings: (req: ServerRequest, res: Response) => Promise<Response>;
  remove: (req: ServerRequest, res: Response) => Promise<Response>;
  moveConversationDecision: (req: ServerRequest, res: Response) => Promise<Response>;
} {
  const createEnvironmentId = deps.createEnvironmentId ?? (() => `code-${nanoid(20)}`);
  const readSecret = deps.readSecret ?? readCodeBridgeSecret;
  const resolveTenantId = deps.resolveTenantId ?? getCodeApiTenantId;
  const principalAuthEnabled = deps.principalAuthEnabled ?? isCodeApiJwtAuthEnabled;
  const principalAuthReady = deps.principalAuthReady ?? assertCodeApiJwtSigningReady;
  const principalIsActive = deps.principalIsActive ?? (async () => true);
  const workerStatus = createCodeBridgeStatusPoller({ fetchImpl: deps.fetchImpl });

  async function loadWorkerPolicy(
    req: ServerRequest,
    principal: CodeEnvironmentPrincipalContext,
  ): Promise<WorkerPolicy> {
    const principals = await deps.registry.resolvePrincipals?.(principal);
    const resolvedPrincipal = principals == null ? principal : { ...principal, principals };
    const [configurations, effectiveConfig, deploymentConfig] = await Promise.all([
      deps.registry.listAccessibleConfigurations?.(resolvedPrincipal) ?? Promise.resolve([]),
      deps.getAppConfig({
        ...getAppConfigOptionsFromUser(req.user),
        ...(principals == null ? {} : { resolvedPrincipals: principals }),
        failClosed: true,
        skipRuntimeAugmentation: true,
      }),
      deps.getAppConfig({ baseOnly: true }),
    ]);
    return { configurations, effectiveConfig, deploymentConfig };
  }

  function readControlPlaneToken(controlPlane: ConfiguredCodeEnvironment): string | undefined {
    const tokenEnv = controlPlane.pairing?.tokenEnv;
    return tokenEnv == null ? undefined : readSecret(tokenEnv)?.trim();
  }

  /** Applies the run path's live workspace checks to a selection before it is persisted. */
  async function assertWorkspaceRegistered(
    policy: WorkerPolicy,
    selection: CodeWorkspaceSelection,
    previousWorkspaceId?: string,
  ): Promise<void> {
    const target = selectWorkerTarget(policy, selection.environmentId);
    if (target == null) {
      throw new CodeWorkspaceSelectionError('invalid');
    }
    const token = readControlPlaneToken(target.controlPlane);
    if (!token) {
      throw new CodeWorkspaceSelectionError('worker_unavailable');
    }
    let current: CodeBridgeWorkerStatus;
    try {
      current = await workerStatus({
        baseURL: target.controlPlane.baseURL,
        token,
        workerId: target.workerId,
        bypassCache: true,
      });
    } catch (error) {
      if (error instanceof CodeBridgeStatusError) {
        throw new CodeWorkspaceSelectionError('worker_unavailable');
      }
      throw error;
    }
    if (current.status !== 'ready') {
      throw new CodeWorkspaceSelectionError('worker_unavailable');
    }
    if (!current.workspaces || !current.operations) {
      throw new CodeWorkspaceSelectionError('unsupported');
    }
    if (!current.workspaces.some(({ id }) => id === selection.workspaceId)) {
      throw new CodeWorkspaceSelectionError('missing');
    }
    if (
      previousWorkspaceId != null &&
      previousWorkspaceId !== selection.workspaceId &&
      current.workspaces.some(({ id }) => id === previousWorkspaceId)
    ) {
      throw new CodeWorkspaceSelectionError('locked');
    }
  }

  /**
   * Replaces a conversation's sealed code-environment decision with the one its owner chose: a
   * move onto the environments its agents now use, an attach for a chat that has been running
   * without one, or a detach off a machine it can no longer reach. Applies only when the effective
   * policy enables moves. Runs never rewrite a stored decision, so no run from any ingress can
   * write its run-start decision back over one of these. Each is still refused while a generation
   * is running, awaiting approval, or saving its response, so that generation does not keep
   * working in the previous environment after the conversation has left it.
   */
  async function moveConversationDecision(req: ServerRequest, res: Response): Promise<Response> {
    const principal = actor(req);
    if (principal == null) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { conversations, generations } = deps;
    if (conversations == null || generations == null) {
      return res.status(503).json({ error: 'Conversation code environments are not configured' });
    }
    const conversationId = (
      req.params as { conversationId?: string } | undefined
    )?.conversationId?.trim();
    if (!conversationId) {
      return res.status(400).json({ error: 'Conversation id is required' });
    }
    let policy: WorkerPolicy;
    try {
      policy = await loadWorkerPolicy(req, principal);
    } catch (error) {
      logger.error('[codeEnvironments] move policy resolution failed:', error);
      return res.status(503).json({ error: 'Code environment policy is unavailable' });
    }
    if (resolveCodeEnvironmentMoveVersion(policy.effectiveConfig) == null) {
      return res.status(403).json({ error: 'Conversation code environment moves are disabled' });
    }
    const { from, to } = (req.body ?? {}) as { from?: unknown; to?: unknown };
    const userId = principal.userId.toString();
    const tenantId =
      typeof req.user?.tenantId === 'string' && req.user.tenantId !== ''
        ? req.user.tenantId
        : undefined;
    const [conversation, job, conversationRunIds] = await Promise.all([
      conversations.get(userId, conversationId),
      generations.getJob(conversationId),
      generations.getCleanupBlockingJobIdsForConversations(userId, [conversationId], tenantId),
    ]);
    if (conversation == null) {
      return res.status(404).json({ error: 'Conversation was not found' });
    }
    const busyResponse = () =>
      res
        .status(409)
        .json({ error: 'Wait for the current response to finish before moving this conversation' });
    if (isGenerationActive(job) || conversationRunIds.length > 0) {
      return busyResponse();
    }

    let move: ConversationCodeEnvironmentMove;
    try {
      move = resolveConversationCodeEnvironmentMove({ conversation, from, to });
      if (
        (conversation.codeEnvironmentMode === 'without_attached' ||
          move.mode === 'without_attached') &&
        resolveCodeEnvironmentTransitionVersion(policy.effectiveConfig) == null
      ) {
        return res
          .status(403)
          .json({ error: 'Conversation code environment attach/detach is disabled' });
      }
    } catch (error) {
      if (error instanceof CodeWorkspaceSelectionError) {
        return selectionErrorResponse(error, res);
      }
      throw error;
    }
    try {
      await Promise.all(
        (move.codeWorkspaces ?? []).map((selection) =>
          assertWorkspaceRegistered(
            policy,
            selection,
            conversation.codeWorkspaces?.find(
              ({ environmentId }) => environmentId === selection.environmentId,
            )?.workspaceId,
          ),
        ),
      );
    } catch (error) {
      if (error instanceof CodeWorkspaceSelectionError) {
        return selectionErrorResponse(error, res);
      }
      throw error;
    }

    /** Worker checks are network round trips. Recheck long-lived work afterwards. Every admitted
     * run advances the decision revision before reading, while its job remains active. The CAS
     * below catches a run admitted after this final idle check; a run admitted after the CAS
     * instead reads the new decision. */
    const [pendingJob, pendingRunIds] = await Promise.all([
      generations.getJob(conversationId),
      generations.getCleanupBlockingJobIdsForConversations(userId, [conversationId], tenantId),
    ]);
    if (isGenerationActive(pendingJob) || pendingRunIds.length > 0) {
      return busyResponse();
    }

    const moved = await conversations.replaceDecision({
      user: userId,
      conversationId,
      expected: {
        codeEnvironmentMode: conversation.codeEnvironmentMode,
        codeWorkspaces: conversation.codeWorkspaces,
        codeEnvironmentRevision: conversation.codeEnvironmentRevision,
      },
      codeEnvironmentMode: move.mode,
      codeWorkspaces: move.codeWorkspaces,
    });
    if (moved == null) {
      return selectionErrorResponse(new CodeWorkspaceSelectionError('locked'), res);
    }
    return res.status(200).json({
      conversationId,
      codeEnvironmentMode: move.mode,
      ...(move.codeWorkspaces != null && { codeWorkspaces: move.codeWorkspaces }),
    });
  }

  async function list(req: ServerRequest, res: Response): Promise<Response> {
    const principal = actor(req);
    if (principal == null) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    let details: AccessibleCodeEnvironmentDetails;
    let appConfig: AppConfig;
    let deploymentConfig: AppConfig;
    try {
      const principals = await deps.registry.resolvePrincipals?.(principal);
      const resolvedPrincipal = principals == null ? principal : { ...principal, principals };
      [details, appConfig, deploymentConfig] = await Promise.all([
        deps.registry.listAccessibleDetails?.(resolvedPrincipal) ??
          Promise.all([
            deps.registry.listAccessible(resolvedPrincipal),
            deps.registry.listAccessibleConfigurations?.(resolvedPrincipal) ?? Promise.resolve([]),
          ]).then(([summaries, configurations]) => ({ summaries, configurations })),
        deps.getAppConfig({
          ...getAppConfigOptionsFromUser(req.user),
          ...(principals == null ? {} : { resolvedPrincipals: principals }),
          failClosed: true,
          skipRuntimeAugmentation: true,
        }),
        deps.getAppConfig({ baseOnly: true }),
      ]);
    } catch (error) {
      logger.error('[codeEnvironments] discovery policy resolution failed:', error);
      return res.status(503).json({ error: 'Code environment policy is unavailable' });
    }
    const configurationById = new Map(
      details.configurations.map((configuration) => [configuration.id, configuration]),
    );
    return res.status(200).json({
      environments: details.summaries.map((environment) => {
        const configuration = configurationById.get(environment.id);
        const controlPlane =
          configuration == null
            ? undefined
            : configuredAttachedControlPlane(appConfig, configuration.controlPlaneId);
        return {
          ...environment,
          configSchema: controlPlane?.configSchema,
          settings: configuration?.settings,
        };
      }),
      controlPlanes:
        principalAuthEnabled() &&
        resolveCodeWorkerEnrollmentLimit(
          deploymentConfig.endpoints?.agents?.statefulCodeSessions?.principalWorkers,
          appConfig.endpoints?.agents?.statefulCodeSessions?.principalWorkers,
          deps.maxPrincipalEnvironments,
        ) > 0
          ? principalControlPlanes(appConfig)
          : [],
    });
  }

  async function register(req: ServerRequest, res: Response): Promise<Response> {
    const principal = actor(req);
    if (principal == null) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const body =
      typeof req.body === 'object' && req.body != null
        ? (req.body as unknown as Record<string, unknown>)
        : {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const controlPlaneId =
      typeof body.controlPlaneId === 'string' ? body.controlPlaneId.trim() : '';
    if (!name || !controlPlaneId) {
      return res.status(400).json({
        error: 'name and controlPlaneId are required',
      });
    }
    try {
      normalizeCodeEnvironmentName(name);
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : 'Code environment name is invalid',
      });
    }

    /** Control-plane destinations are deployment policy. Client-provided URLs
     * are deliberately ignored to prevent an authenticated SSRF primitive. */
    let effectiveConfig: AppConfig;
    let deploymentConfig: AppConfig;
    try {
      [effectiveConfig, deploymentConfig] = await Promise.all([
        deps.getAppConfig({ ...getAppConfigOptionsFromUser(req.user), failClosed: true }),
        deps.getAppConfig({ baseOnly: true }),
      ]);
    } catch (error) {
      logger.error('[codeEnvironments] control-plane policy resolution failed:', error);
      return res.status(503).json({ error: 'Code environment policy is unavailable' });
    }
    const authorizedControlPlane = configuredControlPlane(effectiveConfig, controlPlaneId);
    const controlPlane = configuredControlPlane(deploymentConfig, controlPlaneId);
    if (authorizedControlPlane == null || controlPlane == null) {
      return res.status(404).json({ error: 'Code control plane was not found' });
    }

    let activeBeforeRegistration: boolean;
    try {
      activeBeforeRegistration = await principalIsActive(principal.userId.toString());
    } catch (error) {
      logger.error('[codeEnvironments] pre-registration principal check failed:', error);
      return res.status(503).json({ error: 'Account status could not be confirmed' });
    }
    if (!activeBeforeRegistration) {
      return res.status(409).json({ error: 'Account deletion is already in progress' });
    }

    try {
      const environment = await deps.registry.register({
        actor: principal,
        environment: {
          id: createEnvironmentId(),
          name,
          type: 'attached',
          baseURL: controlPlane.baseURL,
          workerId: controlPlane.pairing?.workerId,
          controlPlaneId: controlPlane.id,
          workerPrincipal: { type: 'deployment', id: controlPlane.id },
        },
      });
      let activeAfterRegistration = false;
      let principalCheckUnavailable = false;
      try {
        activeAfterRegistration = await principalIsActive(principal.userId.toString());
      } catch (error) {
        principalCheckUnavailable = true;
        logger.error('[codeEnvironments] post-registration principal check failed:', error);
      }
      if (!activeAfterRegistration) {
        await deps.registry.remove({ actor: principal, environmentId: environment.id });
        return principalCheckUnavailable
          ? res.status(503).json({ error: 'Account status could not be confirmed' })
          : res.status(409).json({ error: 'Account deletion is already in progress' });
      }
      return res.status(201).json({ environment });
    } catch (error) {
      const duplicate =
        typeof error === 'object' &&
        error != null &&
        'code' in error &&
        (error as { code?: number }).code === 11000;
      if (duplicate) {
        return res.status(409).json({ error: 'Code environment already exists' });
      }
      if (error instanceof CodeEnvironmentValidationError) {
        return res.status(400).json({ error: error.message });
      }
      logger.error('[codeEnvironments] registration failed:', error);
      return res.status(500).json({ error: 'Code environment registration failed' });
    }
  }

  async function pair(req: ServerRequest, res: Response): Promise<Response> {
    const principal = actor(req);
    if (principal == null) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!principalAuthEnabled()) {
      return res.status(409).json({
        error: 'Principal code workers require Code API JWT authentication',
      });
    }
    const body =
      typeof req.body === 'object' && req.body != null
        ? (req.body as unknown as Record<string, unknown>)
        : {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const controlPlaneId =
      typeof body.controlPlaneId === 'string' ? body.controlPlaneId.trim() : '';
    if (!name || !controlPlaneId) {
      return res.status(400).json({ error: 'name and controlPlaneId are required' });
    }
    try {
      normalizeCodeEnvironmentName(name);
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : 'Code environment name is invalid',
      });
    }
    try {
      await principalAuthReady();
    } catch (error) {
      logger.error('[codeEnvironments] Code API JWT signing is unavailable:', error);
      return res.status(503).json({ error: 'Principal code worker authentication is unavailable' });
    }

    let effectiveConfig: AppConfig;
    let deploymentConfig: AppConfig;
    try {
      [effectiveConfig, deploymentConfig] = await Promise.all([
        deps.getAppConfig({ ...getAppConfigOptionsFromUser(req.user), failClosed: true }),
        deps.getAppConfig({ baseOnly: true }),
      ]);
    } catch (error) {
      logger.error('[codeEnvironments] pairing policy resolution failed:', error);
      return res.status(503).json({ error: 'Code environment pairing policy is unavailable' });
    }
    const authorizedControlPlane = configuredPrincipalControlPlane(effectiveConfig, controlPlaneId);
    const controlPlane = configuredPrincipalControlPlane(deploymentConfig, controlPlaneId);
    if (authorizedControlPlane == null || controlPlane == null) {
      return res.status(404).json({ error: 'Principal code control plane was not found' });
    }
    const maxPrincipalEnvironments = resolveCodeWorkerEnrollmentLimit(
      deploymentConfig.endpoints?.agents?.statefulCodeSessions?.principalWorkers,
      effectiveConfig.endpoints?.agents?.statefulCodeSessions?.principalWorkers,
      deps.maxPrincipalEnvironments,
    );
    if (maxPrincipalEnvironments === 0) {
      return res.status(403).json({ error: 'Personal code worker enrollment is disabled' });
    }
    const tokenEnv = controlPlane.pairing?.tokenEnv;
    const token = tokenEnv != null ? readSecret(tokenEnv)?.trim() : undefined;
    if (!token) {
      return res.status(503).json({ error: 'Code environment pairing is not configured' });
    }

    const workerId = createEnvironmentId();
    let activeBeforePairing: boolean;
    try {
      activeBeforePairing = await principalIsActive(principal.userId.toString());
    } catch (error) {
      logger.error('[codeEnvironments] pre-pairing principal check failed:', error);
      return res.status(503).json({ error: 'Account status could not be confirmed' });
    }
    if (!activeBeforePairing) {
      return res.status(409).json({ error: 'Account deletion is already in progress' });
    }
    let pairing;
    try {
      pairing = await createCodeBridgePairing({
        baseURL: controlPlane.baseURL,
        token,
        workerId,
        binding: {
          tenantId: resolveTenantId(req),
          principal: { type: 'user', id: principal.userId.toString() },
        },
        fetchImpl: deps.fetchImpl,
      });
    } catch (error) {
      return pairingErrorResponse(error, res);
    }

    let activeAfterPairing = false;
    let principalCheckUnavailable = false;
    try {
      activeAfterPairing = await principalIsActive(principal.userId.toString());
    } catch (error) {
      principalCheckUnavailable = true;
      logger.error('[codeEnvironments] post-pairing principal check failed:', error);
    }
    if (!activeAfterPairing) {
      try {
        await revokeCodeBridgeWorker({
          baseURL: controlPlane.baseURL,
          token,
          workerId,
          fetchImpl: deps.fetchImpl,
        });
      } catch (error) {
        logger.error('[codeEnvironments] orphaned pairing compensation failed:', error);
        return res.status(502).json({ error: 'Code worker pairing could not be compensated' });
      }
      return principalCheckUnavailable
        ? res.status(503).json({ error: 'Account status could not be confirmed' })
        : res.status(409).json({ error: 'Account deletion is already in progress' });
    }

    let registrationCommitted = false;
    try {
      const environment = await deps.registry.register({
        actor: principal,
        maxOwned: maxPrincipalEnvironments,
        environment: {
          id: workerId,
          name,
          type: 'attached',
          baseURL: controlPlane.baseURL,
          workerId,
          controlPlaneId: controlPlane.id,
          revocationTokenEnv: tokenEnv,
          workerPrincipal: { type: 'user', id: principal.userId.toString() },
        },
      });
      registrationCommitted = true;
      let activeAfterRegistration = false;
      try {
        activeAfterRegistration = await principalIsActive(principal.userId.toString());
      } catch (error) {
        logger.error('[codeEnvironments] post-registration principal check failed:', error);
      }
      if (!activeAfterRegistration) {
        const removed = await deps.registry.remove({
          actor: principal,
          environmentId: workerId,
          beforeDelete: async () => {
            await revokeCodeBridgeWorker({
              baseURL: controlPlane.baseURL,
              token,
              workerId,
              fetchImpl: deps.fetchImpl,
            });
          },
        });
        if (removed == null) {
          await revokeCodeBridgeWorker({
            baseURL: controlPlane.baseURL,
            token,
            workerId,
            fetchImpl: deps.fetchImpl,
          });
        }
        return res.status(409).json({ error: 'Account is unavailable for code worker pairing' });
      }
      return res.status(201).json({
        environment,
        pairing: {
          workerId: pairing.workerId,
          code: pairing.code,
          expiresAt: pairing.expiresAt,
          endpoint: controlPlane.baseURL,
        },
      });
    } catch (error) {
      if (registrationCommitted) {
        try {
          if (deps.registry.markRevocationPending == null) {
            throw new Error('Code environment cleanup scheduling is unavailable');
          }
          await deps.registry.markRevocationPending(workerId);
        } catch (markerError) {
          logger.error('[codeEnvironments] failed to persist pairing cleanup intent:', markerError);
          return res.status(503).json({ error: 'Code environment cleanup could not be scheduled' });
        }
      }
      try {
        await revokeCodeBridgeWorker({
          baseURL: controlPlane.baseURL,
          token,
          workerId,
          fetchImpl: deps.fetchImpl,
        });
      } catch {
        return res.status(502).json({
          error: 'Code environment registration failed and its pairing could not be revoked',
        });
      }
      const duplicate =
        typeof error === 'object' &&
        error != null &&
        'code' in error &&
        (error as { code?: number }).code === 11000;
      if (duplicate) {
        return res.status(409).json({ error: 'Code environment already exists' });
      }
      if (error instanceof CodeEnvironmentLimitError) {
        return res.status(409).json({ error: error.message });
      }
      if (error instanceof CodeEnvironmentValidationError) {
        return res.status(400).json({ error: error.message });
      }
      logger.error('[codeEnvironments] pairing registration failed:', error);
      return res.status(500).json({ error: 'Code environment registration failed' });
    }
  }

  async function updateSettings(req: ServerRequest, res: Response): Promise<Response> {
    const principal = actor(req);
    if (principal == null) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const environmentId = (
      req.params as { environmentId?: string } | undefined
    )?.environmentId?.trim();
    if (!environmentId) {
      return res.status(400).json({ error: 'Code environment id is required' });
    }
    let appConfig: AppConfig;
    let configurations: AccessibleCodeEnvironmentConfiguration[];
    let resolvedPrincipal = principal;
    try {
      const principals = await deps.registry.resolvePrincipals?.(principal);
      resolvedPrincipal = principals == null ? principal : { ...principal, principals };
      [appConfig, configurations] = await Promise.all([
        deps.getAppConfig({
          ...getAppConfigOptionsFromUser(req.user),
          ...(principals == null ? {} : { resolvedPrincipals: principals }),
          failClosed: true,
          skipRuntimeAugmentation: true,
        }),
        deps.registry.listAccessibleConfigurations?.(resolvedPrincipal) ?? Promise.resolve([]),
      ]);
    } catch (error) {
      logger.error('[codeEnvironments] settings policy resolution failed:', error);
      return res.status(503).json({ error: 'Code environment policy is unavailable' });
    }
    const configuration = configurations.find(({ id }) => id === environmentId);
    const controlPlane =
      configuration == null
        ? undefined
        : configuredAttachedControlPlane(appConfig, configuration.controlPlaneId);
    if (configuration == null || controlPlane == null) {
      return res.status(404).json({ error: 'Code environment was not found' });
    }
    let settings;
    try {
      const body =
        typeof req.body === 'object' && req.body != null
          ? (req.body as unknown as { settings?: unknown })
          : {};
      settings = validateCodeEnvironmentUserSettings(controlPlane.configSchema, body.settings);
    } catch (error) {
      if (error instanceof CodeEnvironmentSettingsValidationError) {
        return res.status(400).json({ error: error.message });
      }
      throw error;
    }
    if (deps.registry.updateSettings == null) {
      return res.status(503).json({ error: 'Code environment settings are unavailable' });
    }
    const environment = await deps.registry.updateSettings({
      actor: resolvedPrincipal,
      environmentId,
      settings,
    });
    if (environment == null) {
      return res.status(404).json({ error: 'Code environment was not found' });
    }
    return res.status(200).json({
      environment: {
        ...environment,
        configSchema: controlPlane.configSchema,
        settings: environment.settings ?? settings,
      },
    });
  }

  async function status(req: ServerRequest, res: Response): Promise<Response> {
    const principal = actor(req);
    if (principal == null) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const environmentId = (
      req.params as { environmentId?: string } | undefined
    )?.environmentId?.trim();
    if (!environmentId) {
      return res.status(400).json({ error: 'Code environment id is required' });
    }

    let target: WorkerTarget | undefined;
    try {
      target = selectWorkerTarget(await loadWorkerPolicy(req, principal), environmentId);
    } catch (error) {
      logger.error('[codeEnvironments] status policy resolution failed:', error);
      return res.status(503).json({ error: 'Code environment policy is unavailable' });
    }
    if (target == null) {
      return res.status(404).json({ error: 'Code environment was not found' });
    }
    const token = readControlPlaneToken(target.controlPlane);
    if (!token) {
      return res.status(503).json({ error: 'Code environment status is not configured' });
    }
    try {
      const currentStatus = await workerStatus({
        baseURL: target.controlPlane.baseURL,
        token,
        workerId: target.workerId,
      });
      return res.status(200).json({ environmentId, ...currentStatus });
    } catch (error) {
      if (error instanceof CodeBridgeStatusError) {
        return res.status(statusErrorCode(error.reason)).json({
          error: 'Code environment status is unavailable',
          ...(error.upstreamStatus == null ? {} : { upstreamStatus: error.upstreamStatus }),
        });
      }
      throw error;
    }
  }

  async function remove(req: ServerRequest, res: Response): Promise<Response> {
    const principal = actor(req);
    if (principal == null) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const params = req.params as Record<string, unknown>;
    const environmentId = typeof params.environmentId === 'string' ? params.environmentId : '';
    if (!environmentId) {
      return res.status(400).json({ error: 'Code environment id is required' });
    }
    try {
      const environment = await deps.registry.remove({
        actor: principal,
        environmentId,
        beforeDelete: async (target) => {
          if (target.workerPrincipal?.type !== 'user' || target.workerId == null) return;
          const tokenEnv = target.revocationTokenEnv;
          const token = tokenEnv != null ? readSecret(tokenEnv)?.trim() : undefined;
          if (!token) {
            throw new CodeEnvironmentLifecycleHttpError(
              503,
              'Code environment revocation is not configured',
            );
          }
          await revokeCodeBridgeWorker({
            baseURL: target.baseURL,
            token,
            workerId: target.workerId,
            fetchImpl: deps.fetchImpl,
          });
        },
      });
      if (environment == null) {
        return res.status(404).json({ error: 'Code environment was not found' });
      }
      return res.status(200).json({ environment });
    } catch (error) {
      if (error instanceof CodeEnvironmentLifecycleHttpError) {
        return res.status(error.status).json({ error: error.message });
      }
      if (error instanceof CodeEnvironmentInUseError) {
        return res.status(409).json({ error: error.message });
      }
      if (error instanceof CodeBridgeLifecycleError) {
        return res.status(error.reason === 'timeout' ? 504 : 502).json({
          error: 'Code environment worker could not be revoked',
          ...(error.upstreamStatus != null ? { upstreamStatus: error.upstreamStatus } : {}),
        });
      }
      throw error;
    }
  }

  return { list, register, pair, status, updateSettings, remove, moveConversationDecision };
}

import { logger } from '@librechat/data-schemas';
import {
  CODE_ENVIRONMENT_DECISION_VERSION,
  CODE_ENVIRONMENT_MOVE_VERSION,
  CODE_ENVIRONMENT_TRANSITION_VERSION,
  CODE_WORKSPACE_RECOVERY_VERSION,
  EModelEndpoint,
} from 'librechat-data-provider';
import type { TStartupConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type {
  AccessibleCodeEnvironmentConfiguration,
  CodeEnvironmentPrincipalContext,
} from './environments';

type ConfigurationRegistry = {
  listAccessibleConfigurations: (
    actor: CodeEnvironmentPrincipalContext,
  ) => Promise<AccessibleCodeEnvironmentConfiguration[]>;
  listRegisteredIds: () => Promise<string[]>;
};

type StatefulCodeConfig = NonNullable<
  NonNullable<AppConfig['endpoints']>[EModelEndpoint.agents]
>['statefulCodeSessions'];
type CodeEnvironmentConfig = NonNullable<NonNullable<StatefulCodeConfig>['environments']>[number];

/**
 * Resolves the deployment-wide browser protocol gate. The exact version match
 * keeps older and future wire shapes on the legacy-safe path.
 */
export function resolveCodeEnvironmentDecisionVersion(
  configuredVersion?: string,
): typeof CODE_ENVIRONMENT_DECISION_VERSION | undefined {
  return configuredVersion === String(CODE_ENVIRONMENT_DECISION_VERSION)
    ? CODE_ENVIRONMENT_DECISION_VERSION
    : undefined;
}

function conversationMovesEnabled(appConfig?: Pick<AppConfig, 'endpoints'> | null): boolean {
  return (
    appConfig?.endpoints?.[EModelEndpoint.agents]?.statefulCodeSessions?.conversationMoves
      ?.enabled === true
  );
}

/** Advertises owner moves of a sealed decision only where the effective policy enables them. */
export function resolveCodeEnvironmentMoveVersion(
  appConfig?: Pick<AppConfig, 'endpoints'> | null,
): typeof CODE_ENVIRONMENT_MOVE_VERSION | undefined {
  return conversationMovesEnabled(appConfig) ? CODE_ENVIRONMENT_MOVE_VERSION : undefined;
}

/**
 * Advertises attach/detach only after a deployment opts in. Keep the original move capability
 * separate so older clients and move-only deployments retain their existing recovery path.
 */
export function resolveCodeEnvironmentTransitionVersion(
  appConfig?: Pick<AppConfig, 'endpoints'> | null,
): typeof CODE_ENVIRONMENT_TRANSITION_VERSION | undefined {
  return conversationMovesEnabled(appConfig) &&
    appConfig?.endpoints?.[EModelEndpoint.agents]?.statefulCodeSessions?.conversationMoves
      ?.allowAttachDetach === true
    ? CODE_ENVIRONMENT_TRANSITION_VERSION
    : undefined;
}

/** Advertises recovery separately so already-open V1 clients retain ordinary environment moves. */
export function resolveCodeEnvironmentMoveCapabilities(
  appConfig?: Pick<AppConfig, 'endpoints'> | null,
): Pick<TStartupConfig, 'codeEnvironmentMoveVersion' | 'codeWorkspaceRecoveryVersion'> {
  const codeEnvironmentMoveVersion = resolveCodeEnvironmentMoveVersion(appConfig);
  if (codeEnvironmentMoveVersion == null) return {};
  return {
    codeEnvironmentMoveVersion,
    codeWorkspaceRecoveryVersion: CODE_WORKSPACE_RECOVERY_VERSION,
  };
}

/** Enables the implicit managed route only after the versioned rollout is complete. */
export function isImplicitStatefulCodeRouteAvailable(
  configuredVersion?: string,
  statefulBaseURL?: string,
): boolean {
  return (
    resolveCodeEnvironmentDecisionVersion(configuredVersion) != null &&
    (statefulBaseURL?.trim().length ?? 0) > 0
  );
}

function isExecutableCodeEnvironment(environment: CodeEnvironmentConfig): boolean {
  return !(
    environment.pairing?.allowPrincipalWorkers === true &&
    environment.pairing.workerId == null &&
    environment.workerId == null
  );
}

function retainDeploymentCodeEnvironments(
  appConfig: AppConfig,
  deploymentConfig: AppConfig,
): AppConfig {
  const agents = appConfig.endpoints?.[EModelEndpoint.agents];
  const sessions = agents?.statefulCodeSessions;
  if (sessions == null) return appConfig;

  return {
    ...appConfig,
    endpoints: {
      ...appConfig.endpoints,
      [EModelEndpoint.agents]: {
        ...agents,
        statefulCodeSessions: {
          ...sessions,
          environments:
            deploymentConfig.endpoints?.[EModelEndpoint.agents]?.statefulCodeSessions
              ?.environments ?? [],
        },
      },
    },
  };
}

export async function mergeAccessibleCodeEnvironments({
  appConfig,
  deploymentConfig,
  actor,
  registry,
}: {
  appConfig: AppConfig;
  deploymentConfig: AppConfig;
  actor: CodeEnvironmentPrincipalContext;
  registry: ConfigurationRegistry;
}): Promise<AppConfig> {
  const agents = appConfig.endpoints?.[EModelEndpoint.agents];
  const sessions = agents?.statefulCodeSessions;
  if (sessions == null) return appConfig;

  let accessible: AccessibleCodeEnvironmentConfiguration[];
  let registeredIds: string[];
  try {
    [accessible, registeredIds] = await Promise.all([
      registry.listAccessibleConfigurations(actor),
      registry.listRegisteredIds(),
    ]);
  } catch (error) {
    logger.error(
      '[mergeAccessibleCodeEnvironments] Unable to authorize principal environments; retaining deployment environments:',
      error,
    );
    return retainDeploymentCodeEnvironments(appConfig, deploymentConfig);
  }
  const deploymentSessions =
    deploymentConfig.endpoints?.[EModelEndpoint.agents]?.statefulCodeSessions;
  const deploymentEnvironments = new Map(
    deploymentSessions?.environments
      ?.filter(
        (environment) =>
          environment.owner === 'deployment' &&
          environment.type === 'attached' &&
          environment.pairing != null,
      )
      .map((environment) => [environment.id, environment]) ?? [],
  );
  const effectiveControlPlanes = new Map(
    sessions.environments
      ?.filter(
        (environment) =>
          environment.owner === 'deployment' &&
          environment.type === 'attached' &&
          environment.pairing != null,
      )
      .map((environment) => [environment.id, environment]) ?? [],
  );
  const registeredAliasIds = new Set(
    registeredIds.filter((environmentId) => !deploymentEnvironments.has(environmentId)),
  );
  const principalEnvironments = accessible.flatMap(
    ({ controlPlaneId, baseURL: _persistedBaseURL, ...environment }) => {
      const controlPlane = deploymentEnvironments.get(controlPlaneId);
      if (controlPlane == null || deploymentEnvironments.has(environment.id)) return [];
      return [
        {
          ...environment,
          controlPlaneId,
          baseURL: controlPlane.baseURL,
          configSchema: effectiveControlPlanes.get(controlPlaneId)?.configSchema,
        },
      ];
    },
  );
  const principalEnvironmentIds = new Set(
    principalEnvironments.map((environment) => environment.id),
  );
  const shadowedDefaultIds = new Set(
    (sessions.environments ?? [])
      .filter(
        (environment) =>
          environment.default === true && principalEnvironmentIds.has(environment.id),
      )
      .map((environment) => environment.id),
  );
  const effectivePrincipalEnvironments = principalEnvironments.map((environment) =>
    shadowedDefaultIds.has(environment.id)
      ? { ...environment, default: true as const }
      : environment,
  );
  const existingEnvironments = sessions.environments ?? [];
  const filteredEnvironments = existingEnvironments.filter(
    (environment) => !registeredAliasIds.has(environment.id),
  );
  if (
    effectivePrincipalEnvironments.length === 0 &&
    filteredEnvironments.length === existingEnvironments.length
  ) {
    return appConfig;
  }
  let mergedEnvironments = [...filteredEnvironments, ...effectivePrincipalEnvironments].map(
    (environment) =>
      !isExecutableCodeEnvironment(environment) &&
      'default' in environment &&
      environment.default === true
        ? { ...environment, default: false as const }
        : environment,
  );
  if (
    mergedEnvironments.length > 0 &&
    !mergedEnvironments.some(
      (environment) =>
        isExecutableCodeEnvironment(environment) &&
        'default' in environment &&
        environment.default === true,
    )
  ) {
    const defaultIndex = mergedEnvironments.findIndex(
      (environment) =>
        isExecutableCodeEnvironment(environment) &&
        (environment.owner !== 'principal' || !process.env.LIBRECHAT_CODE_BASEURL_STATEFUL?.trim()),
    );
    if (defaultIndex >= 0) {
      mergedEnvironments = mergedEnvironments.map((environment, index) =>
        index === defaultIndex ? { ...environment, default: true as const } : environment,
      );
    }
  }

  return {
    ...appConfig,
    endpoints: {
      ...appConfig.endpoints,
      [EModelEndpoint.agents]: {
        ...agents,
        statefulCodeSessions: {
          ...sessions,
          environments: mergedEnvironments,
        },
      },
    },
  };
}

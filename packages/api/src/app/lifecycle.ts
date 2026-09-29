import type { TCustomConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { CustomConfigLoadOptions, CustomConfigLoadMode } from './loader';
import type { ConfigGenerationTracker } from './reload';
import type { AppConfigServiceDeps } from './service';
import { createConfigReloader, retainRestartOnlyConfig } from './reload';
import { createAppConfigService } from './service';

type ConfigServiceDependencies = Omit<
  AppConfigServiceDeps,
  'loadBaseConfig' | 'syncConfigGeneration' | 'bootstrapConfigGeneration'
>;

export type DeploymentConfigService = ReturnType<typeof createAppConfigService> & {
  reloadCustomConfig: ReturnType<typeof createConfigReloader>;
};

export interface DeploymentConfigDependencies {
  loadCustomConfig: (
    printConfig: boolean,
    options: CustomConfigLoadOptions,
  ) => Promise<TCustomConfig | null>;
  buildBaseConfig: (config: TCustomConfig) => Promise<AppConfig>;
  generation: ConfigGenerationTracker;
  configService: ConfigServiceDependencies;
}

/** Compose source loading and explicit publication without putting policy in the CJS host. */
export function createDeploymentConfigService({
  loadCustomConfig,
  buildBaseConfig,
  generation,
  configService,
}: DeploymentConfigDependencies): DeploymentConfigService {
  const loadBaseConfig = async (mode: CustomConfigLoadMode = 'startup', previous?: AppConfig) => {
    const source =
      (await loadCustomConfig(mode === 'startup', {
        mode,
        remoteTimeoutMs: previous?.config?.configReload?.remoteTimeoutMs,
      })) ?? {};
    return buildBaseConfig(retainRestartOnlyConfig(previous?.config, source));
  };

  const service = createAppConfigService({
    ...configService,
    loadBaseConfig,
    ...(generation.distributed
      ? {
          syncConfigGeneration: generation.check,
          bootstrapConfigGeneration: generation.bootstrap,
          getAppliedGeneration: generation.applied,
        }
      : {}),
  });
  const reloadCustomConfig = createConfigReloader({
    loadConfig: (current) =>
      loadCustomConfig(false, {
        mode: 'reload',
        remoteTimeoutMs: current.config?.configReload?.remoteTimeoutMs,
      }),
    buildBaseConfig,
    getBaseConfig: () => service.getAppConfig({ baseOnly: true }),
    replaceBaseConfig: service.replaceBaseConfig,
    clearOverrideCache: service.clearOverrideCache,
    withConfigUpdate: service.withConfigUpdate,
    generation,
  });

  return { ...service, reloadCustomConfig };
}

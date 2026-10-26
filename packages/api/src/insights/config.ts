import { resolveInsightsConfig } from 'librechat-data-provider';
import type { TResolvedInsightsConfig } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';

export type InsightsConfigResolver = (
  req: Pick<ServerRequest, 'config'>,
) => TResolvedInsightsConfig;

/** YAML controls privacy; the legacy switch only supplies missing feature enablement. */
export function createInsightsConfigResolver(
  isLegacyEnabled: () => boolean,
): InsightsConfigResolver {
  return (req: Pick<ServerRequest, 'config'>): TResolvedInsightsConfig => {
    const config = req.config?.interfaceConfig?.insights;
    const resolved = resolveInsightsConfig(config);
    return config === undefined ? { ...resolved, enabled: isLegacyEnabled() } : resolved;
  };
}

import { logger } from '@librechat/data-schemas';
import { EModelEndpoint, openAISettings, anthropicSettings } from 'librechat-data-provider';
import type { TModelsConfig } from 'librechat-data-provider';
import { getSafeErrorMetadata } from '~/utils/errors';

export const FALLBACK_MODEL_BY_ENDPOINT: Partial<Record<string, string>> = {
  [EModelEndpoint.openAI]: openAISettings.model.default,
  [EModelEndpoint.anthropic]: anthropicSettings.model.default,
};

export function pickFirstConfiguredModel(
  endpoint: string,
  modelsConfig?: TModelsConfig,
): string | undefined {
  const models = modelsConfig?.[endpoint];
  return Array.isArray(models)
    ? models.find((model) => typeof model === 'string' && model.length > 0)
    : undefined;
}

interface ImportUser {
  requestUserId: string;
  userRole?: string;
}

interface ImportDefaultsDeps {
  getModelsConfig: (req: {
    user: { id: string; role?: string; tenantId?: string | null };
  }) => Promise<TModelsConfig | null | undefined>;
  getTenantId: () => string | null | undefined;
}

const preferredEndpoints: string[] = [
  EModelEndpoint.openAI,
  EModelEndpoint.anthropic,
  EModelEndpoint.google,
  EModelEndpoint.azureOpenAI,
  EModelEndpoint.bedrock,
];
const excludedEndpoints = new Set<string>([
  EModelEndpoint.assistants,
  EModelEndpoint.azureAssistants,
]);

/** Imports keep their existing fallback selection, independently of discovery fallback rules.
 * A successful empty catalog can still produce an import default. Sending checks model access.
 */
export function createImportDefaults({ getModelsConfig, getTenantId }: ImportDefaultsDeps): {
  resolveImportDefaultModel: (params: ImportUser & { endpoint: string }) => Promise<string>;
  resolveImportDefaultEndpoint: (
    params: ImportUser,
  ) => Promise<{ endpoint: string; model: string }>;
} {
  const loadModels = async ({ requestUserId, userRole }: ImportUser): Promise<TModelsConfig> => {
    try {
      return (
        (await getModelsConfig({
          user: { id: requestUserId, role: userRole, tenantId: getTenantId() },
        })) ?? {}
      );
    } catch (error) {
      logger.warn('Import model discovery failed', getSafeErrorMetadata(error));
      return {};
    }
  };

  return {
    async resolveImportDefaultModel({
      endpoint,
      ...user
    }: ImportUser & { endpoint: string }): Promise<string> {
      return (
        pickFirstConfiguredModel(endpoint, await loadModels(user)) ??
        FALLBACK_MODEL_BY_ENDPOINT[endpoint] ??
        openAISettings.model.default
      );
    },
    async resolveImportDefaultEndpoint(
      user: ImportUser,
    ): Promise<{ endpoint: string; model: string }> {
      const models = await loadModels(user);
      const ordered = [
        ...preferredEndpoints,
        ...Object.keys(models).filter((endpoint) => !preferredEndpoints.includes(endpoint)),
      ];
      for (const endpoint of ordered) {
        if (excludedEndpoints.has(endpoint)) {
          continue;
        }
        const model = pickFirstConfiguredModel(endpoint, models);
        if (model) {
          return { endpoint, model };
        }
      }
      return { endpoint: EModelEndpoint.openAI, model: openAISettings.model.default };
    },
  };
}

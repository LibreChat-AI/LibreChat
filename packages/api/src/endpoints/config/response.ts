import type { TModelsConfig } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';

type ModelLabels = Record<string, Record<string, string>>;

type ModelsResponse = {
  models: TModelsConfig;
  modelLabels: ModelLabels;
};

interface ModelsResponseDeps {
  loadDefaultModels: (req: ServerRequest) => Promise<TModelsConfig>;
  loadConfigModels: (req: ServerRequest, modelLabels?: ModelLabels) => Promise<TModelsConfig>;
}

export async function loadModelsResponse(
  req: ServerRequest,
  deps: ModelsResponseDeps,
): Promise<TModelsConfig | ModelsResponse> {
  const includeLabels = req.query?.includeLabels === 'true';
  const modelLabels: ModelLabels = {};

  const [defaultModelsConfig, customModelsConfig] = await Promise.all([
    deps.loadDefaultModels(req),
    deps.loadConfigModels(req, includeLabels ? modelLabels : undefined),
  ]);

  const models = {
    ...defaultModelsConfig,
    ...customModelsConfig,
  };

  if (includeLabels) {
    return { models, modelLabels };
  }

  return models;
}

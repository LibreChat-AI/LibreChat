import {
  EModelEndpoint,
  normalizeEndpointName,
  materializeModelSpecEndpoints,
} from 'librechat-data-provider';
import type { TCustomConfig } from 'librechat-data-provider';
import logger from '~/config/winston';

/**
 * Sets up Model Specs from the config (`librechat.yaml`) file.
 * @param [endpoints] - The loaded custom configuration for endpoints.
 * @param [modelSpecs] - The loaded custom configuration for model specs.
 * @param [interfaceConfig] - The loaded interface configuration.
 * @returns The processed model specs, if any.
 */
export function processModelSpecs(
  endpoints?: TCustomConfig['endpoints'],
  _modelSpecs?: TCustomConfig['modelSpecs'],
  interfaceConfig?: TCustomConfig['interface'],
): TCustomConfig['modelSpecs'] | undefined {
  if (!_modelSpecs) {
    return undefined;
  }

  /**
   * Fill inferable endpoints (agent specs may omit one) before the
   * missing-endpoint guard below, which would otherwise skip them.
   */
  const specsConfig = materializeModelSpecEndpoints(_modelSpecs);
  const list = specsConfig.list;
  const modelSpecs: typeof list = [];

  const customEndpoints = endpoints?.[EModelEndpoint.custom] ?? [];

  if (interfaceConfig?.modelSelect !== true && (_modelSpecs.addedEndpoints?.length ?? 0) > 0) {
    logger.warn(
      `To utilize \`addedEndpoints\`, which allows provider/model selections alongside model specs, set \`modelSelect: true\` in the interface configuration.

      Example:
      \`\`\`yaml
      interface:
        modelSelect: true
      \`\`\`
      `,
    );
  }

  if (!list || list.length === 0) {
    if (_modelSpecs.enforce) {
      logger.warn(
        'modelSpecs.enforce is true but list is empty — enforcement disabled at runtime.',
      );
    }
    return undefined;
  }

  for (const spec of list) {
    const currentEndpoint = spec.preset?.endpoint as EModelEndpoint | undefined;
    if (!currentEndpoint) {
      logger.warn(
        'A model spec is missing the `endpoint` field within its `preset`. Skipping model spec...',
      );
      continue;
    }
    if (EModelEndpoint[currentEndpoint] && currentEndpoint !== EModelEndpoint.custom) {
      modelSpecs.push(spec);
      continue;
    } else if (currentEndpoint === EModelEndpoint.custom) {
      logger.warn(
        `Model Spec with endpoint "${currentEndpoint}" is not supported. You must specify the name of the custom endpoint (case-sensitive, as defined in your config). Skipping model spec...`,
      );
      continue;
    }

    const normalizedName = normalizeEndpointName(currentEndpoint);
    const endpoint = customEndpoints.find(
      (customEndpoint) => normalizedName === normalizeEndpointName(customEndpoint.name),
    );

    if (!endpoint) {
      logger.warn(`Model spec with endpoint "${currentEndpoint}" was skipped: Endpoint not found in configuration. The \`endpoint\` value must exactly match either a system-defined endpoint or a custom endpoint defined by the user.

For more information, see the documentation at https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/model_specs#endpoint`);
      continue;
    }

    modelSpecs.push({
      ...spec,
      preset: {
        ...spec.preset,
        endpoint: normalizedName,
      },
    });
  }

  return {
    ...specsConfig,
    list: modelSpecs,
  };
}

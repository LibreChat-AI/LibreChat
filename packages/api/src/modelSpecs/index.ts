import {
  parseCompactConvo,
  replaceSpecialVars,
  resolveModelSpecEndpoint,
  type EModelEndpoint,
  type TConversation,
  type TModelSpec,
  type TModelSpecPreset,
  type TPreset,
  type TSpecsConfig,
  type TUser,
} from 'librechat-data-provider';

export const PRIVATE_MODEL_SPEC_PRESET_FIELDS: readonly [
  'promptPrefix',
  'instructions',
  'additional_instructions',
  'system',
  'context',
  'examples',
] = [
  'promptPrefix',
  'instructions',
  'additional_instructions',
  'system',
  'context',
  'examples',
] as const satisfies readonly (keyof TModelSpecPreset)[];

export type PrivateModelSpecPresetField = (typeof PRIVATE_MODEL_SPEC_PRESET_FIELDS)[number];
export type ModelSpecParsedBody = Partial<TConversation | TPreset | TModelSpecPreset> &
  Record<string, unknown>;

export const ENFORCED_MODEL_SPEC_REQUEST_FIELDS: readonly ['chatProjectId'] = [
  'chatProjectId',
] as const satisfies readonly (keyof ModelSpecParsedBody)[];

export type ApplyModelSpecPresetParams = {
  modelSpec: TModelSpec;
  parsedBody: ModelSpecParsedBody;
  endpoint?: string | null;
  endpointType?: string | null;
  defaultParamsEndpoint?: string | null;
  includePresetDefaults?: boolean;
};

export type ApplyModelSpecPresetResult = {
  parsedBody: ModelSpecParsedBody;
  appliedPrivateFields: Set<PrivateModelSpecPresetField>;
  /** The keys an enforced spec locks: exactly the fields its preset defines.
   *  Refusal rules downstream (reasoning-override validation) key off this set,
   *  so its derivation lives with the facade rather than in route wiring. */
  enforcedFields: Set<string>;
};

function hasModelSpecValue(field: PrivateModelSpecPresetField, value: unknown): boolean {
  if (value == null || value === '') {
    return false;
  }

  if (!Array.isArray(value)) {
    return true;
  }

  if (field === 'examples') {
    return value.some((example) => {
      const input = example?.input?.content;
      const output = example?.output?.content;
      return Boolean(input || output);
    });
  }

  return value.length > 0;
}

function pickEnforcedModelSpecRequestFields(parsedBody: ModelSpecParsedBody): ModelSpecParsedBody {
  const requestFields: ModelSpecParsedBody = {};

  for (const field of ENFORCED_MODEL_SPEC_REQUEST_FIELDS) {
    if (parsedBody[field] !== undefined) {
      requestFields[field] = parsedBody[field];
    }
  }

  return requestFields;
}

function mergeModelSpecPreset(
  modelSpec: TModelSpec,
  parsedBody: ModelSpecParsedBody,
  { includePresetDefaults = false }: Pick<ApplyModelSpecPresetParams, 'includePresetDefaults'> = {},
): Pick<ApplyModelSpecPresetResult, 'parsedBody' | 'appliedPrivateFields'> {
  const preset = modelSpec.preset;
  const requestFields = includePresetDefaults
    ? pickEnforcedModelSpecRequestFields(parsedBody)
    : parsedBody;
  const merged = {
    ...requestFields,
    ...(includePresetDefaults ? preset : {}),
    spec: modelSpec.name,
  } as ModelSpecParsedBody;
  const appliedPrivateFields = new Set<PrivateModelSpecPresetField>();

  for (const field of PRIVATE_MODEL_SPEC_PRESET_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(preset, field)) {
      continue;
    }

    if (includePresetDefaults) {
      appliedPrivateFields.add(field);
      continue;
    }

    if (!hasModelSpecValue(field, parsedBody[field])) {
      (merged as Record<string, unknown>)[field] = preset[field];
      appliedPrivateFields.add(field);
    }
  }

  return { parsedBody: merged, appliedPrivateFields };
}

export function findModelSpecByName(
  modelSpecs: Pick<TSpecsConfig, 'list'> | undefined,
  spec: string | null | undefined,
): TModelSpec | undefined {
  if (!spec) {
    return undefined;
  }

  return modelSpecs?.list?.find((modelSpec) => modelSpec.name === spec);
}

export function isModelSpecEndpointMatch(
  modelSpec: Pick<TModelSpec, 'preset'> | undefined,
  endpoint: string | null | undefined,
): boolean {
  return Boolean(modelSpec && endpoint === resolveModelSpecEndpoint(modelSpec));
}

export type ModelSpecEndpointResolution =
  | { modelSpec: TModelSpec }
  | { error: 'invalid-model-spec' | 'model-spec-mismatch' };

/**
 * Resolves the selected spec only when it serves the requested endpoint.
 * Authorization and endpoint construction use this same result so a preset
 * cannot change the resource identity after its access check has completed.
 */
export function resolveModelSpecForEndpoint({
  modelSpecs,
  spec,
  endpoint,
}: {
  modelSpecs: Pick<TSpecsConfig, 'list'> | undefined;
  spec: string;
  endpoint: string | null | undefined;
}): ModelSpecEndpointResolution {
  const modelSpec = findModelSpecByName(modelSpecs, spec);
  if (!modelSpec) {
    return { error: 'invalid-model-spec' };
  }

  if (!isModelSpecEndpointMatch(modelSpec, endpoint)) {
    return { error: 'model-spec-mismatch' };
  }

  return { modelSpec };
}

export function applyModelSpecPreset({
  modelSpec,
  parsedBody,
  endpoint,
  endpointType,
  defaultParamsEndpoint,
  includePresetDefaults,
}: ApplyModelSpecPresetParams): ApplyModelSpecPresetResult {
  const { parsedBody: conversation, appliedPrivateFields } = mergeModelSpecPreset(
    modelSpec,
    parsedBody,
    {
      includePresetDefaults,
    },
  );
  const reparsedBody = parseCompactConvo({
    endpoint: endpoint as EModelEndpoint | undefined,
    endpointType: endpointType as EModelEndpoint | null | undefined,
    conversation,
    defaultParamsEndpoint,
  });

  if (!reparsedBody) {
    throw new Error('Model spec preset produced an empty parsed body');
  }

  const modelSpecParsedBody = reparsedBody as ModelSpecParsedBody;
  if (modelSpec.iconURL != null && modelSpec.iconURL !== '') {
    modelSpecParsedBody.iconURL = modelSpec.iconURL;
  }

  return {
    parsedBody: modelSpecParsedBody,
    appliedPrivateFields,
    enforcedFields: new Set(Object.keys(modelSpec.preset)),
  };
}

export function resolveModelSpecPromptPrefixVariables<T extends { promptPrefix?: string | null }>(
  parsedBody: T,
  user?: TUser | null,
  now?: string | number | Date,
): T {
  if (typeof parsedBody.promptPrefix !== 'string') {
    return parsedBody;
  }

  return {
    ...parsedBody,
    promptPrefix: replaceSpecialVars({
      text: parsedBody.promptPrefix,
      user,
      now,
    }),
  };
}

/**
 * Drops specs marked `showInMenu: false` so they are not advertised to clients
 * (the model selector menu and the startup config). Such specs remain resolvable
 * server-side by name, so a caller that sets `spec: "<name>"` can still use them.
 * Returns the config unchanged when there is no list. Apply before `sanitizeModelSpecs`.
 */
export function excludeHiddenModelSpecs<T extends Partial<TSpecsConfig> | null | undefined>(
  modelSpecs: T,
): T {
  if (!modelSpecs?.list || !Array.isArray(modelSpecs.list)) {
    return modelSpecs;
  }

  return {
    ...modelSpecs,
    list: modelSpecs.list.filter((modelSpec) => modelSpec?.showInMenu !== false),
  } as T;
}

export function sanitizeModelSpecs<T extends Partial<TSpecsConfig> | null | undefined>(
  modelSpecs: T,
): T {
  if (!modelSpecs?.list || !Array.isArray(modelSpecs.list)) {
    return modelSpecs;
  }

  return {
    ...modelSpecs,
    list: modelSpecs.list.map((modelSpec) => {
      if (!modelSpec || typeof modelSpec !== 'object') {
        return modelSpec;
      }

      const preset = modelSpec?.preset;
      const sanitizedModelSpec = { ...modelSpec };
      delete (sanitizedModelSpec as { skills?: unknown }).skills;
      const subagents = sanitizedModelSpec.subagents;
      if (subagents && typeof subagents === 'object') {
        const sanitizedSubagents: TModelSpec['subagents'] = {};
        if (subagents.enabled !== undefined) {
          sanitizedSubagents.enabled = subagents.enabled;
        }
        if (subagents.allowSelf !== undefined) {
          sanitizedSubagents.allowSelf = subagents.allowSelf;
        }
        if (Object.keys(sanitizedSubagents).length > 0) {
          sanitizedModelSpec.subagents = sanitizedSubagents;
        } else {
          delete sanitizedModelSpec.subagents;
        }
      }
      if (!preset || typeof preset !== 'object') {
        return sanitizedModelSpec;
      }

      const sanitizedPreset = { ...preset };
      for (const field of PRIVATE_MODEL_SPEC_PRESET_FIELDS) {
        delete sanitizedPreset[field];
      }

      return {
        ...sanitizedModelSpec,
        preset: sanitizedPreset,
      };
    }),
  } as T;
}
export * from './reasoningOverride';
export * from './persistedReasoningOverride';

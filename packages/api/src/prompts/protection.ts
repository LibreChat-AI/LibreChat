import {
  PROMPT_FILTER_FIELDS,
  MODEL_PARAMETER_FILTER_FIELDS,
  hasActivePiiFields,
} from 'librechat-data-provider';
import type { FiltersConfig } from 'librechat-data-provider';
import type {
  PresetContentInput,
  PromptContentInput,
  PromptRecordInput,
} from '../protection/adapters/submissions';
import type { ProtectionFinding, TextContentFragment } from '../protection/types';
import {
  extractPromptContent,
  extractPresetPromptContent,
  extractModelParameterContent,
} from '../protection/adapters/submissions';
import { inspectContent, inspectContentWithTraversal } from '../protection/runtime';

type PromptProjectionKey = 'name' | 'description' | 'oneliner' | 'category' | 'command' | 'prompt';

type PresetProjectionKey =
  | PromptProjectionKey
  | 'title'
  | 'promptPrefix'
  | 'system'
  | 'context'
  | 'instructions'
  | 'additional_instructions'
  | 'greeting'
  | 'examples'
  | 'stop'
  | 'additionalModelRequestFields'
  | 'additional_model_request_fields'
  | 'response_format'
  | 'responseFormat'
  | 'metadata'
  | 'model_parameters'
  | 'options';

export type ProjectedStoredPrompt<T extends PromptRecordInput> =
  | T
  | (Omit<T, PromptProjectionKey> & {
      readonly prompt: '';
      readonly contentFilterBlocked: true;
    });

export type ProjectedStoredPreset<T extends PresetContentInput> =
  | T
  | (Omit<T, PresetProjectionKey> & {
      readonly title: '';
      readonly contentFilterBlocked: true;
    });

export interface StoredPromptGroupInput extends PromptRecordInput {
  readonly productionPrompt?: PromptRecordInput | null;
}

export type ProjectedStoredPromptGroup<T extends StoredPromptGroupInput> =
  | T
  | (Omit<T, 'productionPrompt'> & {
      readonly productionPrompt?: ProjectedStoredPrompt<PromptRecordInput> | null;
    });

function hasPromptPolicy(filters?: FiltersConfig): boolean {
  return hasActivePiiFields(filters?.prompts?.pii, PROMPT_FILTER_FIELDS);
}

function hasModelParameterPolicy(filters?: FiltersConfig): boolean {
  return hasActivePiiFields(filters?.modelParameters?.pii, MODEL_PARAMETER_FILTER_FIELDS);
}

function isStoredContentBlocked(
  extract: () => Iterable<TextContentFragment>,
  filters: FiltersConfig,
): boolean {
  const { finding, traversalError } = inspectContentWithTraversal(extract, { filters });
  return finding != null || traversalError != null;
}

/** Inspects prompt submission content at the shared typed policy boundary. */
export function inspectPromptContent(
  input: PromptContentInput | null | undefined,
  filters?: FiltersConfig,
): ProtectionFinding | null {
  if (!hasPromptPolicy(filters)) {
    return null;
  }
  return inspectContent(extractPromptContent(input), { filters });
}

function projectStoredPromptWithPolicy<T extends PromptRecordInput>(
  prompt: T,
  filters: FiltersConfig,
): ProjectedStoredPrompt<T> {
  if (!isStoredContentBlocked(() => extractPromptContent({ prompt }), filters)) {
    return prompt;
  }

  const {
    name: _name,
    description: _description,
    oneliner: _oneliner,
    category: _category,
    command: _command,
    prompt: _prompt,
    ...structuralFields
  } = prompt;
  return {
    ...structuralFields,
    prompt: '',
    contentFilterBlocked: true,
  };
}

/** Reapplies current prompt policy while retaining structural management fields. */
export function projectStoredPrompt<T extends PromptRecordInput>(
  prompt: T,
  filters?: FiltersConfig,
): ProjectedStoredPrompt<T> {
  if (filters == null || !hasPromptPolicy(filters)) {
    return prompt;
  }
  return projectStoredPromptWithPolicy(prompt, filters);
}

/** Projects stored prompts in one pass under the current prompt policy. */
export function projectStoredPrompts<T extends PromptRecordInput>(
  prompts: readonly T[],
  filters?: FiltersConfig,
): readonly ProjectedStoredPrompt<T>[] {
  if (filters == null || !hasPromptPolicy(filters)) {
    return prompts;
  }
  return prompts.map((prompt) => projectStoredPromptWithPolicy(prompt, filters));
}

function projectStoredPromptGroupWithPolicy<T extends StoredPromptGroupInput>(
  group: T,
  filters: FiltersConfig,
  forReuse: boolean,
): ProjectedStoredPromptGroup<T> | null {
  if (isStoredContentBlocked(() => extractPromptContent({ group }), filters)) {
    return null;
  }

  const productionPrompt = group.productionPrompt;
  if (productionPrompt == null) {
    return group;
  }
  const projectedPrompt = projectStoredPromptWithPolicy(productionPrompt, filters);
  if (
    forReuse &&
    'contentFilterBlocked' in projectedPrompt &&
    projectedPrompt.contentFilterBlocked === true
  ) {
    return null;
  }
  if (projectedPrompt === productionPrompt) {
    return group;
  }
  return { ...group, productionPrompt: projectedPrompt };
}

/** Omits blocked group metadata and redacts or rejects its production prompt. */
export function projectStoredPromptGroup<T extends StoredPromptGroupInput>(
  group: T,
  filters?: FiltersConfig,
  options: { readonly forReuse?: boolean } = {},
): ProjectedStoredPromptGroup<T> | null {
  if (filters == null || !hasPromptPolicy(filters)) {
    return group;
  }
  return projectStoredPromptGroupWithPolicy(group, filters, options.forReuse === true);
}

/** Projects prompt groups in one pass and omits groups unsafe for the requested use. */
export function projectStoredPromptGroups<T extends StoredPromptGroupInput>(
  groups: readonly T[],
  filters?: FiltersConfig,
  options: { readonly forReuse?: boolean } = {},
): readonly ProjectedStoredPromptGroup<T>[] {
  if (filters == null || !hasPromptPolicy(filters)) {
    return groups;
  }
  const projected: ProjectedStoredPromptGroup<T>[] = [];
  for (const group of groups) {
    const value = projectStoredPromptGroupWithPolicy(group, filters, options.forReuse === true);
    if (value != null) {
      projected.push(value);
    }
  }
  return projected;
}

function projectStoredPresetWithPolicy<T extends PresetContentInput>(
  preset: T,
  filters: FiltersConfig,
  inspectPrompt: boolean,
  inspectModelParameters: boolean,
): ProjectedStoredPreset<T> {
  const promptBlocked =
    inspectPrompt && isStoredContentBlocked(() => extractPresetPromptContent(preset), filters);
  const modelParametersBlocked =
    !promptBlocked &&
    inspectModelParameters &&
    isStoredContentBlocked(() => extractModelParameterContent(preset), filters);
  if (!promptBlocked && !modelParametersBlocked) {
    return preset;
  }

  const {
    name: _name,
    description: _description,
    oneliner: _oneliner,
    category: _category,
    command: _command,
    prompt: _prompt,
    title: _title,
    promptPrefix: _promptPrefix,
    system: _system,
    context: _context,
    instructions: _instructions,
    additional_instructions: _additionalInstructions,
    greeting: _greeting,
    examples: _examples,
    stop: _stop,
    additionalModelRequestFields: _additionalModelRequestFields,
    additional_model_request_fields: _additionalModelRequestFieldsSnakeCase,
    response_format: _responseFormat,
    responseFormat: _responseFormatCamelCase,
    metadata: _metadata,
    model_parameters: _modelParameters,
    options: _options,
    ...structuralFields
  } = preset;
  return {
    ...structuralFields,
    title: '',
    contentFilterBlocked: true,
  };
}

/** Reapplies prompt and model-parameter policy to stored presets. */
export function projectStoredPreset<T extends PresetContentInput>(
  preset: T,
  filters?: FiltersConfig,
): ProjectedStoredPreset<T> {
  if (filters == null) {
    return preset;
  }
  const inspectPrompt = hasPromptPolicy(filters);
  const inspectModelParameters = hasModelParameterPolicy(filters);
  if (!inspectPrompt && !inspectModelParameters) {
    return preset;
  }
  return projectStoredPresetWithPolicy(preset, filters, inspectPrompt, inspectModelParameters);
}

/** Projects stored presets in one pass under the current prompt/model policy. */
export function projectStoredPresets<T extends PresetContentInput>(
  presets: readonly T[],
  filters?: FiltersConfig,
): readonly ProjectedStoredPreset<T>[] {
  if (filters == null) {
    return presets;
  }
  const inspectPrompt = hasPromptPolicy(filters);
  const inspectModelParameters = hasModelParameterPolicy(filters);
  if (!inspectPrompt && !inspectModelParameters) {
    return presets;
  }
  return presets.map((preset) =>
    projectStoredPresetWithPolicy(preset, filters, inspectPrompt, inspectModelParameters),
  );
}

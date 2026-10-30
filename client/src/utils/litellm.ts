import {
  stripAgentIdSuffix,
  findLiteLLMModelDisplaySpec,
  getLiteLLMModelDisplayLabel,
} from 'librechat-data-provider';
import type { TMessage, TModelSpec } from 'librechat-data-provider';

type TModelSpecs = { list?: TModelSpec[] } | null | undefined;

/** The `x-litellm-model-name` header the server persisted on a response message. */
export const getLiteLLMModelName = (
  message?: Pick<TMessage, 'metadata'> | null,
): string | undefined => {
  const modelName = message?.metadata?.litellmModelName;
  return typeof modelName === 'string' && modelName !== '' ? modelName : undefined;
};

/**
 * The label for the model LiteLLM served a response with, or undefined when nothing
 * was captured or the response's spec does not opt in. The spec is the one saved
 * with the served model, never the conversation's current spec, so switching specs
 * later does not change how earlier responses are labeled.
 */
export const getLiteLLMRoutedModelLabel = (
  modelSpecs: TModelSpecs,
  message?: Pick<TMessage, 'metadata'> | null,
): string | undefined => {
  const modelName = getLiteLLMModelName(message);
  const spec = message?.metadata?.litellmRoutedModelSpec;
  if (modelName == null || typeof spec !== 'string' || spec === '') {
    return undefined;
  }
  const modelSpec = findLiteLLMModelDisplaySpec(modelSpecs, { spec });
  return modelSpec != null ? getLiteLLMModelDisplayLabel(modelSpec, modelName) : undefined;
};

/**
 * The routed-model label of one column of a comparison response. The primary
 * agent's column (no `____N` suffix: added-convo agents always carry one) uses the
 * message-level fields; every other agent's model is saved as an entry of
 * `metadata.litellmAgentModels`, matched by its `agentId`.
 */
export const getLiteLLMAgentModelLabel = (
  modelSpecs: TModelSpecs,
  message: Pick<TMessage, 'metadata'> | null | undefined,
  agentId: string,
): string | undefined => {
  if (stripAgentIdSuffix(agentId) === agentId) {
    return getLiteLLMRoutedModelLabel(modelSpecs, message);
  }
  const agentModels: unknown = message?.metadata?.litellmAgentModels;
  const entry = Array.isArray(agentModels)
    ? (
        agentModels as Array<{ agentId?: unknown; modelName?: unknown; spec?: unknown } | null>
      ).find((candidate) => candidate?.agentId === agentId)
    : undefined;
  const modelName = entry?.modelName;
  const spec = entry?.spec;
  if (typeof modelName !== 'string' || modelName === '' || typeof spec !== 'string') {
    return undefined;
  }
  const modelSpec = findLiteLLMModelDisplaySpec(modelSpecs, { spec });
  return modelSpec != null ? getLiteLLMModelDisplayLabel(modelSpec, modelName) : undefined;
};

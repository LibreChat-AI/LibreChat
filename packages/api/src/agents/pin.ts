/**
 * Keys in free-form `modelKwargs` that OpenAI-compatible clients send verbatim in the request body
 * and that select a different model: the model itself, plus OpenRouter (`models`, `route`) and
 * LiteLLM (`fallbacks`) server-side fallback routing.
 */
const MODEL_ROUTING_KWARGS = new Set(['model', 'models', 'route', 'fallbacks']);

type PinnedModelOptions<T, M> = Omit<T, 'fallbacks' | 'modelName'> & { model: M };

/** Final model guard after inference projection; server-owned deployment mapping runs later. */
export function pinAgentModel<T extends Record<string, unknown>, M>(
  modelOptions: T,
  model: M,
): PinnedModelOptions<T, M> {
  const { fallbacks: _fallbacks, modelName: _modelName, ...options } = modelOptions;
  const { modelKwargs } = options;
  if (modelKwargs == null || typeof modelKwargs !== 'object' || Array.isArray(modelKwargs)) {
    return { ...options, model };
  }
  const forwardedKwargs = Object.fromEntries(
    Object.entries(modelKwargs).filter(([key]) => !MODEL_ROUTING_KWARGS.has(key)),
  );
  return { ...options, model, modelKwargs: forwardedKwargs };
}

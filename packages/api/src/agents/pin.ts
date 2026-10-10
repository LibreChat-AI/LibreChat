/**
 * Keys in free-form `modelKwargs` that OpenAI-compatible clients send verbatim in the request body
 * and that select a different model: the model itself, plus OpenRouter (`models`, `route`) and
 * LiteLLM (`fallbacks`) server-side fallback routing.
 */
const MODEL_ROUTING_KWARGS = new Set(['model', 'models', 'route', 'fallbacks']);

type PinnedModelOptions<T, M> = Omit<T, 'fallbacks'> & { model: M };

/**
 * Pins an agent's provider options to its validated model. `model_parameters` is free-form, so
 * a saved agent could otherwise pick models that `validateAgentModel` never checked against the
 * user's allowed models: a top-level `fallbacks` list makes the agents runtime build a second
 * client from user-chosen provider, model and baseURL (with the server's credentials) when the
 * primary call fails, and `modelKwargs` routing keys redirect the provider request itself.
 */
export function pinAgentModel<T extends Record<string, unknown>, M>(
  modelOptions: T,
  model: M,
): PinnedModelOptions<T, M> {
  const { fallbacks: _fallbacks, ...options } = modelOptions;
  const { modelKwargs } = options;
  if (modelKwargs == null || typeof modelKwargs !== 'object' || Array.isArray(modelKwargs)) {
    return { ...options, model };
  }
  const forwardedKwargs = Object.fromEntries(
    Object.entries(modelKwargs).filter(([key]) => !MODEL_ROUTING_KWARGS.has(key)),
  );
  return { ...options, model, modelKwargs: forwardedKwargs };
}

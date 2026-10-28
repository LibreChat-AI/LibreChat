import { isEphemeralAgentId, findLiteLLMModelDisplaySpec } from 'librechat-data-provider';
import type { TModelSpec } from 'librechat-data-provider';
import type * as t from '~/types';

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Response header LiteLLM sets to the deployment model that served the call. */
export const LITELLM_MODEL_NAME_HEADER = 'x-litellm-model-name';

const MAX_MODEL_NAME_LENGTH = 256;

/** Run-scoped holder for the `x-litellm-model-name` of the latest model call;
 *  undefined when that call carried no header (served model unknown). */
export interface LiteLLMModelSink {
  modelName?: string;
}

/**
 * Returns a copy of an OpenAI client `configuration` whose `fetch` records the
 * `x-litellm-model-name` response header into `sink`. Wraps any existing custom
 * `fetch` (direct endpoints, transport timeouts) so its behavior is unchanged.
 *
 * Every response replaces the recorded value, so the sink always describes the
 * latest call: the one that produced the answer. A call without the header
 * clears it, leaving the served model unknown rather than attributing the answer
 * to an earlier call (e.g. a tool-loop step) that reported a different model.
 */
export function captureLiteLLMModel(
  configuration: t.OpenAIConfiguration,
  sink: LiteLLMModelSink,
): t.OpenAIConfiguration {
  const baseFetch = ((configuration as { fetch?: Fetch } | undefined)?.fetch ??
    globalThis.fetch) as Fetch;
  const fetch: Fetch = async (input, init) => {
    const response = await baseFetch(input, init);
    const modelName = response.headers?.get(LITELLM_MODEL_NAME_HEADER)?.trim();
    sink.modelName = modelName ? modelName.slice(0, MAX_MODEL_NAME_LENGTH) : undefined;
    return response;
  };
  return { ...configuration, fetch } as t.OpenAIConfiguration;
}

/** The fields of a run agent that decide whether its served model is captured. */
export interface LiteLLMCaptureAgent {
  id: string;
  provider?: string;
  endpoint?: string | null;
  model?: string | null;
  model_parameters?: { model?: unknown } | null;
}

/** The served model of one non-primary top-level agent, with the spec that enabled it. */
export interface LiteLLMAgentModel {
  agentId: string;
  modelName: string;
  spec: string;
}

/** Response metadata fields describing the models LiteLLM served. */
export interface LiteLLMModelMetadata {
  /** The primary agent's served model. */
  litellmModelName?: string;
  /** The spec that enabled `litellmModelName`. */
  litellmRoutedModelSpec?: string;
  /** Added-convo agents' served models. A list rather than a map keyed by
   *  agent id: ephemeral ids embed model names and labels, which can contain dots,
   *  and a dotted key is not a safe stored field name. */
  litellmAgentModels?: LiteLLMAgentModel[];
}

export interface LiteLLMModelCapture {
  /** The sink for an ephemeral top-level agent whose spec (or endpoint + model) opts in
   *  to `litellmRoutedModel.showOnResponses`; undefined, so nothing is captured,
   *  otherwise. Saved agents are never captured: their rows show the agent's name. */
  getSink: (agent: LiteLLMCaptureAgent) => LiteLLMModelSink | undefined;
  getMetadata: () => LiteLLMModelMetadata;
}

/**
 * Tracks one sink per ephemeral top-level agent, so each agent of an added-convo
 * comparison keeps its own served model instead of the last call overwriting it.
 * Saved agents, including handoff targets, are skipped. The primary agent's model
 * is reported on the message-level fields; the others under `litellmAgentModels`.
 */
export function createLiteLLMModelCapture({
  modelSpecs,
  primaryAgentId,
  primarySpec,
  addedSpec,
}: {
  modelSpecs: { list?: TModelSpec[] } | null | undefined;
  primaryAgentId?: string;
  /** The model spec the conversation uses; only the primary agent was chosen by it. */
  primarySpec?: string | null;
  /** The model spec the added (comparison) conversation uses, which chose every other
   *  ephemeral top-level agent; without one, they match a spec by endpoint and model. */
  addedSpec?: string | null;
}): LiteLLMModelCapture {
  const entries = new Map<string, { spec: string; sink: LiteLLMModelSink } | undefined>();

  const getSink = (agent: LiteLLMCaptureAgent): LiteLLMModelSink | undefined => {
    if (!entries.has(agent.id)) {
      if (!isEphemeralAgentId(agent.id)) {
        entries.set(agent.id, undefined);
        return undefined;
      }
      const model = agent.model_parameters?.model ?? agent.model;
      const modelSpec = findLiteLLMModelDisplaySpec(modelSpecs, {
        spec: agent.id === primaryAgentId ? primarySpec : addedSpec,
        endpoint: agent.endpoint ?? agent.provider,
        model: typeof model === 'string' ? model : undefined,
      });
      entries.set(agent.id, modelSpec != null ? { spec: modelSpec.name, sink: {} } : undefined);
    }
    return entries.get(agent.id)?.sink;
  };

  const getMetadata = (): LiteLLMModelMetadata => {
    const metadata: LiteLLMModelMetadata = {};
    const agentModels: LiteLLMAgentModel[] = [];
    for (const [agentId, entry] of entries) {
      const modelName = entry?.sink.modelName;
      if (entry == null || !modelName) {
        continue;
      }
      if (agentId === primaryAgentId) {
        metadata.litellmModelName = modelName;
        metadata.litellmRoutedModelSpec = entry.spec;
      } else {
        agentModels.push({ agentId, modelName, spec: entry.spec });
      }
    }
    if (agentModels.length > 0) {
      metadata.litellmAgentModels = agentModels;
    }
    return metadata;
  };

  return { getSink, getMetadata };
}

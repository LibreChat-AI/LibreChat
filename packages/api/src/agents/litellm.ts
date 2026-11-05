import {
  stripAgentIdSuffix,
  isEphemeralAgentId,
  findLiteLLMModelDisplaySpec,
} from 'librechat-data-provider';
import type { TModelSpec } from 'librechat-data-provider';
import type { LiteLLMModelSnapshotEntry } from '~/types/stream';
import type * as t from '~/types';

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Response header LiteLLM sets to the deployment model that served the call. */
export const LITELLM_MODEL_NAME_HEADER = 'x-litellm-model-name';

const MAX_MODEL_NAME_LENGTH = 256;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value !== '';

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

/** Bounds a restored snapshot: a run has a handful of top-level agents. */
const MAX_SNAPSHOT_ENTRIES = 32;
const MAX_AGENT_ID_LENGTH = 1024;

export interface LiteLLMModelCapture {
  /** The sink for an ephemeral top-level agent whose spec (or endpoint + model) opts in
   *  to `litellmRoutedModel.showOnResponses`; undefined, so nothing is captured,
   *  otherwise. Saved agents are never captured: their rows show the agent's name. */
  getSink: (agent: LiteLLMCaptureAgent) => LiteLLMModelSink | undefined;
  getMetadata: () => LiteLLMModelMetadata;
  /** Every agent's served model so far, for persisting with a HITL pause; undefined
   *  when nothing was captured. A list, since agent ids can contain dots. */
  getSnapshot: () => LiteLLMModelSnapshotEntry[] | undefined;
  /**
   * Seeds the served models a paused run captured, before the resumed run asks for
   * its sinks. A resume does not rerun the agents that finished before the pause, so
   * without this their models would be lost; an agent that runs again replaces or
   * clears its seeded value with its own calls. Only agents that still opt in get the
   * seed, and malformed entries are dropped rather than trusted.
   */
  restore: (snapshot: unknown) => void;
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
  const seeds = new Map<string, string>();

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
      const seeded = seeds.get(agent.id);
      entries.set(
        agent.id,
        modelSpec != null
          ? { spec: modelSpec.name, sink: seeded != null ? { modelName: seeded } : {} }
          : undefined,
      );
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

  const getSnapshot = (): LiteLLMModelSnapshotEntry[] | undefined => {
    const snapshot: LiteLLMModelSnapshotEntry[] = [];
    for (const [agentId, entry] of entries) {
      const modelName = entry?.sink.modelName;
      if (modelName) {
        snapshot.push({ agentId, modelName });
      }
    }
    return snapshot.length > 0 ? snapshot : undefined;
  };

  const restore = (snapshot: unknown): void => {
    if (!Array.isArray(snapshot)) {
      return;
    }
    for (const candidate of snapshot.slice(0, MAX_SNAPSHOT_ENTRIES) as unknown[]) {
      const { agentId, modelName } = (candidate ?? {}) as Partial<
        Record<keyof LiteLLMModelSnapshotEntry, unknown>
      >;
      if (
        isNonEmptyString(agentId) &&
        agentId.length <= MAX_AGENT_ID_LENGTH &&
        isNonEmptyString(modelName) &&
        modelName.length <= MAX_MODEL_NAME_LENGTH
      ) {
        seeds.set(agentId, modelName);
      }
    }
  };

  return { getSink, getMetadata, getSnapshot, restore };
}

/** The routed-model fields a message branched from one comparison column carries. */
export type LiteLLMBranchMetadata = Required<
  Pick<LiteLLMModelMetadata, 'litellmModelName' | 'litellmRoutedModelSpec'>
>;

/**
 * The served model of the column a message is branched from, promoted to the
 * message-level fields a single-column message is labeled from. The primary
 * agent's column (no `____N` suffix: added-convo agents always carry one) reads the
 * message-level fields; any other column reads its own `litellmAgentModels` entry,
 * never the primary's, so a branch is not attributed to another column's model.
 * Undefined when that column has nothing captured.
 */
export function getLiteLLMBranchMetadata(
  metadata: Record<string, unknown> | null | undefined,
  agentId: string,
): LiteLLMBranchMetadata | undefined {
  let modelName: unknown;
  let spec: unknown;
  if (stripAgentIdSuffix(agentId) === agentId) {
    modelName = metadata?.litellmModelName;
    spec = metadata?.litellmRoutedModelSpec;
  } else {
    const agentModels = metadata?.litellmAgentModels;
    const entry = Array.isArray(agentModels)
      ? (agentModels as Array<Partial<Record<keyof LiteLLMAgentModel, unknown>> | null>).find(
          (candidate) => candidate?.agentId === agentId,
        )
      : undefined;
    modelName = entry?.modelName;
    spec = entry?.spec;
  }
  if (!isNonEmptyString(modelName) || !isNonEmptyString(spec)) {
    return undefined;
  }
  return { litellmModelName: modelName, litellmRoutedModelSpec: spec };
}

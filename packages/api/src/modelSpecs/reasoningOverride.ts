import {
  Constants,
  Providers,
  getModelReasoning,
  effectiveModelReasoning,
  hasExplicitReasoningEffort,
  ReasoningEffort,
  isReasoningOverrideSupported,
  reasoningOverrideSchema,
  ReasoningParameterFormat,
  resolveReasoningSettingForTarget,
  type TEndpointsConfig,
  type TReasoningOverride,
  type TReasoningCapabilityMap,
} from 'librechat-data-provider';
import type { AgentContinuationAdmissionSource } from '~/agents/triggers/host';
import type { ReasoningCapabilityResult } from '~/types';

/** Override keys whose level also turns thinking on. */
const THINKING_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'effort',
  'thinkingLevel',
  'thinkingBudget',
]);

export type ReasoningOverrideRequest =
  | { ok: true; reasoningOverride?: TReasoningOverride }
  | { ok: false; reason: 'invalid-reasoning-override' };

/**
 * Validates the reasoning override a request carries, before the conversation
 * is parsed or an endpoint option is built. An absent override is valid and
 * yields no target, so the caller only has to map `ok: false` onto its own
 * error response instead of knowing the payload's shape.
 */
export function parseReasoningOverrideRequest(raw: unknown): ReasoningOverrideRequest {
  if (raw == null) {
    return { ok: true };
  }
  const parsed = reasoningOverrideSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid-reasoning-override' };
  }
  return { ok: true, reasoningOverride: parsed.data };
}

export type ReasoningOverrideBase = {
  key: TReasoningOverride['key'];
  hadValue: boolean;
  value: unknown;
  thinkingHadValue?: boolean;
  thinkingValue?: unknown;
};

type LoadedAgent = {
  provider?: string | null;
  model?: string | null;
};

type EndpointOption = {
  endpointType?: string | null;
  model_parameters?: (Record<string, unknown> & { model?: string | null }) | null;
  agent?: LoadedAgent | Promise<LoadedAgent | null | undefined> | null;
};

export type ReasoningOverrideInput = {
  reasoningOverride: TReasoningOverride;
  endpointOption: EndpointOption;
  endpoint: string;
  endpointType?: string | null;
  parsedModel?: string | null;
  isAgent: boolean;
  endpointsConfig?: TEndpointsConfig;
  /** Provider-reported efforts per OpenRouter model; absent while unknown. */
  reasoningCapabilities?: TReasoningCapabilityMap;
  defaultParamsEndpoint?: string | null;
  appliedModelSpecPrivateFields?: ReadonlySet<string>;
  enforcedModelSpecFields?: ReadonlySet<string>;
  reasoningOverrideBase?: ReasoningOverrideBase;
};

export type ReasoningOverrideResult =
  | {
      ok: true;
      modelParameters: Record<string, unknown>;
      reasoningOverrideBase: ReasoningOverrideBase;
    }
  | {
      ok: false;
      reason: 'invalid-reasoning-override';
    };

/**
 * Resolves and applies a request-scoped reasoning override without mutating
 * the endpoint option or the saved reasoning value. The middleware owns only
 * request/response wiring; all endpoint capability and model-parameter policy
 * lives behind this interface.
 */
export async function resolveReasoningOverride({
  reasoningOverride,
  endpointOption,
  endpoint,
  endpointType,
  parsedModel,
  isAgent,
  endpointsConfig,
  reasoningCapabilities,
  defaultParamsEndpoint,
  appliedModelSpecPrivateFields = new Set(),
  enforcedModelSpecFields = new Set(),
  reasoningOverrideBase: existingBase,
}: ReasoningOverrideInput): Promise<ReasoningOverrideResult> {
  if (
    appliedModelSpecPrivateFields.has(reasoningOverride.key) ||
    enforcedModelSpecFields.has(reasoningOverride.key)
  ) {
    return { ok: false, reason: 'invalid-reasoning-override' };
  }

  const loadedAgent = await endpointOption.agent;
  const effectiveEndpoint =
    loadedAgent?.provider ?? endpointOption.endpointType ?? endpointType ?? endpoint;
  const modelParameters = endpointOption.model_parameters ?? {};
  const effectiveModel = loadedAgent?.model ?? modelParameters.model ?? parsedModel;
  const customEndpointKey = isAgent ? effectiveEndpoint : endpoint;
  const customParams = endpointsConfig?.[customEndpointKey]?.customParams;

  if (customParams?.reasoningFormat === ReasoningParameterFormat.disabled) {
    return { ok: false, reason: 'invalid-reasoning-override' };
  }

  const modelReasoning =
    effectiveModel == null
      ? undefined
      : effectiveModelReasoning(
          getModelReasoning(reasoningCapabilities, customEndpointKey, effectiveModel),
          customParams?.paramDefinitions,
        );
  /** Auto sends no effort. For a model the provider lists without effort selection it is the one
   *  valid override: it lets a caller clear an effort saved on another model. The disabled and
   *  locked refusals above have already run. */
  const clearsEffort =
    modelReasoning === null &&
    reasoningOverride.key === 'reasoning_effort' &&
    reasoningOverride.value === ReasoningEffort.unset;

  const supportedSetting = resolveReasoningSettingForTarget({
    endpoint: effectiveEndpoint,
    model: effectiveModel,
    isAgent,
    defaultParamsEndpoint: customParams?.defaultParamsEndpoint ?? defaultParamsEndpoint,
    paramDefinitions: customParams?.paramDefinitions,
    reasoningFormat: customParams?.reasoningFormat,
    blockedReasoningKeys: new Set([...appliedModelSpecPrivateFields, ...enforcedModelSpecFields]),
    modelReasoning,
  });

  if (!clearsEffort && !isReasoningOverrideSupported(reasoningOverride, supportedSetting)) {
    return { ok: false, reason: 'invalid-reasoning-override' };
  }

  const enablesThinking = THINKING_LEVEL_KEYS.has(reasoningOverride.key);
  const nextBase =
    existingBase?.key === reasoningOverride.key
      ? existingBase
      : {
          key: reasoningOverride.key,
          hadValue: Object.prototype.hasOwnProperty.call(modelParameters, reasoningOverride.key),
          value: modelParameters[reasoningOverride.key],
          ...(enablesThinking && {
            thinkingHadValue: Object.prototype.hasOwnProperty.call(modelParameters, 'thinking'),
            thinkingValue: modelParameters.thinking,
          }),
        };

  return {
    ok: true,
    reasoningOverrideBase: nextBase,
    modelParameters: {
      ...modelParameters,
      [reasoningOverride.key]: reasoningOverride.value,
      ...(enablesThinking && { thinking: true }),
    },
  };
}

/**
 * The provider's per-model efforts, loaded only when the override is a non-Auto effort on an
 * OpenRouter endpoint: any other target is validated without the catalog, so an
 * unavailable OpenRouter never delays an unrelated request.
 */
async function loadCapabilitiesFor(
  override: TReasoningOverride,
  endpointOption: EndpointOption,
  input: Omit<RequestReasoningOverrideInput, 'reasoningOverride' | 'loadReasoningCapabilities'>,
  load?: (endpoint: string) => Promise<ReasoningCapabilityResult>,
): Promise<TReasoningCapabilityMap | undefined> {
  /** Auto sends no effort, so no catalog entry can change whether it is accepted. */
  if (
    load == null ||
    override.key !== 'reasoning_effort' ||
    override.value === ReasoningEffort.unset
  ) {
    return undefined;
  }
  const loadedAgent = await endpointOption.agent;
  const endpointKey = input.isAgent
    ? (loadedAgent?.provider ?? endpointOption.endpointType ?? input.endpointType ?? input.endpoint)
    : input.endpoint;
  const customParams = input.endpointsConfig?.[endpointKey]?.customParams;
  const paramsEndpoint = customParams?.defaultParamsEndpoint ?? input.defaultParamsEndpoint;
  /** Requests `resolveReasoningOverride` refuses regardless of the catalog fail without it. */
  const locked =
    input.appliedModelSpecPrivateFields?.has(override.key) === true ||
    input.enforcedModelSpecFields?.has(override.key) === true;
  if (
    locked ||
    customParams?.reasoningFormat === ReasoningParameterFormat.disabled ||
    hasExplicitReasoningEffort(customParams?.paramDefinitions)
  ) {
    return undefined;
  }
  return paramsEndpoint === Providers.OPENROUTER
    ? (await load(endpointKey)).capabilities
    : undefined;
}

export type RequestReasoningOverrideInput = Omit<
  ReasoningOverrideInput,
  'reasoningOverride' | 'endpointOption' | 'reasoningOverrideBase' | 'reasoningCapabilities'
> & {
  /** Loads per-model efforts; called only for a request that carries an override. */
  loadReasoningCapabilities?: (endpoint: string) => Promise<ReasoningCapabilityResult>;
  /** The raw request field; validated here, so the caller passes it unparsed. */
  reasoningOverride?: unknown;
  /** Reads the level the branch a fresh turn extends last ran at, for a request that picks none. */
  getBranchReasoningOverride?: (params: {
    user: string;
    conversationId: string;
    parentMessageId: string;
  }) => Promise<unknown>;
};

type BranchReasoningRequest = {
  resumeReplayed?: boolean;
  user?: { id?: string };
  body: {
    conversationId?: unknown;
    parentMessageId?: unknown;
    isEdited?: unknown;
    editedContent?: unknown;
    isRegenerate?: unknown;
    isContinued?: unknown;
  };
};

/**
 * The level a turn without its own pick inherits: the one the branch it extends last ran at, so a
 * composer choice holds for the rest of the conversation until the user picks another. Only a fresh
 * turn inherits: a resume replays its own parameters, and an edit, regeneration or continuation
 * replays a turn that already ran, with the override the client sends for it.
 */
async function loadBranchReasoningOverride(
  req: BranchReasoningRequest,
  getBranchReasoningOverride: RequestReasoningOverrideInput['getBranchReasoningOverride'],
): Promise<TReasoningOverride | undefined> {
  const { conversationId, parentMessageId, isEdited, editedContent, isRegenerate, isContinued } =
    req.body;
  if (
    getBranchReasoningOverride == null ||
    req.resumeReplayed === true ||
    isEdited === true ||
    editedContent != null ||
    isRegenerate === true ||
    isContinued === true ||
    req.user?.id == null ||
    typeof conversationId !== 'string' ||
    conversationId === '' ||
    conversationId === Constants.NEW_CONVO ||
    typeof parentMessageId !== 'string' ||
    parentMessageId === Constants.NO_PARENT
  ) {
    return undefined;
  }
  const stored = await getBranchReasoningOverride({
    user: req.user.id,
    conversationId,
    parentMessageId,
  });
  const parsed = reasoningOverrideSchema.safeParse(stored);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Validates a request's reasoning override, applies it to the built endpoint
 * option and records the trusted base snapshot on the request. A request without
 * an override is left untouched; `false` means the override was malformed or
 * refused and the caller must reject the request.
 *
 * A replayed resume override is trusted server state, not fresh client input:
 * when it no longer validates (the endpoint's reasoning config changed between
 * pause and resume) it is stripped and the resume proceeds on defaults, because
 * rejecting would make the paused checkpoint permanently unresumable. A durable
 * queued turn's admission is the same: the override was validated when it was
 * queued, and rejecting it after the agent changed would dead-letter the turn.
 */
export async function applyRequestReasoningOverride<T extends EndpointOption>(
  req: {
    reasoningOverrideBase?: ReasoningOverrideBase;
    resumeReplayed?: boolean;
    _isAgentTrigger?: boolean;
    user?: { id?: string };
    body: BranchReasoningRequest['body'] & {
      endpointOption: T;
      reasoningOverride?: unknown;
      agentContinuationAdmission?: AgentContinuationAdmissionSource;
    };
  },
  {
    reasoningOverride: raw,
    loadReasoningCapabilities,
    getBranchReasoningOverride,
    ...input
  }: RequestReasoningOverrideInput,
): Promise<boolean> {
  const stripReplayedOverride = (): boolean => {
    delete req.body.reasoningOverride;
    /* The resume already replayed the paused turn's model parameters, override
     * applied, into the endpoint option; dropping only the metadata field would
     * still send the now-unsupported override to the provider. The base the
     * resume replayed alongside it holds the pre-override values, so the strip
     * inverts the application it was captured from. */
    const base = req.reasoningOverrideBase;
    if (base == null) {
      return true;
    }
    const parameters: Record<string, unknown> = {
      ...req.body.endpointOption.model_parameters,
    };
    if (base.hadValue) {
      parameters[base.key] = base.value;
    } else {
      delete parameters[base.key];
    }
    if (base.thinkingHadValue != null) {
      if (base.thinkingHadValue) {
        parameters.thinking = base.thinkingValue;
      } else {
        delete parameters.thinking;
      }
    }
    req.body.endpointOption = {
      ...req.body.endpointOption,
      model_parameters: parameters,
    };
    return true;
  };
  const replayed =
    req.resumeReplayed === true ||
    (req._isAgentTrigger === true && req.body.agentContinuationAdmission != null);
  const request = parseReasoningOverrideRequest(raw);
  if (!request.ok) {
    return replayed ? stripReplayedOverride() : false;
  }
  const inherited = request.reasoningOverride == null;
  const reasoningOverride =
    request.reasoningOverride ??
    (await loadBranchReasoningOverride(req, getBranchReasoningOverride));
  if (reasoningOverride == null) {
    return true;
  }
  /* Thinking switched off for the conversation wins over a level the turn only inherited: applying
     it would turn thinking back on behind the switch. A level picked for this turn still does. */
  if (
    inherited &&
    THINKING_LEVEL_KEYS.has(reasoningOverride.key) &&
    req.body.endpointOption.model_parameters?.thinking === false
  ) {
    return true;
  }
  const resolution = await resolveReasoningOverride({
    ...input,
    reasoningCapabilities: await loadCapabilitiesFor(
      reasoningOverride,
      req.body.endpointOption,
      input,
      loadReasoningCapabilities,
    ),
    reasoningOverride,
    endpointOption: req.body.endpointOption,
    reasoningOverrideBase: req.reasoningOverrideBase,
  });
  /* An inherited level the target no longer takes (a model switch, an enforced spec, an
     unknown catalog) is skipped rather than refused: the user asked for nothing this turn. */
  if (!resolution.ok) {
    if (inherited) {
      return true;
    }
    return replayed ? stripReplayedOverride() : false;
  }
  if (inherited) {
    /* Recorded on the turn like a pick, so the level keeps riding the branch. */
    req.body.reasoningOverride = reasoningOverride;
  }
  req.reasoningOverrideBase = resolution.reasoningOverrideBase;
  req.body.endpointOption = {
    ...req.body.endpointOption,
    model_parameters: resolution.modelParameters,
  };
  return true;
}

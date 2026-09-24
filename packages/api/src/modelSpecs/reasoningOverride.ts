import {
  isReasoningOverrideSupported,
  reasoningOverrideSchema,
  ReasoningParameterFormat,
  resolveReasoningSettingForTarget,
  type TEndpointsConfig,
  type TReasoningOverride,
} from 'librechat-data-provider';

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

  const supportedSetting = resolveReasoningSettingForTarget({
    endpoint: effectiveEndpoint,
    model: effectiveModel,
    isAgent,
    defaultParamsEndpoint: customParams?.defaultParamsEndpoint ?? defaultParamsEndpoint,
    paramDefinitions: customParams?.paramDefinitions,
    reasoningFormat: customParams?.reasoningFormat,
    blockedReasoningKeys: new Set([...appliedModelSpecPrivateFields, ...enforcedModelSpecFields]),
  });

  if (!isReasoningOverrideSupported(reasoningOverride, supportedSetting)) {
    return { ok: false, reason: 'invalid-reasoning-override' };
  }

  const enablesThinking =
    reasoningOverride.key === 'effort' ||
    reasoningOverride.key === 'thinkingLevel' ||
    reasoningOverride.key === 'thinkingBudget';
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

export type RequestReasoningOverrideInput = Omit<
  ReasoningOverrideInput,
  'reasoningOverride' | 'endpointOption' | 'reasoningOverrideBase'
> & {
  /** The raw request field; validated here, so the caller passes it unparsed. */
  reasoningOverride?: unknown;
};

/**
 * Validates a request's reasoning override, applies it to the built endpoint
 * option and records the trusted base snapshot on the request. A request without
 * an override is left untouched; `false` means the override was malformed or
 * refused and the caller must reject the request.
 *
 * A replayed resume override is trusted server state, not fresh client input:
 * when it no longer validates (the endpoint's reasoning config changed between
 * pause and resume) it is stripped and the resume proceeds on defaults, because
 * rejecting would make the paused checkpoint permanently unresumable.
 */
export async function applyRequestReasoningOverride<T extends EndpointOption>(
  req: {
    reasoningOverrideBase?: ReasoningOverrideBase;
    resumeReplayed?: boolean;
    body: { endpointOption: T; reasoningOverride?: unknown };
  },
  { reasoningOverride: raw, ...input }: RequestReasoningOverrideInput,
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
  const request = parseReasoningOverrideRequest(raw);
  if (!request.ok) {
    return req.resumeReplayed === true ? stripReplayedOverride() : false;
  }
  if (request.reasoningOverride == null) {
    return true;
  }
  const resolution = await resolveReasoningOverride({
    ...input,
    reasoningOverride: request.reasoningOverride,
    endpointOption: req.body.endpointOption,
    reasoningOverrideBase: req.reasoningOverrideBase,
  });
  if (!resolution.ok) {
    return req.resumeReplayed === true ? stripReplayedOverride() : false;
  }
  req.reasoningOverrideBase = resolution.reasoningOverrideBase;
  req.body.endpointOption = {
    ...req.body.endpointOption,
    model_parameters: resolution.modelParameters,
  };
  return true;
}

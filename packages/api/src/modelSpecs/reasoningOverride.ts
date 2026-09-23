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
 */
export async function applyRequestReasoningOverride<T extends EndpointOption>(
  req: { reasoningOverrideBase?: ReasoningOverrideBase; body: { endpointOption: T } },
  { reasoningOverride: raw, ...input }: RequestReasoningOverrideInput,
): Promise<boolean> {
  const request = parseReasoningOverrideRequest(raw);
  if (!request.ok) {
    return false;
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
    return false;
  }
  req.reasoningOverrideBase = resolution.reasoningOverrideBase;
  req.body.endpointOption = {
    ...req.body.endpointOption,
    model_parameters: resolution.modelParameters,
  };
  return true;
}

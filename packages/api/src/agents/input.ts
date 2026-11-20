import { z } from 'zod';
import { normalizeEndpointName, extractEnvVariable } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { TEndpoint } from 'librechat-data-provider';
import { resolveCustomEndpointParameters } from '../endpoints/custom/config';
import { resolveAgentInferenceParameters } from './inference';

/** Uses the caller's loaded configuration without database reads or credential resolution. */
export function getAgentInferencePolicy(
  provider: string,
  appConfig?: Pick<AppConfig, 'endpoints'>,
  customEndpoint?: Partial<TEndpoint>,
): {
  provider: string;
  customParams?: TEndpoint['customParams'];
  availableRegions?: readonly string[];
} {
  const endpoint =
    customEndpoint ??
    appConfig?.endpoints?.custom?.find(
      (entry) => normalizeEndpointName(entry.name) === normalizeEndpointName(provider),
    );
  return {
    provider: endpoint?.provider ?? provider,
    customParams: endpoint
      ? resolveCustomEndpointParameters(endpoint, extractEnvVariable(endpoint.baseURL ?? ''))
      : undefined,
    availableRegions: appConfig?.endpoints?.bedrock?.availableRegions,
  };
}

type InferenceWrite = {
  provider?: string | null;
  model?: string | null;
  model_parameters?: Record<string, unknown>;
};

/** Validate a request-owned patch without adding absent fields to partial updates. */
export function applyAgentInferenceInput(
  update: InferenceWrite,
  previous?: Pick<InferenceWrite, 'provider' | 'model'>,
  appConfig?: Pick<AppConfig, 'endpoints'>,
): void {
  if (update.model_parameters == null) {
    return;
  }
  update.model_parameters = parseAgentInferenceInput({
    parameters: update.model_parameters,
    provider: update.provider ?? previous?.provider,
    model: update.model ?? previous?.model,
    appConfig,
  });
}

/** Reject unsupported new input without disclosing submitted values in validation errors. */
export function parseAgentInferenceInput({
  parameters,
  provider,
  model,
  appConfig,
}: {
  parameters?: Record<string, unknown>;
  provider?: string | null;
  model?: string | null;
  appConfig?: Pick<AppConfig, 'endpoints'>;
}): Record<string, unknown> | undefined {
  if (parameters == null) {
    return undefined;
  }
  const { model: suppliedModel, ...settings } = parameters;
  const result = resolveAgentInferenceParameters({
    parameters: settings,
    ...getAgentInferencePolicy(provider ?? '', appConfig),
    model: model ?? '',
  });
  if (suppliedModel != null && suppliedModel !== '' && suppliedModel !== model) {
    result.issues.push({ path: ['model'], code: 'unsupported_parameter' });
  }
  if (result.issues.length > 0) {
    throw new z.ZodError(
      result.issues.map((issue) => ({
        code: z.ZodIssueCode.custom,
        path: ['model_parameters', ...issue.path],
        message:
          issue.code === 'unsupported_parameter'
            ? 'This inference parameter is not permitted for the selected endpoint.'
            : 'Invalid inference parameter value.',
      })),
    );
  }
  return { ...result.parameters, ...result.customParameters };
}

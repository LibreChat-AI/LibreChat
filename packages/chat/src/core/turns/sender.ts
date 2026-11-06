import { getResponseSender, getEphemeralSender, isAgentsEndpoint } from 'librechat-data-provider';
import type { TModelSpec, TEndpointOption, TEndpointsConfig } from 'librechat-data-provider';

/**
 * The response sender label for an endpoint option, mirroring the server's resolution
 * (`modelLabel`, then the spec label, then the endpoint's `modelDisplayLabel`, then
 * `getResponseSender`) so the optimistic label matches the persisted `message.sender`.
 *
 * Agent conversations skip the label chain: their display name is the agent's, and a model or
 * spec label would reveal the model an agent author may intend to keep private.
 */
export function resolveSender(
  endpointOption: TEndpointOption,
  endpointsConfig: TEndpointsConfig | undefined,
  modelSpecs: TModelSpec[] | undefined,
): string {
  const { modelDisplayLabel } = endpointsConfig?.[endpointOption.endpoint ?? ''] ?? {};
  if (isAgentsEndpoint(endpointOption.endpoint)) {
    return getResponseSender({ ...endpointOption, modelDisplayLabel });
  }
  const specName = endpointOption.spec;
  const modelSpec = specName ? modelSpecs?.find((spec) => spec.name === specName) : undefined;
  const sender = getEphemeralSender({
    modelLabel: endpointOption.modelLabel,
    specLabel: modelSpec?.label,
    modelDisplayLabel,
  });
  return sender || getResponseSender({ ...endpointOption, modelDisplayLabel });
}

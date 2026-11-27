import { EModelEndpoint } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';

/** Parameter overrides belong to configured Azure groups. Native OpenAI and
 * endpoints.all do not declare add/drop parameters in their schema. Sharing
 * this selection keeps endpoint discovery and actual initialization aligned. */
export function getOpenAIEndpointParameters(
  appConfig: AppConfig | undefined,
  endpoint: string,
  model?: string,
) {
  const azure =
    endpoint === EModelEndpoint.azureOpenAI ? appConfig?.endpoints?.azureOpenAI : undefined;
  const groupName = model ? azure?.modelGroupMap[model]?.group : undefined;
  const group = groupName ? azure?.groupMap[groupName] : undefined;
  return { addParams: group?.addParams, dropParams: group?.dropParams };
}

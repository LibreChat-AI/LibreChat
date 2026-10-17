import type {
  TPreset,
  TConversation,
  EModelEndpoint,
  TEndpointsConfig,
} from 'librechat-data-provider';
import { getLocalStorageItems } from './localStorage';
import { mapEndpoints } from './endpoints';

type TConvoSetup = Partial<TPreset> | Partial<TConversation>;

type TDefaultEndpoint = { convoSetup: TConvoSetup; endpointsConfig: TEndpointsConfig };

const getEndpointFromSetup = (
  convoSetup: TConvoSetup | null,
  endpointsConfig: TEndpointsConfig,
): EModelEndpoint | null => {
  let { endpoint: targetEndpoint = '' } = convoSetup || {};
  targetEndpoint = targetEndpoint ?? '';
  if (targetEndpoint && endpointsConfig?.[targetEndpoint]) {
    return targetEndpoint as EModelEndpoint;
  } else if (targetEndpoint) {
    console.warn(`Illegal target endpoint ${targetEndpoint}`, endpointsConfig);
  }
  return null;
};

const getEndpointFromLocalStorage = (endpointsConfig: TEndpointsConfig) => {
  try {
    const { lastConversationSetup } = getLocalStorageItems();
    const { endpoint } = lastConversationSetup ?? { endpoint: null };
    const isDefaultConfig = Object.values(endpointsConfig ?? {}).every((value) => !value);

    if (isDefaultConfig && endpoint) {
      return endpoint;
    }

    if (isDefaultConfig && endpoint) {
      return endpoint;
    }

    return endpoint && mapEndpoints(endpointsConfig).includes(endpoint) ? endpoint : null;
  } catch (error) {
    console.error(error);
    return null;
  }
};

const getDefinedEndpoint = (endpointsConfig: TEndpointsConfig) => {
  const endpoints = mapEndpoints(endpointsConfig);
  return endpoints.find((e) => Object.hasOwn(endpointsConfig ?? {}, e));
};

const getDefaultEndpoint = ({
  convoSetup,
  endpointsConfig,
}: TDefaultEndpoint): EModelEndpoint | undefined => {
  return (
    getEndpointFromSetup(convoSetup, endpointsConfig) ||
    getEndpointFromLocalStorage(endpointsConfig) ||
    getDefinedEndpoint(endpointsConfig)
  );
};

export default getDefaultEndpoint;

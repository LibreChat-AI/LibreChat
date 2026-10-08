import { useCallback } from 'react';
import { useGetModelsQuery } from 'librechat-data-provider/react-query';
import {
  excludedKeys,
  getDefaultParamsEndpoint,
  resolveModelCatalogKey,
} from 'librechat-data-provider';
import type {
  TEndpointsConfig,
  TModelsConfig,
  TConversation,
  TPreset,
} from 'librechat-data-provider';
import { getDefaultEndpoint, buildDefaultConvo } from '~/utils';
import { useGetEndpointsQuery } from '~/data-provider';

type TDefaultConvo = {
  conversation: Partial<TConversation>;
  preset?: Partial<TPreset> | null;
  cleanInput?: boolean;
  cleanOutput?: boolean;
};

const exceptions = new Set(['spec', 'iconURL']);

const useDefaultConvo = () => {
  const { data: endpointsConfig = {} as TEndpointsConfig } = useGetEndpointsQuery();
  const { data: modelsConfig = {} as TModelsConfig } = useGetModelsQuery();

  const getDefaultConversation = useCallback(
    ({ conversation: _convo, preset, cleanInput, cleanOutput }: TDefaultConvo) => {
      const endpoint = getDefaultEndpoint({
        convoSetup: preset as TPreset,
        endpointsConfig,
      });

      const models = modelsConfig[resolveModelCatalogKey(endpoint, modelsConfig)] || [];
      const conversation = { ..._convo };
      if (cleanInput === true) {
        for (const key in conversation) {
          if (excludedKeys.has(key) && !exceptions.has(key)) {
            continue;
          }
          if (conversation[key] == null) {
            continue;
          }
          conversation[key] = undefined;
        }
      }

      const defaultParamsEndpoint = getDefaultParamsEndpoint(endpointsConfig, endpoint);

      const defaultConvo = buildDefaultConvo({
        conversation: conversation as TConversation,
        endpoint,
        lastConversationSetup: preset as TConversation,
        models,
        defaultParamsEndpoint,
      });

      if (!cleanOutput) {
        return defaultConvo;
      }

      for (const key in defaultConvo) {
        if (excludedKeys.has(key) && !exceptions.has(key)) {
          continue;
        }
        if (defaultConvo[key] == null) {
          continue;
        }
        defaultConvo[key] = undefined;
      }

      return defaultConvo;
    },
    [endpointsConfig, modelsConfig],
  );

  return getDefaultConversation;
};

export default useDefaultConvo;

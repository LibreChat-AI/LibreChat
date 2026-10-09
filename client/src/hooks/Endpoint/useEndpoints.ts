import React, { useMemo, useCallback } from 'react';
import { Feather } from 'lucide-react';
import { Sparkles, ProviderIcon } from '@librechat/client';
import { useGetModelsQuery } from 'librechat-data-provider/react-query';
import {
  Permissions,
  alternateName,
  EModelEndpoint,
  PermissionTypes,
  getEndpointField,
  getConfigDefaults,
} from 'librechat-data-provider';
import type {
  TEndpointsConfig,
  TAssistantsMap,
  TStartupConfig,
  Assistant,
  Agent,
} from 'librechat-data-provider';
import type { ProviderIconResolution } from './useProviderIcon';
import type { Endpoint } from '~/common';
import { useHasAccess, useShowMarketplace } from '~/hooks';
import { resolveProviderIcon } from './useProviderIcon';
import { useGetEndpointsQuery } from '~/data-provider';
import { mapEndpoints } from '~/utils';

const defaultInterface = getConfigDefaults().interface;

const artSize = 20;
const artClassName = 'text-text-primary shrink-0 icon-md';
const providerArtClassName = 'icon-md shrink-0';

const createEndpointIcon = (
  endpoint: string,
  { provider, imageURL }: ProviderIconResolution,
): React.ReactNode => {
  if (endpoint === EModelEndpoint.agents) {
    return React.createElement(Feather, { size: artSize, className: artClassName });
  }

  if (endpoint === EModelEndpoint.assistants || endpoint === EModelEndpoint.azureAssistants) {
    return React.createElement(Sparkles, { className: artClassName });
  }

  if (imageURL != null) {
    return React.createElement('img', {
      src: imageURL,
      alt: `${endpoint} Icon`,
      className: artClassName,
    });
  }

  return React.createElement(ProviderIcon, {
    provider,
    size: artSize,
    className: providerArtClassName,
  });
};

export const useEndpoints = ({
  agents,
  assistantsMap,
  endpointsConfig,
  startupConfig,
}: {
  agents?: Agent[] | null;
  assistantsMap?: TAssistantsMap;
  endpointsConfig: TEndpointsConfig;
  startupConfig: TStartupConfig | undefined;
}) => {
  const modelsQuery = useGetModelsQuery();
  const { data: endpoints = [] } = useGetEndpointsQuery({ select: mapEndpoints });
  const interfaceConfig = startupConfig?.interface ?? defaultInterface;
  const includedEndpoints = useMemo(
    () => new Set(startupConfig?.modelSpecs?.addedEndpoints ?? []),
    [startupConfig?.modelSpecs?.addedEndpoints],
  );

  const hasAgentAccess = useHasAccess({
    permissionType: PermissionTypes.AGENTS,
    permission: Permissions.USE,
  });
  const showAgentMarketplace = useShowMarketplace();

  const assistants: Assistant[] = useMemo(
    () => Object.values(assistantsMap?.[EModelEndpoint.assistants] ?? {}),
    [assistantsMap],
  );

  const azureAssistants: Assistant[] = useMemo(
    () => Object.values(assistantsMap?.[EModelEndpoint.azureAssistants] ?? {}),
    [assistantsMap],
  );

  const filteredEndpoints = useMemo(() => {
    if (!interfaceConfig.modelSelect) {
      return [];
    }
    const result: EModelEndpoint[] = [];
    for (let i = 0; i < endpoints.length; i++) {
      if (endpoints[i] === EModelEndpoint.agents && !hasAgentAccess) {
        continue;
      }
      if (includedEndpoints.size > 0 && !includedEndpoints.has(endpoints[i])) {
        continue;
      }
      result.push(endpoints[i]);
    }

    return result;
  }, [endpoints, hasAgentAccess, includedEndpoints, interfaceConfig.modelSelect]);

  const endpointRequiresUserKey = useCallback(
    (ep: string) => {
      return !!getEndpointField(endpointsConfig, ep, 'userProvide');
    },
    [endpointsConfig],
  );

  const mappedEndpoints: Endpoint[] = useMemo(() => {
    return filteredEndpoints.reduce<Endpoint[]>((acc, ep) => {
      const hasModels =
        (ep === EModelEndpoint.agents && ((agents?.length ?? 0) > 0 || showAgentMarketplace)) ||
        (ep === EModelEndpoint.assistants && assistants?.length > 0) ||
        (ep !== EModelEndpoint.assistants &&
          ep !== EModelEndpoint.agents &&
          (modelsQuery.data?.[ep]?.length ?? 0) > 0);

      if (ep === EModelEndpoint.agents && !hasModels) {
        return acc;
      }

      // Base result object with formatted default icon
      const result: Endpoint = {
        value: ep,
        label: alternateName[ep] || ep,
        hasModels,
        icon: createEndpointIcon(ep, resolveProviderIcon({ endpoint: ep, endpointsConfig })),
      };

      if (ep === EModelEndpoint.agents && showAgentMarketplace) {
        result.showMarketplace = true;
        result.searchAliases = ['agent marketplace', 'marketplace'];
      }

      // Handle agents case
      if (ep === EModelEndpoint.agents && (agents?.length ?? 0) > 0) {
        result.models = agents?.map((agent) => ({
          name: agent.id,
          isGlobal: agent.isPublic ?? false,
        }));
        result.agentNames = agents?.reduce((acc, agent) => {
          acc[agent.id] = agent.name || '';
          return acc;
        }, {});
        result.modelIcons = agents?.reduce((acc, agent) => {
          acc[agent.id] = agent?.avatar?.filepath;
          return acc;
        }, {});
      }

      // Handle assistants case
      else if (ep === EModelEndpoint.assistants && assistants.length > 0) {
        result.models = assistants.map((assistant: { id: string }) => ({
          name: assistant.id,
          isGlobal: false,
        }));
        result.assistantNames = assistants.reduce(
          (acc: Record<string, string>, assistant: Assistant) => {
            acc[assistant.id] = assistant.name || '';
            return acc;
          },
          {},
        );
        result.modelIcons = assistants.reduce(
          (acc: Record<string, string | undefined>, assistant: Assistant) => {
            acc[assistant.id] = assistant.metadata?.avatar;
            return acc;
          },
          {},
        );
      } else if (ep === EModelEndpoint.azureAssistants && azureAssistants.length > 0) {
        result.models = azureAssistants.map((assistant: { id: string }) => ({
          name: assistant.id,
          isGlobal: false,
        }));
        result.assistantNames = azureAssistants.reduce(
          (acc: Record<string, string>, assistant: Assistant) => {
            acc[assistant.id] = assistant.name || '';
            return acc;
          },
          {},
        );
        result.modelIcons = azureAssistants.reduce(
          (acc: Record<string, string | undefined>, assistant: Assistant) => {
            acc[assistant.id] = assistant.metadata?.avatar;
            return acc;
          },
          {},
        );
      }

      // For other endpoints with models from the modelsQuery
      else if (
        ep !== EModelEndpoint.agents &&
        ep !== EModelEndpoint.assistants &&
        (modelsQuery.data?.[ep]?.length ?? 0) > 0
      ) {
        result.models = modelsQuery.data?.[ep]?.map((model) => ({
          name: model,
          isGlobal: false,
        }));
      }

      acc.push(result);
      return acc;
    }, []);
  }, [
    agents,
    assistants,
    azureAssistants,
    endpointsConfig,
    filteredEndpoints,
    modelsQuery.data,
    showAgentMarketplace,
  ]);

  return {
    mappedEndpoints,
    endpointRequiresUserKey,
  };
};

export default useEndpoints;

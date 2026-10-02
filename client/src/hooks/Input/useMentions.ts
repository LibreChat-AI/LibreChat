import { useMemo } from 'react';
import { useGetModelsQuery } from 'librechat-data-provider/react-query';
import {
  Permissions,
  alternateName,
  PermissionBits,
  EModelEndpoint,
  PermissionTypes,
  isAgentsEndpoint,
  getConfigDefaults,
  isAssistantsEndpoint,
  getEndpointField,
  resolveModelSpecEndpoint,
} from 'librechat-data-provider';
import type { TAssistantsMap, TEndpointsConfig } from 'librechat-data-provider';
import type { MentionOption } from '~/common';
import {
  useGetPresetsQuery,
  useGetEndpointsQuery,
  useListAgentsQuery,
  useGetStartupConfig,
} from '~/data-provider';
import useAssistantListMap from '~/hooks/Assistants/useAssistantListMap';
import { useAgentsMapContext } from '~/Providers/AgentsMapContext';
import { mapEndpoints, getModelLabel, getPresetTitle } from '~/utils';
import { EndpointIcon } from '~/components/Endpoints';
import useHasAccess from '~/hooks/Roles/useHasAccess';
import { filterMentionEndpoints } from './mentions';

const defaultInterface = getConfigDefaults().interface;

const assistantMapFn =
  ({
    endpoint,
    assistantMap,
    endpointsConfig,
  }: {
    endpoint: EModelEndpoint | string;
    assistantMap: TAssistantsMap;
    endpointsConfig: TEndpointsConfig;
  }) =>
  ({ id, name, description }) => ({
    type: endpoint,
    label: name ?? '',
    value: id,
    description: description ?? '',
    icon: EndpointIcon({
      conversation: { assistant_id: id, endpoint },
      containerClassName: 'shadow-stroke overflow-hidden rounded-full',
      endpointsConfig: endpointsConfig,
      context: 'menu-item',
      assistantMap,
      size: 20,
    }),
  });

export default function useMentions({
  assistantMap,
  includeAssistants,
}: {
  assistantMap: TAssistantsMap;
  includeAssistants: boolean;
}) {
  const hasAgentAccess = useHasAccess({
    permissionType: PermissionTypes.AGENTS,
    permission: Permissions.USE,
  });

  const agentsMap = useAgentsMapContext();
  const { data: presets, isLoading: isLoadingPresets } = useGetPresetsQuery();
  const { data: modelsConfig, isLoading: isLoadingModels } = useGetModelsQuery();
  const { data: startupConfig, isLoading: isLoadingStartup } = useGetStartupConfig();
  const { data: endpointsConfig, isLoading: isLoadingEndpoints } = useGetEndpointsQuery();
  const { data: endpoints = [] } = useGetEndpointsQuery({
    select: mapEndpoints,
  });
  const listMap = useAssistantListMap((res) =>
    res.data.map(({ id, name, description }) => ({
      id,
      name,
      description,
    })),
  );
  const interfaceConfig = useMemo(
    () => startupConfig?.interface ?? defaultInterface,
    [startupConfig?.interface],
  );
  const includedEndpoints = useMemo(
    () => new Set(startupConfig?.modelSpecs?.addedEndpoints ?? []),
    [startupConfig?.modelSpecs?.addedEndpoints],
  );
  const validEndpoints = useMemo(
    () =>
      filterMentionEndpoints({
        endpoints,
        includedEndpoints,
        includeAssistants,
        hasAgentAccess,
      }),
    [endpoints, includedEndpoints, includeAssistants, hasAgentAccess],
  );
  const validEndpointSet = useMemo(() => new Set(validEndpoints), [validEndpoints]);
  const agentQueryEnabled =
    hasAgentAccess &&
    interfaceConfig.modelSelect === true &&
    (includedEndpoints.size === 0 || includedEndpoints.has(EModelEndpoint.agents));
  const { data: agentsList = null, isLoading: isLoadingAgents } = useListAgentsQuery(
    { requiredPermission: PermissionBits.VIEW },
    {
      enabled: agentQueryEnabled,
      select: (res) => {
        const { data } = res;
        return data.map(({ id, name, avatar }) => ({
          value: id,
          label: name ?? '',
          type: EModelEndpoint.agents,
          icon: EndpointIcon({
            conversation: {
              agent_id: id,
              endpoint: EModelEndpoint.agents,
              iconURL: avatar?.filepath,
            },
            containerClassName: 'shadow-stroke overflow-hidden rounded-full',
            endpointsConfig: endpointsConfig,
            context: 'menu-item',
            size: 20,
          }),
        }));
      },
    },
  );
  const assistantListMap = useMemo(
    () => ({
      [EModelEndpoint.assistants]: listMap[EModelEndpoint.assistants]
        ?.map(
          assistantMapFn({
            endpoint: EModelEndpoint.assistants,
            assistantMap,
            endpointsConfig,
          }),
        )
        .filter(Boolean),
      [EModelEndpoint.azureAssistants]: listMap[EModelEndpoint.azureAssistants]
        ?.map(
          assistantMapFn({
            endpoint: EModelEndpoint.azureAssistants,
            assistantMap,
            endpointsConfig,
          }),
        )
        .filter(Boolean),
    }),
    [listMap, assistantMap, endpointsConfig],
  );

  const modelSpecs = useMemo(() => {
    const specs = startupConfig?.modelSpecs?.list ?? [];
    if (!agentsMap) {
      return specs;
    }

    /**
     * Filter modelSpecs to only include agents the user has access to.
     * Use agentsMap which already contains permission-filtered agents (consistent with other components).
     */
    return specs.filter((spec) => {
      if (spec.preset?.endpoint === EModelEndpoint.agents && spec.preset?.agent_id) {
        return spec.preset.agent_id in agentsMap;
      }
      /** Keep non-agent modelSpecs */
      return true;
    });
  }, [startupConfig, agentsMap]);

  const options: MentionOption[] = useMemo(() => {
    const modelOptions = validEndpoints.flatMap((endpoint) => {
      if (isAssistantsEndpoint(endpoint) || isAgentsEndpoint(endpoint)) {
        return [];
      }

      if (interfaceConfig.modelSelect !== true) {
        return [];
      }

      const modelLabels = getEndpointField(endpointsConfig, endpoint, 'modelLabels');
      const models = (modelsConfig?.[endpoint] ?? []).map((model) => ({
        value: model,
        label: getModelLabel(modelLabels, model) ?? model,
        endpoint,
        type: 'model' as const,
        icon: EndpointIcon({
          conversation: { endpoint, model },
          endpointsConfig,
          context: 'menu-item',
          size: 20,
        }),
      }));
      return models;
    });

    const mentions = [
      ...(modelSpecs.length > 0 ? modelSpecs : []).map((modelSpec) => ({
        value: modelSpec.name,
        label: modelSpec.label,
        description: modelSpec.description,
        icon: EndpointIcon({
          conversation: {
            ...modelSpec.preset,
            endpoint: resolveModelSpecEndpoint(modelSpec) ?? null,
            iconURL: modelSpec.iconURL,
          },
          endpointsConfig,
          context: 'menu-item',
          size: 20,
        }),
        type: 'modelSpec' as const,
      })),
      ...(interfaceConfig.modelSelect === true ? validEndpoints : []).map((endpoint) => ({
        value: endpoint,
        label: alternateName[endpoint as string] ?? endpoint ?? '',
        type: 'endpoint' as const,
        icon: EndpointIcon({
          conversation: { endpoint },
          endpointsConfig,
          context: 'menu-item',
          size: 20,
        }),
      })),
      ...(interfaceConfig.modelSelect === true && validEndpointSet.has(EModelEndpoint.agents)
        ? (agentsList ?? [])
        : []),
      ...(endpointsConfig?.[EModelEndpoint.assistants] &&
      includeAssistants &&
      validEndpointSet.has(EModelEndpoint.assistants) &&
      interfaceConfig.modelSelect === true
        ? assistantListMap[EModelEndpoint.assistants] || []
        : []),
      ...(endpointsConfig?.[EModelEndpoint.azureAssistants] &&
      includeAssistants &&
      validEndpointSet.has(EModelEndpoint.azureAssistants) &&
      interfaceConfig.modelSelect === true
        ? assistantListMap[EModelEndpoint.azureAssistants] || []
        : []),
      ...((interfaceConfig.modelSelect === true && interfaceConfig.presets === true
        ? presets
        : []
      )?.map((preset, index) => ({
        value: preset.presetId ?? `preset-${index}`,
        label: preset.title ?? preset.modelLabel ?? preset.chatGptLabel ?? '',
        description: getPresetTitle(preset, true),
        icon: EndpointIcon({
          conversation: preset,
          containerClassName: 'shadow-stroke overflow-hidden rounded-full',
          endpointsConfig: endpointsConfig,
          context: 'menu-item',
          assistantMap,
          size: 20,
        }),
        type: 'preset' as const,
      })) ?? []),
      ...modelOptions,
    ];

    return mentions;
  }, [
    presets,
    modelSpecs,
    agentsList,
    assistantMap,
    modelsConfig,
    validEndpoints,
    validEndpointSet,
    endpointsConfig,
    assistantListMap,
    includeAssistants,
    interfaceConfig.presets,
    interfaceConfig.modelSelect,
  ]);

  const isLoading =
    isLoadingPresets ||
    isLoadingModels ||
    isLoadingStartup ||
    isLoadingEndpoints ||
    (agentQueryEnabled && isLoadingAgents);

  return {
    options,
    presets,
    isLoading,
    modelSpecs,
    agentsList,
    modelsConfig,
    endpointsConfig,
    assistantListMap,
  };
}

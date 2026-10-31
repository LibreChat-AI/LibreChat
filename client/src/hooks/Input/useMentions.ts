import { useMemo } from 'react';
import {
  Permissions,
  alternateName,
  PermissionBits,
  EModelEndpoint,
  PermissionTypes,
  isAgentsEndpoint,
  getConfigDefaults,
  isAssistantsEndpoint,
  resolveModelSpecEndpoint,
} from 'librechat-data-provider';
import type { TAssistantsMap, TEndpointsConfig } from 'librechat-data-provider';
import type { MentionOption } from '~/common';
import {
  useModelCatalog,
  useGetPresetsQuery,
  useGetEndpointsQuery,
  useListAgentsQuery,
  useGetStartupConfig,
} from '~/data-provider';
import useAssistantListMap from '~/hooks/Assistants/useAssistantListMap';
import { useCatalogReady } from '~/hooks/useCatalogWarmup';
import { mapEndpoints, getPresetTitle } from '~/utils';
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
      containerClassName: 'avatar-stroke overflow-hidden rounded-full',
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
  const agentsReady = useCatalogReady('agents');
  const hasAgentAccess = useHasAccess({
    permissionType: PermissionTypes.AGENTS,
    permission: Permissions.USE,
  });

  const { data: presets, isLoading: isLoadingPresets } = useGetPresetsQuery();
  const { data: modelsConfig, isLoading: isLoadingModels } = useModelCatalog();
  const { data: startupConfig, isLoading: isLoadingStartup } = useGetStartupConfig();
  const { data: endpointsConfig, isLoading: isLoadingEndpoints } = useGetEndpointsQuery();
  const { data: endpoints = [] } = useGetEndpointsQuery({
    select: mapEndpoints,
  });
  const listMap = useAssistantListMap(
    (res) => res.data.map(({ id, name, description }) => ({ id, name, description })),
    { enabled: includeAssistants },
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
  const agentsQuery = useListAgentsQuery(
    { requiredPermission: PermissionBits.VIEW },
    {
      enabled: agentQueryEnabled && agentsReady,
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
            containerClassName: 'avatar-stroke overflow-hidden rounded-full',
            endpointsConfig: endpointsConfig,
            context: 'menu-item',
            size: 20,
          }),
        }));
      },
    },
  );
  const agentsList = agentsQuery.data ?? null;
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

  const modelSpecs = useMemo(() => startupConfig?.modelSpecs?.list ?? [], [startupConfig]);

  const options: MentionOption[] = useMemo(() => {
    const modelOptions = validEndpoints.flatMap((endpoint) => {
      if (isAssistantsEndpoint(endpoint) || isAgentsEndpoint(endpoint)) {
        return [];
      }

      if (interfaceConfig.modelSelect !== true) {
        return [];
      }

      const models = (modelsConfig?.[endpoint] ?? []).map((model) => ({
        value: endpoint,
        label: model,
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
          containerClassName: 'avatar-stroke overflow-hidden rounded-full',
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
    options.length === 0 &&
    (isLoadingPresets ||
      isLoadingModels ||
      isLoadingStartup ||
      isLoadingEndpoints ||
      (agentQueryEnabled && agentsQuery.isLoading));

  return {
    options,
    presets,
    isLoading,
    modelSpecs,
    agentsList,
    agentsQuery,
    modelsConfig,
    endpointsConfig,
    assistantListMap,
  };
}

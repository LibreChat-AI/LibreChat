import React from 'react';
import { Bot } from 'lucide-react';
import { isAgentsEndpoint, isAssistantsEndpoint } from 'librechat-data-provider';
import type {
  TModelSpec,
  TAgentsMap,
  TAssistantsMap,
  TEndpointsConfig,
} from 'librechat-data-provider';
import type { useLocalize } from '~/hooks';
import SpecIcon from '~/components/Chat/Menus/Endpoints/components/SpecIcon';
import { Endpoint, SelectedValues } from '~/common';
import { getModelLabel, getSpecAgentAvatarURL } from '~/utils';

type NamedEndpoint = Pick<Endpoint, 'value' | 'agentNames' | 'assistantNames' | 'modelLabels'>;

/**
 * The name to show for a model, or `undefined` when it has none and should
 * render its own id — so each caller keeps its own fallback.
 *
 * Agents and assistants carry names from their records. Every other endpoint may
 * declare `modelLabels`, a display-only map from model id to label; the id stays
 * what is selected, stored and sent upstream.
 */
export function getModelName(
  endpoint: NamedEndpoint | null,
  modelId: string | null,
): string | undefined {
  if (!endpoint || !modelId) {
    return undefined;
  }

  let names = endpoint.modelLabels;
  if (isAgentsEndpoint(endpoint.value)) {
    names = endpoint.agentNames;
  } else if (isAssistantsEndpoint(endpoint.value)) {
    names = endpoint.assistantNames;
  }

  return getModelLabel(names, modelId);
}

/**
 * The strings a model can be found by. A declared label is additive — labelling
 * a model never makes its id unsearchable — while an agent or assistant name
 * replaces the id on screen and so is searched in its place.
 */
export function modelSearchNames(endpoint: NamedEndpoint, modelId: string): string[] {
  const label = getModelLabel(endpoint.modelLabels, modelId);
  return label ? [label, modelId] : [getModelName(endpoint, modelId) ?? modelId];
}

export function filterItems<
  T extends {
    label: string;
    name?: string;
    value?: string;
    hasModels?: boolean;
    models?: Array<{ name: string; isGlobal?: boolean }>;
    modelLabels?: Record<string, string>;
    searchAliases?: string[];
    showMarketplace?: boolean;
  },
>(
  items: T[],
  searchValue: string,
  agentsMap: TAgentsMap | undefined,
  assistantsMap: TAssistantsMap | undefined,
  localize?: ReturnType<typeof useLocalize>,
): T[] | null {
  const searchTermLower = searchValue.trim().toLowerCase();
  if (!searchTermLower) {
    return null;
  }

  return items.filter((item) => {
    if (!shouldRenderEndpointOption(item)) {
      return false;
    }

    const itemMatches =
      item.label.toLowerCase().includes(searchTermLower) ||
      (item.name && item.name.toLowerCase().includes(searchTermLower)) ||
      (item.value && item.value.toLowerCase().includes(searchTermLower)) ||
      item.searchAliases?.some((alias) => alias.toLowerCase().includes(searchTermLower)) ||
      (item.showMarketplace === true &&
        localize != null &&
        [localize('com_agents_marketplace'), localize('com_ui_marketplace')].some((label) =>
          label.toLowerCase().includes(searchTermLower),
        ));

    if (itemMatches) {
      return true;
    }

    if (item.models && item.models.length > 0) {
      return item.models.some((modelId) => {
        if (modelId.name.toLowerCase().includes(searchTermLower)) {
          return true;
        }

        /* A declared label is additive — the id above stays searchable. */
        const label = getModelLabel(item.modelLabels, modelId.name);
        if (label?.toLowerCase().includes(searchTermLower)) {
          return true;
        }

        if (isAgentsEndpoint(item.value) && agentsMap && modelId.name in agentsMap) {
          const agentName = agentsMap[modelId.name]?.name;
          return typeof agentName === 'string' && agentName.toLowerCase().includes(searchTermLower);
        }

        if (isAssistantsEndpoint(item.value) && assistantsMap) {
          const endpoint = item.value ?? '';
          const assistant = assistantsMap[endpoint][modelId.name];
          if (assistant && typeof assistant.name === 'string') {
            return assistant.name.toLowerCase().includes(searchTermLower);
          }
          return false;
        }

        return false;
      });
    }

    return false;
  });
}

export function shouldRenderEndpointOption(endpoint: {
  value?: string;
  hasModels?: boolean;
}): boolean {
  return !isAgentsEndpoint(endpoint.value) || endpoint.hasModels === true;
}

export function filterModels(
  endpoint: Endpoint,
  models: string[],
  searchValue: string,
  agentsMap: TAgentsMap | undefined,
  assistantsMap: TAssistantsMap | undefined,
): string[] {
  const searchTermLower = searchValue.trim().toLowerCase();
  if (!searchTermLower) {
    return models;
  }

  return models.filter((modelId) => {
    /* A declared label is additive — the id below stays searchable. */
    const label = getModelLabel(endpoint.modelLabels, modelId);
    if (label?.toLowerCase().includes(searchTermLower)) {
      return true;
    }

    let modelName = modelId;

    if (isAgentsEndpoint(endpoint.value) && agentsMap && agentsMap[modelId]) {
      modelName = agentsMap[modelId]?.name || modelId;
    } else if (
      isAssistantsEndpoint(endpoint.value) &&
      assistantsMap &&
      assistantsMap[endpoint.value]
    ) {
      const assistant = assistantsMap[endpoint.value][modelId];
      modelName =
        typeof assistant.name === 'string' && assistant.name ? (assistant.name as string) : modelId;
    }

    return modelName.toLowerCase().includes(searchTermLower);
  });
}

export function getSelectedIcon({
  mappedEndpoints,
  selectedValues,
  modelSpecs,
  endpointsConfig,
  agentsMap,
}: {
  mappedEndpoints: Endpoint[];
  selectedValues: SelectedValues;
  modelSpecs: TModelSpec[];
  endpointsConfig: TEndpointsConfig;
  agentsMap?: TAgentsMap;
}): React.ReactNode | null {
  const { endpoint, model, modelSpec } = selectedValues;

  if (modelSpec) {
    const spec = modelSpecs.find((s) => s.name === modelSpec);
    if (!spec) {
      return null;
    }
    const { showIconInHeader = true } = spec;
    if (!showIconInHeader) {
      return null;
    }
    return React.createElement(SpecIcon, {
      currentSpec: spec,
      endpointsConfig,
      agentAvatarURL: getSpecAgentAvatarURL(spec, agentsMap),
    });
  }

  if (endpoint && model) {
    const selectedEndpoint = mappedEndpoints.find((e) => e.value === endpoint);
    if (!selectedEndpoint) {
      return null;
    }

    if (selectedEndpoint.modelIcons?.[model]) {
      const iconUrl = selectedEndpoint.modelIcons[model];
      return React.createElement(
        'div',
        { className: 'h-5 w-5 overflow-hidden rounded-full' },
        React.createElement('img', {
          src: iconUrl,
          alt: model,
          className: 'h-full w-full object-cover',
        }),
      );
    }

    return (
      selectedEndpoint.icon ||
      React.createElement(Bot, {
        size: 20,
        className: 'icon-md shrink-0 text-text-primary',
      })
    );
  }

  if (endpoint) {
    const selectedEndpoint = mappedEndpoints.find((e) => e.value === endpoint);
    return selectedEndpoint?.icon || null;
  }

  return null;
}

export const getDisplayValue = ({
  localize,
  mappedEndpoints,
  selectedValues,
  modelSpecs,
  agentsMap,
}: {
  localize: ReturnType<typeof useLocalize>;
  selectedValues: SelectedValues;
  mappedEndpoints: Endpoint[];
  modelSpecs: TModelSpec[];
  agentsMap?: TAgentsMap;
}) => {
  if (selectedValues.modelSpec) {
    const spec = modelSpecs.find((s) => s.name === selectedValues.modelSpec);
    return spec?.label || spec?.name || localize('com_ui_select_model');
  }

  if (selectedValues.model && selectedValues.endpoint) {
    const endpoint = mappedEndpoints.find((e) => e.value === selectedValues.endpoint);
    if (!endpoint) {
      return localize('com_ui_select_model');
    }

    const name = getModelName(endpoint, selectedValues.model);
    if (name != null) {
      return name;
    }

    if (isAgentsEndpoint(endpoint.value) && agentsMap) {
      return agentsMap[selectedValues.model]?.name || selectedValues.model;
    }

    return selectedValues.model;
  }

  if (selectedValues.endpoint) {
    const endpoint = mappedEndpoints.find((e) => e.value === selectedValues.endpoint);
    return endpoint?.label || localize('com_ui_select_model');
  }

  return localize('com_ui_select_model');
};

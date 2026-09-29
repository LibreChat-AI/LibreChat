import React, { Fragment, useCallback, useMemo } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { VisuallyHidden } from '@ariakit/react';
import { isAgentsEndpoint, isAssistantsEndpoint } from 'librechat-data-provider';
import type { TModelSpec } from 'librechat-data-provider';
import type { Endpoint, LocalizeFunction } from '~/common';
import { EndpointModelItem, VIRTUALIZE_THRESHOLD } from './EndpointModelItem';
import MarketplaceItem, { marketplaceSearchMatches } from './Marketplace';
import { useModelSelectorContext } from '../ModelSelectorContext';
import { CustomMenuItem as MenuItem } from '../CustomMenu';
import VirtualizedModelList from './VirtualizedModelList';
import { shouldRenderEndpointOption } from '../utils';
import { cn, getSpecAgentAvatarURL } from '~/utils';
import SpecDescription from './SpecDescription';
import { useFavorites } from '~/hooks';
import SpecIcon from './SpecIcon';

type SearchModel = { name: string; isGlobal?: boolean };

type SearchResult =
  | { kind: 'spec'; spec: TModelSpec }
  | {
      kind: 'models';
      endpoint: Endpoint;
      filteredModels: SearchModel[];
      showMarketplace: boolean;
    }
  | { kind: 'endpoint'; endpoint: Endpoint };

/**
 * Resolves the same selectable search entries that are rendered below and
 * counts only options, not endpoint headings. Keeping this as one pass makes
 * the ARIA offset and set size cover every option in the shared listbox.
 */
function prepareSearchResults(
  results: (TModelSpec | Endpoint)[],
  localize: LocalizeFunction,
  searchValue: string,
): SearchResult[] {
  const lowerQuery = searchValue.toLowerCase();

  return results.flatMap<SearchResult>((item): SearchResult[] => {
    if ('name' in item && 'label' in item) {
      return [{ kind: 'spec', spec: item as TModelSpec }];
    }

    const endpoint = item as Endpoint;
    if (!shouldRenderEndpointOption(endpoint)) {
      return [];
    }

    if (!endpoint.hasModels) {
      return [{ kind: 'endpoint', endpoint }];
    }

    const endpointMatches = endpoint.label.toLowerCase().includes(lowerQuery);
    const showMarketplace =
      endpoint.showMarketplace === true &&
      (endpointMatches || marketplaceSearchMatches(searchValue, localize));
    const models = endpoint.models ?? [];
    const filteredModels = endpointMatches
      ? models
      : models.filter((model) => {
          let modelName = model.name;
          if (
            isAgentsEndpoint(endpoint.value) &&
            endpoint.agentNames &&
            endpoint.agentNames[model.name]
          ) {
            modelName = endpoint.agentNames[model.name];
          } else if (
            isAssistantsEndpoint(endpoint.value) &&
            endpoint.assistantNames &&
            endpoint.assistantNames[model.name]
          ) {
            modelName = endpoint.assistantNames[model.name];
          }
          return modelName.toLowerCase().includes(lowerQuery);
        });

    if (!filteredModels.length && !showMarketplace) {
      return [];
    }

    return [{ kind: 'models', endpoint, filteredModels, showMarketplace }];
  });
}

function searchResultOptionCount(result: SearchResult): number {
  if (result.kind === 'spec' || result.kind === 'endpoint') {
    return 1;
  }
  return result.filteredModels.length + (result.showMarketplace ? 1 : 0);
}

/**
 * Renders search matches with the same row component as the endpoint list. The
 * virtualized branch only changes how many rows are mounted, not the row
 * affordances or selection/favorite behavior.
 */
function SearchModelRows({
  endpoint,
  filteredModels,
  precedingOptionCount,
  listboxSetSize,
  searchValue,
}: {
  endpoint: Endpoint;
  filteredModels: SearchModel[];
  precedingOptionCount: number;
  listboxSetSize: number;
  searchValue: string;
}) {
  const { isFavoriteModel, toggleFavoriteModel, isFavoriteAgent, toggleFavoriteAgent } =
    useFavorites();
  const isAgent = isAgentsEndpoint(endpoint.value);

  const isFavorite = useCallback(
    (modelId: string) =>
      isAgent ? isFavoriteAgent(modelId) : isFavoriteModel(modelId, endpoint.value),
    [isAgent, isFavoriteAgent, isFavoriteModel, endpoint.value],
  );
  const onToggleFavorite = useCallback(
    (modelId: string) => {
      if (isAgent) {
        toggleFavoriteAgent(modelId);
      } else {
        toggleFavoriteModel({ model: modelId, endpoint: endpoint.value });
      }
    },
    [isAgent, toggleFavoriteAgent, toggleFavoriteModel, endpoint.value],
  );

  const modelIds = useMemo(() => filteredModels.map((model) => model.name), [filteredModels]);
  const globalByName = useMemo(
    () => new Map(filteredModels.map((model) => [model.name, model.isGlobal ?? false])),
    [filteredModels],
  );

  if (filteredModels.length > VIRTUALIZE_THRESHOLD) {
    return (
      <VirtualizedModelList
        key={searchValue}
        endpoint={endpoint}
        modelIds={modelIds}
        globalByName={globalByName}
        isFavorite={isFavorite}
        onToggleFavorite={onToggleFavorite}
        precedingOptionCount={precedingOptionCount}
        listboxSetSize={listboxSetSize}
      />
    );
  }

  return modelIds.map((modelId, index) => (
    <EndpointModelItem
      key={`${endpoint.value}-${modelId}-search`}
      modelId={modelId}
      endpoint={endpoint}
      isGlobal={globalByName.get(modelId) ?? false}
      isFavorite={isFavorite(modelId)}
      onToggleFavorite={onToggleFavorite}
      posInSet={precedingOptionCount + index + 1}
      setSize={listboxSetSize}
    />
  ));
}

interface SearchResultsProps {
  results: (TModelSpec | Endpoint)[] | null;
  localize: LocalizeFunction;
  searchValue: string;
}

export function SearchResults({ results, localize, searchValue }: SearchResultsProps) {
  const { selectedValues, handleSelectSpec, handleSelectEndpoint, endpointsConfig, agentsMap } =
    useModelSelectorContext();
  const { modelSpec: selectedSpec, endpoint: selectedEndpoint } = selectedValues;
  const preparedResults = useMemo(
    () => (results ? prepareSearchResults(results, localize, searchValue) : []),
    [results, localize, searchValue],
  );
  const listboxSetSize = preparedResults.reduce(
    (total, result) => total + searchResultOptionCount(result),
    0,
  );

  if (!results) {
    return null;
  }
  if (!results.length) {
    return (
      <>
        <div role="alert" aria-live="polite" className="sr-only">
          {localize('com_files_no_results')}
        </div>
        <div className="cursor-default p-2 sm:py-1 sm:text-sm">
          {localize('com_files_no_results')}
        </div>
      </>
    );
  }

  let precedingOptionCount = 0;

  return (
    <>
      <div role="alert" aria-live="polite" className="sr-only">
        {results.length === 1
          ? localize('com_files_result_found', { count: results.length })
          : localize('com_files_results_found', { count: results.length })}
      </div>
      {preparedResults.map((result) => {
        const resultOffset = precedingOptionCount;
        const resultOptionCount = searchResultOptionCount(result);
        precedingOptionCount += resultOptionCount;

        if (result.kind === 'spec') {
          const { spec } = result;
          return (
            <MenuItem
              key={spec.name}
              onClick={() => handleSelectSpec(spec)}
              aria-selected={selectedSpec === spec.name || undefined}
              aria-posinset={resultOffset + 1}
              aria-setsize={listboxSetSize}
              className={cn(
                'flex w-full cursor-pointer justify-between rounded-lg px-2 text-sm',
                spec.description ? 'items-start' : 'items-center',
              )}
            >
              <div
                className={cn(
                  'flex w-full min-w-0 gap-2 px-1 py-1',
                  spec.description ? 'items-start' : 'items-center',
                )}
              >
                {(spec.showIconInMenu ?? true) && (
                  <div className="flex-shrink-0">
                    <SpecIcon
                      currentSpec={spec}
                      endpointsConfig={endpointsConfig}
                      agentAvatarURL={getSpecAgentAvatarURL(spec, agentsMap)}
                    />
                  </div>
                )}
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="truncate text-left">{spec.label}</span>
                  <SpecDescription description={spec.description} />
                </div>
              </div>
              {selectedSpec === spec.name && (
                <>
                  <CheckCircle2
                    className={cn(
                      'size-4 shrink-0 text-text-primary',
                      spec.description ? 'mt-1' : '',
                    )}
                    aria-hidden="true"
                  />
                  <VisuallyHidden>{localize('com_a11y_selected')}</VisuallyHidden>
                </>
              )}
            </MenuItem>
          );
        }

        if (result.kind === 'models') {
          const { endpoint, filteredModels, showMarketplace } = result;
          return (
            <Fragment key={`endpoint-${endpoint.value}-search`}>
              <div className="flex items-center gap-2 px-3 py-1 text-sm font-medium">
                {endpoint.icon && (
                  <div className="flex items-center justify-center overflow-hidden rounded-full p-1">
                    {endpoint.icon}
                  </div>
                )}
                {endpoint.label}
              </div>
              {showMarketplace && (
                <MarketplaceItem
                  className="px-3 py-2 pl-6"
                  label={localize('com_agents_marketplace')}
                  posInSet={resultOffset + 1}
                  setSize={listboxSetSize}
                />
              )}
              <SearchModelRows
                endpoint={endpoint}
                filteredModels={filteredModels}
                precedingOptionCount={resultOffset + (showMarketplace ? 1 : 0)}
                listboxSetSize={listboxSetSize}
                searchValue={searchValue}
              />
            </Fragment>
          );
        }

        const { endpoint } = result;
        const isEndpointSelected = !selectedSpec && selectedEndpoint === endpoint.value;
        return (
          <MenuItem
            key={`endpoint-${endpoint.value}-search-item`}
            onClick={() => handleSelectEndpoint(endpoint)}
            aria-selected={isEndpointSelected || undefined}
            aria-posinset={resultOffset + 1}
            aria-setsize={listboxSetSize}
            className="flex w-full cursor-pointer items-center justify-between rounded-xl px-3 py-2 text-sm"
          >
            <div className="flex items-center gap-2">
              {endpoint.icon && (
                <div
                  className="flex items-center justify-center overflow-hidden rounded-full border border-border-light p-1"
                  style={{ borderRadius: '50%' }}
                >
                  {endpoint.icon}
                </div>
              )}
              <span>{endpoint.label}</span>
            </div>
            {isEndpointSelected && (
              <>
                <CheckCircle2 className="size-4 shrink-0 text-text-primary" aria-hidden="true" />
                <VisuallyHidden>{localize('com_a11y_selected')}</VisuallyHidden>
              </>
            )}
          </MenuItem>
        );
      })}
    </>
  );
}

export function renderSearchResults(
  results: (TModelSpec | Endpoint)[] | null,
  localize: LocalizeFunction,
  searchValue: string,
) {
  return (
    <SearchResults
      key={`search-results-${searchValue}`}
      results={results}
      localize={localize}
      searchValue={searchValue}
    />
  );
}

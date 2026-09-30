import { useCallback, useMemo } from 'react';
import { VisuallyHidden } from '@ariakit/react';
import { Spinner, TooltipAnchor } from '@librechat/client';
import { CheckCircle2, MousePointerClick, SettingsIcon } from 'lucide-react';
import { EModelEndpoint, isAgentsEndpoint, isAssistantsEndpoint } from 'librechat-data-provider';
import type { TModelSpec } from 'librechat-data-provider';
import type { Endpoint } from '~/common';
import { CustomMenu as Menu, CustomMenuItem as MenuItem, CustomMenuSeparator } from '../CustomMenu';
import { renderEndpointModels, VIRTUALIZE_THRESHOLD } from './EndpointModelItem';
import MarketplaceItem, { marketplaceSearchMatches } from './Marketplace';
import { filterModels, shouldRenderEndpointOption } from '../utils';
import { useModelSelectorContext } from '../ModelSelectorContext';
import VirtualizedModelList from './VirtualizedModelList';
import { useFavorites, useLocalize } from '~/hooks';
import { ModelSpecItem } from './ModelSpecItem';
import { cn } from '~/utils';

interface EndpointItemProps {
  endpoint: Endpoint;
  endpointIndex: number;
}

const SettingsButton = ({
  endpoint,
  className,
  handleOpenKeyDialog,
}: {
  endpoint: Endpoint;
  className?: string;
  handleOpenKeyDialog: (endpoint: EModelEndpoint, e: React.MouseEvent) => void;
}) => {
  const localize = useLocalize();
  const text = localize('com_endpoint_config_key');

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!endpoint.value) {
      return;
    }
    e.stopPropagation();
    handleOpenKeyDialog(endpoint.value as EModelEndpoint, e);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      if (endpoint.value) {
        handleOpenKeyDialog(endpoint.value as EModelEndpoint, e as unknown as React.MouseEvent);
      }
    }
  };

  return (
    <button
      type="button"
      id={`endpoint-${endpoint.value}-settings`}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        'group/button flex items-center gap-1.5 rounded-md px-1.5',
        'text-text-secondary transition-colors duration-150',
        'hover:bg-surface-tertiary hover:text-text-primary',
        'focus-visible:bg-surface-tertiary focus-visible:text-text-primary',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-primary focus-visible:ring-offset-1',
        className,
      )}
      aria-label={`${text} ${endpoint.label}`}
    >
      <SettingsIcon className="size-4 shrink-0" aria-hidden="true" />
      <span
        aria-hidden="true"
        className={cn(
          'grid overflow-hidden transition-[grid-template-columns,opacity] duration-150 ease-out',
          'grid-cols-[0fr] opacity-0',
          'group-hover/button:grid-cols-[1fr] group-hover/button:opacity-100',
          'group-focus-visible/button:grid-cols-[1fr] group-focus-visible/button:opacity-100',
        )}
      >
        <span className="min-w-0 truncate pr-0.5">{text}</span>
      </span>
    </button>
  );
};

/**
 * Lazily-rendered content for an endpoint submenu. By extracting this into a
 * separate component, the expensive model-list rendering (and per-item hooks
 * such as MutationObservers in EndpointModelItem) only runs when the submenu
 * is actually mounted — which Ariakit defers via `unmountOnHide`.
 */
export function EndpointMenuContent({
  endpoint,
  endpointIndex,
}: {
  endpoint: Endpoint;
  endpointIndex: number;
}) {
  const localize = useLocalize();
  const { agentsMap, assistantsMap, modelSpecs, selectedValues, endpointSearchValues } =
    useModelSelectorContext();
  const { modelSpec: selectedSpec } = selectedValues;
  const searchValue = endpointSearchValues[endpoint.value] || '';

  const endpointSpecs = useMemo(() => {
    if (!modelSpecs || !modelSpecs.length) {
      return [];
    }
    return modelSpecs.filter((spec: TModelSpec) => spec.group === endpoint.value);
  }, [modelSpecs, endpoint.value]);

  if (isAssistantsEndpoint(endpoint.value) && endpoint.models === undefined) {
    return (
      <div
        className="flex items-center justify-center p-2"
        role="status"
        aria-label={localize('com_ui_loading')}
      >
        <Spinner aria-hidden="true" />
      </div>
    );
  }

  const filteredModels = searchValue
    ? filterModels(
        endpoint,
        (endpoint.models || []).map((model) => model.name),
        searchValue,
        agentsMap,
        assistantsMap,
      )
    : null;
  const renderedModels = filteredModels ?? endpoint.models?.map((model) => model.name) ?? [];
  const showMarketplace =
    endpoint.showMarketplace === true && marketplaceSearchMatches(searchValue, localize);
  const hasSelectableRows = endpointSpecs.length > 0 || renderedModels.length > 0;

  /**
   * Once the model list is windowed, the DOM no longer holds every option, so a screen
   * reader would infer position and total from the mounted slice alone. Declare them
   * explicitly across the whole listbox — mixing declared and inferred values within one
   * set is worse than either — and leave them off entirely when nothing is virtualized.
   */
  const precedingOptionCount = (showMarketplace ? 1 : 0) + endpointSpecs.length;
  const isVirtualized = renderedModels.length > VIRTUALIZE_THRESHOLD;
  const listboxSetSize = isVirtualized ? precedingOptionCount + renderedModels.length : undefined;

  return (
    <>
      {showMarketplace && (
        <MarketplaceItem
          label={localize('com_agents_marketplace')}
          posInSet={isVirtualized ? 1 : undefined}
          setSize={listboxSetSize}
        />
      )}
      {showMarketplace && hasSelectableRows && <CustomMenuSeparator />}
      {endpointSpecs.map((spec: TModelSpec, specIndex: number) => (
        <ModelSpecItem
          key={spec.name}
          spec={spec}
          isSelected={selectedSpec === spec.name}
          posInSet={isVirtualized ? (showMarketplace ? 1 : 0) + specIndex + 1 : undefined}
          setSize={listboxSetSize}
        />
      ))}
      <EndpointModels
        endpoint={endpoint}
        renderedModels={renderedModels}
        endpointIndex={endpointIndex}
        searchValue={searchValue}
        precedingOptionCount={precedingOptionCount}
      />
    </>
  );
}

/**
 * Owns the model rows for one endpoint. `useFavorites` is called once here rather
 * than inside each row: it opens a jotai subscription, a React Query subscription
 * and a mutation per call site, which at agent-list scale was thousands of live
 * subscriptions for one dropdown.
 */
function EndpointModels({
  endpoint,
  renderedModels,
  endpointIndex,
  searchValue,
  precedingOptionCount,
}: {
  endpoint: Endpoint;
  renderedModels: string[];
  endpointIndex: number;
  searchValue: string;
  precedingOptionCount: number;
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

  const models = useMemo(() => endpoint.models ?? [], [endpoint.models]);
  const globalByName = useMemo(
    () => new Map(models.map((model) => [model.name, model.isGlobal ?? false])),
    [models],
  );

  if (!renderedModels.length) {
    return null;
  }

  if (renderedModels.length > VIRTUALIZE_THRESHOLD) {
    return (
      /**
       * Keyed on the filter so a new result set starts at the top. `Grid` keeps its
       * scroll offset across prop changes and, when the row count shrinks, clamps it to
       * `totalRowsHeight - height` — the END of the shorter list. Without this a user who
       * scrolled deep and then searched would land on the tail matches, with only those
       * rows mounted and therefore reachable by keyboard.
       */
      <VirtualizedModelList
        key={searchValue}
        endpoint={endpoint}
        modelIds={renderedModels}
        globalByName={globalByName}
        isFavorite={isFavorite}
        onToggleFavorite={onToggleFavorite}
        endpointIndex={endpointIndex}
        precedingOptionCount={precedingOptionCount}
      />
    );
  }

  return renderEndpointModels(endpoint, models, renderedModels, endpointIndex, {
    isFavorite,
    onToggleFavorite,
  });
}

export function EndpointItem({ endpoint, endpointIndex }: EndpointItemProps) {
  const localize = useLocalize();
  const {
    selectedValues,
    handleOpenKeyDialog,
    handleSelectEndpoint,
    endpointSearchValues,
    setEndpointSearchValue,
    endpointRequiresUserKey,
  } = useModelSelectorContext();
  const { endpoint: selectedEndpoint, modelSpec: selectedSpec } = selectedValues;

  const searchValue = endpointSearchValues[endpoint.value] || '';
  const isUserProvided = useMemo(
    () => endpointRequiresUserKey(endpoint.value),
    [endpointRequiresUserKey, endpoint.value],
  );

  const isAssistantsNotLoaded =
    isAssistantsEndpoint(endpoint.value) && endpoint.models === undefined;

  const renderIconLabel = () => (
    <div className="flex min-w-0 items-center gap-2">
      {endpoint.icon && (
        <div className="flex shrink-0 items-center justify-center" aria-hidden="true">
          {endpoint.icon}
        </div>
      )}
      <span className="truncate text-left">{endpoint.label}</span>
    </div>
  );

  const isEndpointSelected = !selectedSpec && selectedEndpoint === endpoint.value;

  if (!shouldRenderEndpointOption(endpoint)) {
    return null;
  }

  if (endpoint.hasModels) {
    const placeholder =
      isAgentsEndpoint(endpoint.value) || isAssistantsEndpoint(endpoint.value)
        ? localize('com_endpoint_search_var', { 0: endpoint.label })
        : localize('com_endpoint_search_endpoint_models', { 0: endpoint.label });
    return (
      <Menu
        id={`endpoint-${endpoint.value}-menu`}
        key={`endpoint-${endpoint.value}-item`}
        searchValue={searchValue}
        onSearch={(value) => setEndpointSearchValue(endpoint.value, value)}
        combobox={<input placeholder=" " />}
        comboboxLabel={placeholder}
        onClick={() => handleSelectEndpoint(endpoint)}
        label={
          <div className="group flex w-full min-w-0 items-center justify-between gap-1.5 py-1 text-sm">
            {renderIconLabel()}
            <div className="flex shrink-0 items-center gap-1">
              {isUserProvided && (
                <SettingsButton endpoint={endpoint} handleOpenKeyDialog={handleOpenKeyDialog} />
              )}
              {isEndpointSelected && (
                <>
                  <CheckCircle2 className="size-4 shrink-0 text-text-primary" aria-hidden="true" />
                  <VisuallyHidden>{localize('com_a11y_selected')}</VisuallyHidden>
                </>
              )}
            </div>
          </div>
        }
      >
        <EndpointMenuContent endpoint={endpoint} endpointIndex={endpointIndex} />
      </Menu>
    );
  } else {
    return (
      <MenuItem
        id={`endpoint-${endpoint.value}-menu`}
        key={`endpoint-${endpoint.value}-item`}
        onClick={() => handleSelectEndpoint(endpoint)}
        aria-selected={isEndpointSelected || undefined}
        className="group flex w-full cursor-pointer items-center justify-between gap-1.5 py-2 text-sm"
      >
        {renderIconLabel()}
        <div className="flex shrink-0 items-center gap-2">
          {endpointRequiresUserKey(endpoint.value) && (
            <SettingsButton endpoint={endpoint} handleOpenKeyDialog={handleOpenKeyDialog} />
          )}
          {isAssistantsNotLoaded && (
            <TooltipAnchor
              description={localize('com_ui_click_to_view_var', { 0: endpoint.label })}
              side="top"
              render={
                <span className="flex items-center">
                  <MousePointerClick className="size-4 text-text-secondary" aria-hidden="true" />
                </span>
              }
            />
          )}
          {isEndpointSelected && !isAssistantsNotLoaded && (
            <>
              <CheckCircle2 className="size-4 shrink-0 text-text-primary" aria-hidden="true" />
              <VisuallyHidden>{localize('com_a11y_selected')}</VisuallyHidden>
            </>
          )}
        </div>
      </MenuItem>
    );
  }
}

export function renderEndpoints(mappedEndpoints: Endpoint[]) {
  return mappedEndpoints.map((endpoint, index) => (
    <EndpointItem
      endpoint={endpoint}
      endpointIndex={index}
      key={`endpoint-${endpoint.value}-${index}`}
    />
  ));
}

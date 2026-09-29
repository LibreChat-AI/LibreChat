import React from 'react';
import { Pin, PinOff } from 'lucide';
import { MorphIcon } from '@librechat/client';
import { VisuallyHidden } from '@ariakit/react';
import { CheckCircle2, EarthIcon } from 'lucide-react';
import { isAgentsEndpoint, isAssistantsEndpoint } from 'librechat-data-provider';
import type { Endpoint } from '~/common';
import { useModelSelectorContext } from '../ModelSelectorContext';
import { CustomMenuItem as MenuItem } from '../CustomMenu';
import useActiveItem from '../useActiveItem';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface EndpointModelItemProps {
  modelId: string | null;
  endpoint: Endpoint;
  /** Resolved by the parent from the same array it maps, so the row does not rescan it. */
  isGlobal?: boolean;
  isFavorite: boolean;
  onToggleFavorite: (modelId: string) => void;
  /**
   * Only set when the list is virtualized. The mounted rows are then a small window over
   * a much larger set, so the position a screen reader would infer from the DOM is wrong;
   * these carry the real position and total. Left undefined otherwise, where the DOM holds
   * every option and the implicit values are already correct.
   */
  posInSet?: number;
  setSize?: number;
}

function EndpointModelItemComponent({
  modelId,
  endpoint,
  isGlobal = false,
  isFavorite,
  onToggleFavorite,
  posInSet,
  setSize,
}: EndpointModelItemProps) {
  const localize = useLocalize();
  const { handleSelectModel, selectedValues } = useModelSelectorContext();
  const {
    endpoint: selectedEndpoint,
    model: selectedModel,
    modelSpec: selectedSpec,
  } = selectedValues;
  const isSelected =
    !selectedSpec && selectedEndpoint === endpoint.value && selectedModel === modelId;

  const { ref: itemRef, isActive } = useActiveItem<HTMLDivElement>();

  let modelName = modelId;
  const avatarUrl = endpoint?.modelIcons?.[modelId ?? ''] || null;

  // Use custom names if available
  if (endpoint && modelId && isAgentsEndpoint(endpoint.value) && endpoint.agentNames?.[modelId]) {
    modelName = endpoint.agentNames[modelId];
  } else if (
    endpoint &&
    modelId &&
    isAssistantsEndpoint(endpoint.value) &&
    endpoint.assistantNames?.[modelId]
  ) {
    modelName = endpoint.assistantNames[modelId];
  }

  const handleFavoriteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!modelId) {
      return;
    }
    onToggleFavorite(modelId);
  };

  const renderAvatar = () => {
    const isAgentOrAssistant =
      isAgentsEndpoint(endpoint.value) || isAssistantsEndpoint(endpoint.value);
    const showEndpointIcon = isAgentOrAssistant && endpoint.icon;

    const getContent = () => {
      if (avatarUrl) {
        return <img src={avatarUrl} alt={modelName ?? ''} className="h-full w-full object-cover" />;
      }
      if (showEndpointIcon) {
        return endpoint.icon;
      }
      return null;
    };

    const content = getContent();
    if (!content) {
      return null;
    }

    return (
      <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center overflow-hidden rounded-full">
        {content}
      </div>
    );
  };

  return (
    <MenuItem
      ref={itemRef}
      onClick={() => handleSelectModel(endpoint, modelId ?? '')}
      aria-selected={isSelected || undefined}
      aria-posinset={posInSet}
      aria-setsize={setSize}
      className="group flex w-full cursor-pointer items-center justify-between rounded-lg px-2 text-sm"
    >
      <div className="flex w-full min-w-0 items-center gap-2 px-1 py-1">
        {renderAvatar()}
        <span className="truncate">{modelName}</span>
        {isGlobal && <EarthIcon className="ml-1 size-4 text-surface-submit" />}
      </div>
      <button
        type="button"
        tabIndex={isActive ? 0 : -1}
        onClick={handleFavoriteClick}
        aria-label={isFavorite ? localize('com_ui_unpin') : localize('com_ui_pin')}
        className={cn(
          'rounded-md p-1 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring-primary',
          isFavorite
            ? 'visible'
            : // Visible by default so it's tappable on touch (no hover to
              // reveal it); only hidden-until-hover on hover-capable pointers.
              // A hover-gated child would otherwise make the whole item
              // hover-dependent, so the first tap only reveals it and a second
              // tap is needed to select (the iOS double-tap).
              'group-focus-within:visible group-hover:visible group-data-[active-item]:visible [@media(hover:hover)]:invisible',
        )}
      >
        <MorphIcon icon={isFavorite ? PinOff : Pin} className="h-4 w-4 text-text-secondary" />
      </button>
      {isSelected && (
        <>
          <CheckCircle2 className="size-4 shrink-0 text-text-primary" aria-hidden="true" />
          <VisuallyHidden>{localize('com_a11y_selected')}</VisuallyHidden>
        </>
      )}
    </MenuItem>
  );
}

export const EndpointModelItem = React.memo(EndpointModelItemComponent);

/**
 * Above this many rows the list is windowed. Below it, rendering everything keeps
 * Ariakit's composite registry complete, so arrow-key navigation and typeahead
 * reach every row — which is the behaviour virtualization has to work to preserve.
 */
export const VIRTUALIZE_THRESHOLD = 100;

export function renderEndpointModels(
  endpoint: Endpoint | null,
  models: Array<{ name: string; isGlobal?: boolean }>,
  filteredModels?: string[],
  endpointIndex?: number,
  favorites?: {
    isFavorite: (modelId: string) => boolean;
    onToggleFavorite: (modelId: string) => void;
  },
) {
  if (!endpoint) {
    return null;
  }
  const modelsToRender = filteredModels || models.map((model) => model.name);
  const indexSuffix = endpointIndex != null ? `-${endpointIndex}` : '';
  const isFavorite = favorites?.isFavorite ?? (() => false);
  const onToggleFavorite = favorites?.onToggleFavorite ?? (() => {});

  /** `models` carries `isGlobal`; without this map each row rescanned the whole
   *  array to recover it, which is quadratic in the number of agents. */
  const globalByName = new Map(models.map((model) => [model.name, model.isGlobal ?? false]));

  return modelsToRender.map((modelId, modelIndex) => (
    <EndpointModelItem
      key={`${endpoint.value}${indexSuffix}-${modelId}-${modelIndex}`}
      modelId={modelId}
      endpoint={endpoint}
      isGlobal={globalByName.get(modelId) ?? false}
      isFavorite={isFavorite(modelId)}
      onToggleFavorite={onToggleFavorite}
    />
  ));
}

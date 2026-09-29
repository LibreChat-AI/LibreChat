import React from 'react';
import { Pin, PinOff } from 'lucide';
import { CheckCircle2 } from 'lucide-react';
import { MorphIcon } from '@librechat/client';
import { VisuallyHidden } from '@ariakit/react';
import type { TModelSpec } from 'librechat-data-provider';
import { useFavorites, useLocalize, useIsActiveItem } from '~/hooks';
import { useModelSelectorContext } from '../ModelSelectorContext';
import { CustomMenuItem as MenuItem } from '../CustomMenu';
import { cn, getSpecAgentAvatarURL } from '~/utils';
import SpecDescription from './SpecDescription';
import SpecIcon from './SpecIcon';

interface ModelSpecItemProps {
  spec: TModelSpec;
  isSelected: boolean;
  /** Set when the sibling model list is virtualized; see `VirtualizedModelList`. */
  posInSet?: number;
  setSize?: number;
}

export function ModelSpecItem({ spec, isSelected, posInSet, setSize }: ModelSpecItemProps) {
  const localize = useLocalize();
  const { handleSelectSpec, endpointsConfig, agentsMap } = useModelSelectorContext();
  const { isFavoriteSpec, toggleFavoriteSpec } = useFavorites();
  const { showIconInMenu = true } = spec;
  const agentAvatarURL = getSpecAgentAvatarURL(spec, agentsMap);

  const { ref: itemRef, isActive } = useIsActiveItem<HTMLDivElement>();

  const isFavorite = isFavoriteSpec(spec.name);

  const handleFavoriteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggleFavoriteSpec(spec.name);
  };

  return (
    <MenuItem
      ref={itemRef}
      onClick={() => handleSelectSpec(spec)}
      aria-selected={isSelected || undefined}
      aria-posinset={posInSet}
      aria-setsize={setSize}
      className="group flex w-full cursor-pointer items-center justify-between rounded-lg px-2 text-sm"
    >
      <div
        className={cn(
          'flex w-full min-w-0 gap-2 px-1 py-1',
          spec.description ? 'items-start' : 'items-center',
        )}
      >
        {showIconInMenu && (
          <div className="flex-shrink-0">
            <SpecIcon
              currentSpec={spec}
              endpointsConfig={endpointsConfig}
              agentAvatarURL={agentAvatarURL}
            />
          </div>
        )}
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-left">{spec.label}</span>
          <SpecDescription description={spec.description} />
        </div>
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
          <CheckCircle2
            className="size-4 shrink-0 self-center text-text-primary"
            aria-hidden="true"
          />
          <VisuallyHidden>{localize('com_a11y_selected')}</VisuallyHidden>
        </>
      )}
    </MenuItem>
  );
}

export function renderModelSpecs(specs: TModelSpec[], selectedSpec: string) {
  if (!specs || specs.length === 0) {
    return null;
  }

  return specs.map((spec) => (
    <ModelSpecItem key={spec.name} spec={spec} isSelected={selectedSpec === spec.name} />
  ));
}

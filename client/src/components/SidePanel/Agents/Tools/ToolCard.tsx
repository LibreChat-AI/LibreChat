import { memo, useState } from 'react';
import { VerifiedIcon } from '@librechat/client';
import { Check, Globe, Info, Settings, Star, User } from 'lucide-react';
import type { TranslationKeys } from '~/hooks/useLocalize';
import type { AgentItem, ItemStatus } from './items/types';
import { hasConfigurableSettings } from './items/configurable';
import { useLocalize, useAuthContext } from '~/hooks';
import { getIconForItem } from './items/icons';
import { cn } from '~/utils';

interface ToolCardProps {
  item: AgentItem;
  selected: boolean;
  onToggle: (item: AgentItem) => void;
  onConfigure?: (item: AgentItem) => void;
  isFavorited?: boolean;
  onToggleFavorite?: (item: AgentItem) => void;
  /** A live state, such as an MCP server's connection, shown in place of the
   *  kind label, which is redundant wherever every card shares one kind. */
  status?: ItemStatus;
}

function useDisplayStrings(item: AgentItem): { name: string; description: string } {
  const localize = useLocalize();
  if (item.kind === 'builtin') {
    return {
      name: localize(item.name as TranslationKeys),
      description: item.description ? localize(item.description as TranslationKeys) : '',
    };
  }
  return { name: item.name, description: item.description ?? '' };
}

const KIND_LABEL_KEYS: Record<AgentItem['kind'], TranslationKeys> = {
  builtin: 'com_ui_tools_kind_official',
  tool: 'com_ui_tools_kind_tools',
  skill: 'com_ui_tools_kind_skills',
  mcp: 'com_ui_tools_kind_mcp',
  action: 'com_ui_tools_kind_actions',
};

interface ItemIconProps {
  item: AgentItem;
  size: 'sm' | 'md';
}

function ItemIconView({ item, size }: ItemIconProps) {
  const { Icon, colorClass, iconUrl } = getIconForItem(item);
  const [imgError, setImgError] = useState(false);

  const tileClasses =
    size === 'md' ? 'h-10 w-10 rounded-xl text-base' : 'h-9 w-9 rounded-lg text-sm';
  const iconClasses = size === 'md' ? 'h-[1.125rem] w-[1.125rem]' : 'h-[1.125rem] w-[1.125rem]';

  if (iconUrl && !imgError) {
    return (
      <span
        className={cn(
          'bg-surface-fixed flex shrink-0 items-center justify-center overflow-hidden',
          tileClasses,
        )}
        aria-hidden="true"
      >
        <img
          src={iconUrl}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          onError={() => setImgError(true)}
        />
      </span>
    );
  }

  return (
    <span
      className={cn('flex shrink-0 items-center justify-center', tileClasses, colorClass)}
      aria-hidden="true"
    >
      <Icon className={iconClasses} strokeWidth={1.75} />
    </span>
  );
}

function ToolCardImpl({
  item,
  selected,
  onToggle,
  onConfigure,
  isFavorited = false,
  onToggleFavorite,
  status,
}: ToolCardProps) {
  const localize = useLocalize();
  const { name, description } = useDisplayStrings(item);
  const { user } = useAuthContext();
  const isNative = item.kind === 'builtin';
  const kindLabel = localize(KIND_LABEL_KEYS[item.kind]);
  const canFavorite = onToggleFavorite !== undefined && item.kind !== 'action';
  const canConfigure = hasConfigurableSettings(item) && onConfigure !== undefined;
  const skill = item.kind === 'skill' ? item.skill : undefined;
  const isPublicSkill = skill?.isPublic === true;
  const isSharedSkill = skill != null && skill.author !== user?.id && Boolean(skill.authorName);
  const showInfoOnly =
    item.kind === 'builtin' &&
    item.id === 'web_search' &&
    !canConfigure &&
    onConfigure !== undefined;
  const DetailIcon = canConfigure ? Settings : Info;

  return (
    /* touch:h-36 with touch:pb-9 on the content: where a coarse pointer exists the
     action cluster below is permanent rather than revealed on hover, so the card
     owes it a strip of its own. Without that the last line of a three-line
     description sits under the buttons for as long as the card is on screen. */
    <div
      className={cn(
        'group touch:h-36 relative flex h-32 w-full flex-col overflow-hidden rounded-2xl border',
        selected
          ? 'border-status-success bg-status-success/10 shadow-xs'
          : 'border-border-light hover:border-border-medium hover:bg-surface-tertiary bg-transparent hover:shadow-xs',
      )}
    >
      <button
        type="button"
        onClick={() => onToggle(item)}
        aria-pressed={selected}
        className={cn(
          'touch:pb-9 flex h-full w-full cursor-pointer flex-col gap-2 rounded-2xl p-4 text-left',
          'focus-visible:ring-ring-primary focus:outline-hidden focus-visible:ring-2',
        )}
      >
        <div className="flex w-full items-start gap-3">
          <ItemIconView item={item} size="md" />
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-1.5">
              <p className="text-text-primary flex min-w-0 flex-1 items-center gap-1 text-sm font-semibold">
                <span className="truncate">{name}</span>
                {isNative && (
                  <VerifiedIcon
                    className="text-status-verified size-3.5 shrink-0"
                    aria-label={localize('com_ui_tools_native')}
                  />
                )}
              </p>
              {selected && (
                <span
                  className="bg-status-success-strong text-text-on-status flex size-5 shrink-0 items-center justify-center rounded-full"
                  aria-hidden="true"
                >
                  <Check className="size-3" strokeWidth={3} />
                </span>
              )}
            </div>
            {status != null ? (
              <p className="text-text-secondary flex min-w-0 items-center gap-1.5 text-xs">
                <span
                  aria-hidden="true"
                  className={cn('size-2 shrink-0 rounded-full', status.tone)}
                />
                <span className="truncate">{status.label}</span>
              </p>
            ) : (
              <p className="text-text-secondary truncate text-[11px] tracking-wide uppercase">
                {kindLabel}
              </p>
            )}
          </div>
        </div>
        {description ? (
          <p className="text-text-secondary line-clamp-3 text-xs leading-snug">{description}</p>
        ) : (
          <p className="text-text-tertiary line-clamp-3 text-xs leading-snug italic">
            {isNative ? localize('com_ui_tools_native_short') : kindLabel}
          </p>
        )}
        {(item.kind === 'action' && item.endpointCount > 0) || isPublicSkill || isSharedSkill ? (
          <div className="mt-auto flex w-full flex-wrap items-center gap-1.5">
            {item.kind === 'action' && item.endpointCount > 0 && (
              <span className="bg-surface-tertiary text-text-tertiary inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px]">
                {localize(
                  item.endpointCount === 1
                    ? 'com_ui_tools_endpoint_count_one'
                    : 'com_ui_tools_endpoint_count',
                  { count: item.endpointCount },
                )}
              </span>
            )}
            {isSharedSkill && skill && (
              <span
                className="bg-surface-tertiary text-text-tertiary inline-flex max-w-[60%] items-center gap-1 rounded-full px-2 py-0.5 text-[10px]"
                title={localize('com_ui_tools_shared_by', { name: skill.authorName })}
                aria-label={localize('com_ui_tools_shared_by', { name: skill.authorName })}
              >
                <User className="size-2.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{skill.authorName}</span>
              </span>
            )}
            {isPublicSkill && (
              <span
                className="bg-surface-tertiary text-text-tertiary inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px]"
                title={localize('com_ui_sr_public_skill')}
                aria-label={localize('com_ui_sr_public_skill')}
              >
                <Globe className="size-2.5" aria-hidden="true" />
              </span>
            )}
          </div>
        ) : null}
      </button>
      {(canFavorite || canConfigure || showInfoOnly) && (
        <div className="absolute right-2 bottom-2 flex items-center gap-1">
          {(canConfigure || showInfoOnly) && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onConfigure?.(item);
              }}
              aria-label={
                canConfigure ? localize('com_ui_tools_configure') : localize('com_ui_tools_info')
              }
              className={cn(
                'text-text-secondary flex size-7 items-center justify-center rounded-lg',
                'hover:bg-surface-hover hover:text-text-primary transition duration-150',
                'no-touch:opacity-0 group-focus-within:opacity-100 group-hover:opacity-100',
                'focus-visible:ring-ring-primary focus:outline-hidden focus-visible:opacity-100 focus-visible:ring-2',
              )}
            >
              <DetailIcon className="size-4" aria-hidden="true" />
            </button>
          )}
          {canFavorite && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleFavorite?.(item);
              }}
              aria-pressed={isFavorited}
              aria-label={localize(isFavorited ? 'com_ui_unfavorite' : 'com_ui_favorite')}
              className={cn(
                'text-text-secondary flex size-7 items-center justify-center rounded-lg',
                'hover:bg-surface-hover hover:text-text-primary transition duration-150',
                'group-focus-within:opacity-100 group-hover:opacity-100',
                'focus-visible:ring-ring-primary focus:outline-hidden focus-visible:opacity-100 focus-visible:ring-2',
                !isFavorited && 'no-touch:opacity-0',
                isFavorited && 'text-series-4 hover:text-series-4',
              )}
            >
              <Star className={cn('size-4', isFavorited && 'fill-current')} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const ToolCard = memo(ToolCardImpl);
export default ToolCard;

import { memo, useState } from 'react';
import { Button } from '@librechat/client';
import { Info, Settings, X } from 'lucide-react';
import type { TranslationKeys } from '~/hooks/useLocalize';
import type { AgentItem } from './items/types';
import { hasConfigurableSettings } from './items/configurable';
import { getIconForItem } from './items/icons';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface Props {
  item: AgentItem;
  onInfo: (item: AgentItem) => void;
  onRemove: (item: AgentItem) => void;
}

function getSuffix(item: AgentItem): string | null {
  if (item.kind === 'mcp' && item.toolCount > 0) return `· ${item.toolCount}`;
  if (item.kind === 'action' && item.endpointCount > 0) return `· ${item.endpointCount}`;
  return null;
}

function RowIcon({ item }: { item: AgentItem }) {
  const { Icon, colorClass, iconUrl } = getIconForItem(item);
  const [imgError, setImgError] = useState(false);

  if (iconUrl && !imgError) {
    return (
      <span
        className="bg-surface-fixed flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md"
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
      className={cn('flex size-7 shrink-0 items-center justify-center rounded-md', colorClass)}
      aria-hidden="true"
    >
      <Icon className="size-3.5" strokeWidth={1.75} />
    </span>
  );
}

function ToolRowImpl({ item, onInfo, onRemove }: Props) {
  const localize = useLocalize();
  const suffix = getSuffix(item);
  const displayName = item.kind === 'builtin' ? localize(item.name as TranslationKeys) : item.name;
  const configurable = hasConfigurableSettings(item);
  const DetailIcon = configurable ? Settings : Info;

  return (
    <div className="group hover:bg-surface-secondary relative flex w-full items-center gap-2 rounded-lg px-2 py-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <RowIcon item={item} />
        <span className="text-text-primary flex min-w-0 items-center gap-1 truncate text-sm">
          <span className="truncate font-medium">{displayName}</span>
          {suffix && <span className="text-text-secondary">{suffix}</span>}
        </span>
      </div>
      {item.status === 'needs_setup' && (
        <span role="status" className="flex shrink-0 items-center">
          <span className="bg-status-error size-1.5 rounded-full" aria-hidden="true" />
          <span className="sr-only">{localize('com_ui_tools_needs_setup')}</span>
        </span>
      )}
      <div
        className={cn(
          'flex shrink-0 items-center gap-0.5',
          'no-touch:opacity-0 group-focus-within:opacity-100 group-hover:opacity-100',
        )}
      >
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => onInfo(item)}
          aria-label={
            configurable ? localize('com_ui_tools_configure') : localize('com_ui_tools_info')
          }
          className={cn(
            'text-text-secondary rounded-md',
            'hover:text-text-secondary focus-visible:opacity-100',
          )}
        >
          <DetailIcon className="size-3.5" aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => onRemove(item)}
          aria-label={localize('com_ui_tools_remove')}
          className={cn(
            'text-text-secondary rounded-md',
            'hover:text-text-secondary focus-visible:opacity-100',
          )}
        >
          <X className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

const ToolRow = memo(ToolRowImpl);
export default ToolRow;

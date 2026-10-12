import { useState } from 'react';
import { useAtom } from 'jotai';
import * as Ariakit from '@ariakit/react';
import { Check, SlidersHorizontal } from 'lucide-react';
import type { TImageChoice, TImageSpec } from 'librechat-data-provider';
import { imageChoicesAtom, sizeLabel } from './imageOptions';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface Group {
  field: keyof TImageChoice;
  label: string;
  values: string[];
  format: (value: string) => string;
}

/**
 * The Image Gen chip's parameter menu: one radio group per parameter the
 * selected model honours, each starting at Auto, which leaves the choice to
 * the chat model. Pinned values ride on every send until changed.
 */
export default function ImageOptionsMenu({ spec }: { spec: TImageSpec }) {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useAtom(imageChoicesAtom);
  const choice = choices[spec.name] ?? {};
  const options = spec.options ?? {};

  const groups: Group[] = [
    {
      field: 'size',
      label: localize('com_ui_size'),
      values: options.sizes ?? [],
      format: sizeLabel,
    },
    {
      field: 'aspectRatio',
      label: localize('com_ui_aspect_ratio'),
      values: options.aspectRatios ?? [],
      format: (value) => value,
    },
    {
      field: 'imageSize',
      label: localize('com_ui_resolution'),
      values: options.imageSizes ?? [],
      format: (value) => value,
    },
  ].filter((group): group is Group => group.values.length > 0);

  const pick = (field: keyof TImageChoice, value: string | undefined) =>
    setChoices((prev) => {
      const next: TImageChoice = { ...(prev[spec.name] ?? {}) };
      if (value == null) {
        delete next[field];
      } else {
        next[field] = value;
      }
      const rest = { ...prev };
      delete rest[spec.name];
      return Object.keys(next).length > 0 ? { ...rest, [spec.name]: next } : rest;
    });

  /* The chip shows what is pinned (`16:9 · 2K`), or nothing beyond its icon. */
  const pinnedLabel = (group: Group): string | null => {
    const value = choice[group.field];
    if (value == null || !group.values.includes(value)) {
      return null;
    }
    return group.field === 'size' ? sizeLabel(value).split(' · ')[0] : value;
  };
  const summary = groups.map(pinnedLabel).filter(Boolean).join(' · ');
  const menuLabel = localize('com_ui_image_options');

  return (
    <Ariakit.MenuProvider open={open} setOpen={setOpen} placement="bottom">
      <Ariakit.MenuButton
        aria-label={summary ? `${menuLabel}: ${summary}` : menuLabel}
        onClick={(e) => e.stopPropagation()}
        data-testid="image-options-button"
        className="text-text-secondary hover:bg-surface-tertiary hover:text-text-primary focus-visible:ring-border-xheavy -mr-0.5 flex shrink-0 items-center gap-0.5 rounded px-1 text-xs transition-colors focus-visible:ring-2 focus-visible:outline-hidden"
      >
        <SlidersHorizontal className="size-3 shrink-0 opacity-70" aria-hidden="true" />
        {summary && <span className="max-w-[7rem] truncate">{summary}</span>}
      </Ariakit.MenuButton>
      <Ariakit.Menu
        portal
        gutter={6}
        unmountOnHide
        onClick={(event) => event.stopPropagation()}
        className="animate-composer-popover border-border-menu bg-surface-menu rounded-theme-menu-panel z-50 max-h-[60vh] min-w-[12rem] overflow-y-auto border p-1 shadow-lg outline-hidden"
      >
        {groups.map((group, index) => (
          <Ariakit.MenuGroup key={group.field} className={cn(index > 0 && 'mt-1')}>
            <Ariakit.MenuGroupLabel className="text-text-tertiary px-2 pt-1 pb-0.5 text-xs font-medium">
              {group.label}
            </Ariakit.MenuGroupLabel>
            {[undefined, ...group.values].map((value) => {
              const active =
                value == null ? choice[group.field] == null : choice[group.field] === value;
              return (
                <Ariakit.MenuItemRadio
                  key={value ?? 'auto'}
                  name={group.field}
                  value={value ?? 'auto'}
                  checked={active}
                  hideOnClick={false}
                  onClick={() => pick(group.field, value)}
                  className="text-text-secondary data-[active-item]:bg-surface-hover data-[active-item]:text-text-primary flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm"
                >
                  <span className="truncate">
                    {value == null ? localize('com_ui_auto') : group.format(value)}
                  </span>
                  {active && <Check className="size-4 shrink-0" aria-hidden="true" />}
                </Ariakit.MenuItemRadio>
              );
            })}
          </Ariakit.MenuGroup>
        ))}
      </Ariakit.Menu>
    </Ariakit.MenuProvider>
  );
}

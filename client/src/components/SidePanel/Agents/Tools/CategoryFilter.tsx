import { useState, useMemo } from 'react';
import * as Ariakit from '@ariakit/react/menu';
import { ChevronDown, Filter } from 'lucide-react';
import { Button, DropdownPopup } from '@librechat/client';
import type { ReactNode } from 'react';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

export interface CategoryOption {
  value: string;
  label: string;
  icon?: ReactNode;
}

interface Props {
  options: CategoryOption[];
  value: string | 'all';
  onChange: (next: string | 'all') => void;
}

export default function CategoryFilter({ options, value, onChange }: Props) {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);

  const items = useMemo(
    () => [
      {
        label: localize('com_ui_all_proper'),
        icon: <Filter className="size-4" aria-hidden="true" />,
        onClick: () => onChange('all'),
      },
      ...options.map((opt) => ({
        label: opt.label,
        icon: opt.icon,
        onClick: () => onChange(opt.value),
      })),
    ],
    [localize, options, onChange],
  );

  if (options.length === 0) {
    return null;
  }

  const active = options.find((o) => o.value === value);
  const label = active ? active.label : localize('com_ui_all_proper');
  const isFiltered = value !== 'all';

  return (
    <DropdownPopup
      portal={true}
      mountByState={true}
      unmountOnHide={true}
      isOpen={open}
      setIsOpen={setOpen}
      menuId="marketplace-category-filter"
      trigger={
        <Ariakit.MenuButton
          render={
            <Button
              variant="outline"
              size="default"
              className="h-10 gap-1.5 px-3 text-sm font-normal"
              aria-label={localize('com_ui_category')}
            >
              <Filter
                className={cn('size-4', isFiltered ? 'text-accent-primary' : 'text-text-tertiary')}
                aria-hidden="true"
              />
              <span className="max-w-[10ch] truncate">{label}</span>
              <ChevronDown className="text-text-tertiary size-3.5" aria-hidden="true" />
            </Button>
          }
        />
      }
      items={items}
    />
  );
}

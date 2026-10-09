import React, { useMemo, useState } from 'react';
import * as Ariakit from '@ariakit/react';
import { DropdownPopup } from '@librechat/client';
import { useFormContext, Controller } from 'react-hook-form';
import type { MenuItemProps } from '@librechat/client';
import type { ReactNode } from 'react';
import { useCategories, useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface CategorySelectorProps {
  className?: string;
}

const CategorySelector: React.FC<CategorySelectorProps> = ({ className = '' }) => {
  const localize = useLocalize();
  const { control, watch, setValue } = useFormContext();
  const [isOpen, setIsOpen] = useState(false);
  const { categories, emptyCategory } = useCategories({ hasAccess: true });

  const watchedCategory = watch('category') as string | undefined;

  const categoryOption = useMemo(
    () => (categories ?? []).find((c) => c.value === watchedCategory) ?? emptyCategory,
    [categories, watchedCategory, emptyCategory],
  );

  const menuItems: MenuItemProps[] = useMemo(() => {
    if (!categories) {
      return [];
    }
    return categories.map((category: { value: string; label: string; icon?: ReactNode }) => ({
      id: category.value,
      label: category.label,
      icon: category.icon,
      onClick: () => {
        setValue('category', category.value || '', { shouldDirty: true });
        setIsOpen(false);
      },
    }));
  }, [categories, setValue]);

  const trigger = (
    <Ariakit.MenuButton
      className={cn(
        'relative inline-flex h-9 items-center justify-between rounded-xl border border-border-medium bg-transparent px-3 text-sm text-text-primary transition-all duration-200 ease-in-out hover:bg-surface-hover hover:text-text-primary focus:ring-2 focus:ring-ring-primary',
        'gap-2 sm:w-fit',
        className,
      )}
      onClick={() => setIsOpen(!isOpen)}
      aria-label={localize('com_ui_category')}
    >
      <div className="flex items-center space-x-2">
        {'icon' in categoryOption && categoryOption.icon != null && (
          <span>{categoryOption.icon as ReactNode}</span>
        )}
        <span>{categoryOption.value ? categoryOption.label : localize('com_ui_category')}</span>
      </div>
      <Ariakit.MenuButtonArrow />
    </Ariakit.MenuButton>
  );

  return (
    <Controller
      name="category"
      control={control}
      render={() => (
        <DropdownPopup
          trigger={trigger}
          items={menuItems}
          isOpen={isOpen}
          setIsOpen={setIsOpen}
          menuId="skill-category-selector-menu"
          className="mt-2"
          portal={true}
        />
      )}
    />
  );
};

export default CategorySelector;

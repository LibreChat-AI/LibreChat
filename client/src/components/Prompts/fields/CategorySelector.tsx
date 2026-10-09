import React, { useId, useMemo, useState } from 'react';
import * as Ariakit from '@ariakit/react';
import { useTranslation } from 'react-i18next';
import { DropdownPopup } from '@librechat/client';
import { LocalStorageKeys } from 'librechat-data-provider';
import { useFormContext, Controller } from 'react-hook-form';
import type { MenuItemProps } from '@librechat/client';
import type { ReactNode } from 'react';
import { usePromptGroupsContext } from '~/Providers';
import { useCategories } from '~/hooks';
import { cn } from '~/utils';

interface CategorySelectorProps {
  currentCategory?: string;
  onValueChange?: (value: string) => void;
  className?: string;
  /** Portaled menus are unclickable inside a modal dialog, which locks pointer events on the body */
  portal?: boolean;
}

const CategorySelector: React.FC<CategorySelectorProps> = ({
  currentCategory,
  onValueChange,
  className = '',
  portal = true,
}) => {
  const instanceId = useId();
  const menuId = `${instanceId}-category-menu`;
  const { t } = useTranslation();
  const formContext = useFormContext();
  const [isOpen, setIsOpen] = useState(false);
  const { hasAccess } = usePromptGroupsContext() ?? {};
  const { categories, emptyCategory } = useCategories({ hasAccess });

  const control = formContext?.control;
  const watch = formContext?.watch;
  const setValue = formContext?.setValue;

  const watchedCategory = watch ? watch('category') : currentCategory;

  const categoryOption = useMemo(
    () =>
      (categories ?? []).find(
        (category) => category.value === (watchedCategory ?? currentCategory),
      ) ?? emptyCategory,
    [watchedCategory, categories, currentCategory, emptyCategory],
  );

  const displayCategory = useMemo(() => {
    if (!categoryOption.value && !('icon' in categoryOption)) {
      return {
        ...categoryOption,
        icon: (<span className="i-heroicons-tag" />) as ReactNode,
        label: categoryOption.label || t('com_ui_empty_category'),
      };
    }
    return categoryOption;
  }, [categoryOption, t]);

  const menuItems: MenuItemProps[] = useMemo(() => {
    if (!categories) return [];

    return categories.map((category) => ({
      id: `${menuId}-item-${category.value}`,
      label: category.label,
      icon: 'icon' in category ? category.icon : undefined,
      onClick: () => {
        const value = category.value || '';
        if (formContext && setValue) {
          setValue('category', value, { shouldDirty: false });
        }
        localStorage.setItem(LocalStorageKeys.LAST_PROMPT_CATEGORY, value);
        onValueChange?.(value);
        setIsOpen(false);
      },
    }));
  }, [categories, formContext, menuId, setValue, onValueChange]);

  const trigger = (
    <Ariakit.MenuButton
      className={cn(
        'relative inline-flex h-9 items-center justify-between rounded-xl border border-border-medium bg-transparent px-3 text-sm text-text-primary transition-all duration-200 ease-in-out hover:bg-surface-hover hover:text-text-primary focus:ring-2 focus:ring-ring-primary',
        'gap-2 sm:w-fit',
        className,
      )}
      onClick={() => setIsOpen(!isOpen)}
      aria-label={t('com_ui_prompt_category_selector_aria')}
    >
      <div className="flex items-center space-x-2">
        {'icon' in displayCategory && displayCategory.icon != null && (
          <span>{displayCategory.icon as ReactNode}</span>
        )}
        <span>{displayCategory.value ? displayCategory.label : t('com_ui_category')}</span>
      </div>
      <Ariakit.MenuButtonArrow />
    </Ariakit.MenuButton>
  );

  return formContext ? (
    <Controller
      name="category"
      control={control}
      render={() => (
        <DropdownPopup
          trigger={trigger}
          items={menuItems}
          isOpen={isOpen}
          setIsOpen={setIsOpen}
          menuId={menuId}
          className="mt-2"
          portal={portal}
        />
      )}
    />
  ) : (
    <DropdownPopup
      trigger={trigger}
      items={menuItems}
      isOpen={isOpen}
      setIsOpen={setIsOpen}
      menuId={menuId}
      className="mt-2"
      portal={portal}
    />
  );
};

export default CategorySelector;

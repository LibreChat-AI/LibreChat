import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import * as Ariakit from '@ariakit/react';
import { useTranslation } from 'react-i18next';
import { useFormContext, Controller } from 'react-hook-form';
import { Button, DropdownPopup, Input } from '@librechat/client';
import {
  LocalStorageKeys,
  SYSTEM_CATEGORY_PREFIX,
  promptCategoryValueSchema,
} from 'librechat-data-provider';
import type { MenuItemProps } from '@librechat/client';
import type { ReactNode } from 'react';
import { useGetStartupConfig } from '~/data-provider';
import { usePromptGroupsContext } from '~/Providers';
import { CategoryIcon } from '~/components/Prompts';
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
  const [isCreating, setIsCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { data: startupConfig } = useGetStartupConfig();
  const allowCustom = startupConfig?.promptCategories?.allowCustom === true;
  const { hasAccess } = usePromptGroupsContext() ?? {};
  const { categories, emptyCategory } = useCategories({ hasAccess });

  const control = formContext?.control;
  const watch = formContext?.watch;
  const setValue = formContext?.setValue;

  const watchedCategory = watch ? watch('category') : currentCategory;

  const categoryOption = useMemo(() => {
    const selected = watchedCategory ?? currentCategory;
    const found = (categories ?? []).find((category) => category.value === selected);
    if (found) {
      return found;
    }
    if (selected) {
      return { value: selected, label: selected, icon: <CategoryIcon category={selected} /> };
    }
    return emptyCategory;
  }, [watchedCategory, categories, currentCategory, emptyCategory]);

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

  const selectCategory = useCallback(
    (value: string) => {
      if (formContext && setValue) {
        setValue('category', value, { shouldDirty: false });
      }
      localStorage.setItem(LocalStorageKeys.LAST_PROMPT_CATEGORY, value);
      onValueChange?.(value);
      setIsOpen(false);
    },
    [formContext, setValue, onValueChange],
  );

  const menuItems: MenuItemProps[] = useMemo(() => {
    if (!categories) return [];

    const items: MenuItemProps[] = categories.map((category) => ({
      id: `${menuId}-item-${category.value}`,
      label: category.label,
      icon: 'icon' in category ? category.icon : undefined,
      onClick: () => selectCategory(category.value || ''),
    }));

    if (allowCustom) {
      items.push({
        id: `${menuId}-new-category`,
        label: t('com_ui_new_category'),
        onClick: () => {
          setIsOpen(false);
          setIsCreating(true);
        },
      });
    }
    return items;
  }, [categories, allowCustom, menuId, selectCategory, t]);

  useEffect(() => {
    if (isCreating) {
      inputRef.current?.focus();
    }
  }, [isCreating]);

  const trimmed = draft.trim();
  const existing = useMemo(() => {
    const needle = trimmed.toLowerCase();
    return (categories ?? []).find(
      (category) =>
        category.value &&
        (category.value.toLowerCase() === needle || category.label.toLowerCase() === needle),
    );
  }, [categories, trimmed]);
  const parsed = promptCategoryValueSchema.safeParse(draft);
  const invalidReason = (() => {
    if (existing || parsed.success || !trimmed) {
      return null;
    }
    if (trimmed.startsWith(SYSTEM_CATEGORY_PREFIX)) {
      return t('com_ui_category_reserved_prefix');
    }
    return parsed.error.issues.some((issue) => issue.code === 'too_big')
      ? t('com_ui_category_too_long')
      : t('com_ui_category_invalid_chars');
  })();
  const canSubmit = existing != null || parsed.success;
  const reasonId = `${menuId}-new-category-reason`;

  const closeCreate = () => {
    setIsCreating(false);
    setDraft('');
  };

  const submitDraft = () => {
    if (!canSubmit) {
      return;
    }
    selectCategory(existing ? existing.value : trimmed);
    closeCreate();
  };

  const handleDraftKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeCreate();
      triggerRef.current?.focus();
    }
    if (e.key === 'Enter' && !(e.nativeEvent.isComposing || e.keyCode === 229)) {
      e.preventDefault();
      submitDraft();
    }
  };

  const trigger = (
    <Ariakit.MenuButton
      ref={triggerRef}
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

  const popup = (
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

  const createForm = isCreating && (
    <div className="mt-2 flex items-center gap-2">
      <Input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleDraftKeyDown}
        aria-label={t('com_ui_category_name')}
        aria-describedby={invalidReason ? reasonId : undefined}
        aria-invalid={invalidReason ? true : undefined}
      />
      <Button
        type="button"
        disabled={!canSubmit}
        onClick={submitDraft}
        aria-describedby={invalidReason ? reasonId : undefined}
      >
        {existing
          ? t('com_ui_use_category', { 0: existing.label })
          : t('com_ui_create_category', { 0: trimmed })}
      </Button>
      {invalidReason && (
        <span id={reasonId} className="text-sm text-text-secondary">
          {invalidReason}
        </span>
      )}
    </div>
  );

  return (
    <>
      {formContext ? <Controller name="category" control={control} render={() => popup} /> : popup}
      {createForm}
    </>
  );
};

export default CategorySelector;

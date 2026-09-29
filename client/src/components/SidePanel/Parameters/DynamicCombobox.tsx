import { useMemo, useState, useCallback } from 'react';
import { Label, HoverCard, HoverCardTrigger, ControlCombobox } from '@librechat/client';
import type { DynamicSettingProps } from 'librechat-data-provider';
import { TranslationKeys, useLocalize, useParameterEffects } from '~/hooks';
import { useChatContext } from '~/Providers';
import OptionHover from './OptionHover';
import { ESide } from '~/common';
import { cn } from '~/utils';

function DynamicCombobox({
  label = '',
  settingKey,
  defaultValue,
  description = '',
  columnSpan,
  setOption,
  options: _options,
  items: _items,
  showLabel = true,
  showDefault = false,
  labelCode = false,
  descriptionCode = false,
  searchPlaceholderCode = false,
  selectPlaceholderCode = false,
  conversation,
  isCollapsed = false,
  SelectIcon = null,
  selectPlaceholder = '',
  searchPlaceholder = '',
}: DynamicSettingProps & { isCollapsed?: boolean; SelectIcon?: React.ReactNode }) {
  const localize = useLocalize();
  const { preset } = useChatContext();
  const [inputValue, setInputValue] = useState<string | null>(null);

  const selectedValue = useMemo(() => {
    return conversation?.[settingKey] ?? defaultValue;
  }, [conversation, defaultValue, settingKey]);

  const items = useMemo(() => {
    if (_items != null) {
      return _items;
    }
    return (_options ?? []).map((option) => ({
      label: option,
      value: option,
    }));
  }, [_options, _items]);

  const handleChange = useCallback(
    (value: string) => {
      setInputValue(value);
      setOption(settingKey)(value);
    },
    [setOption, settingKey],
  );

  useParameterEffects({
    preset,
    settingKey,
    defaultValue,
    conversation,
    inputValue,
    setInputValue,
    preventDelayedUpdate: true,
  });

  const options = items ?? _options ?? [];
  if (options.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-start gap-6',
        columnSpan != null ? `col-span-${columnSpan}` : 'col-span-full',
      )}
    >
      <HoverCard openDelay={300}>
        <HoverCardTrigger className="grid w-full items-center gap-2">
          {showLabel === true && (
            <div className="flex w-full justify-between">
              <Label
                htmlFor={`${settingKey}-dynamic-combobox`}
                className="text-left text-xs font-medium"
              >
                {labelCode ? (localize(label as TranslationKeys) ?? label) : label || settingKey}
                {showDefault && (
                  <small className="opacity-40 high-contrast:opacity-100">
                    ({localize('com_endpoint_default')}: {defaultValue})
                  </small>
                )}
              </Label>
            </div>
          )}
          <ControlCombobox
            displayValue={selectedValue}
            selectPlaceholder={
              selectPlaceholderCode === true
                ? localize(selectPlaceholder as TranslationKeys)
                : selectPlaceholder
            }
            searchPlaceholder={
              searchPlaceholderCode === true
                ? localize(searchPlaceholder as TranslationKeys)
                : searchPlaceholder
            }
            isCollapsed={isCollapsed}
            ariaLabel={settingKey}
            selectedValue={selectedValue ?? ''}
            setValue={handleChange}
            items={items}
            SelectIcon={SelectIcon}
          />
        </HoverCardTrigger>
        {description && (
          <OptionHover
            description={
              descriptionCode
                ? (localize(description as TranslationKeys) ?? description)
                : description
            }
            side={ESide.Left}
          />
        )}
      </HoverCard>
    </div>
  );
}

export default DynamicCombobox;

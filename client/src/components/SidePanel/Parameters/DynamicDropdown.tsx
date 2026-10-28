import { useId, useMemo, useState } from 'react';
import { OptionTypes } from 'librechat-data-provider';
import { Label, Dropdown, HoverCard, HoverCardTrigger } from '@librechat/client';
import type { DynamicSettingProps } from 'librechat-data-provider';
import { TranslationKeys, useLocalize, useParameterEffects } from '~/hooks';
import { useChatContext } from '~/Providers';
import OptionHover from './OptionHover';
import { ESide } from '~/common';
import { cn } from '~/utils';

function DynamicDropdown({
  label = '',
  settingKey,
  defaultValue,
  description = '',
  columnSpan,
  setOption,
  optionType,
  options,
  items,
  // type: _type,
  readonly = false,
  showLabel = true,
  showDefault = false,
  labelCode = false,
  descriptionCode = false,
  placeholder = '',
  placeholderCode = false,
  conversation,
}: DynamicSettingProps) {
  const localize = useLocalize();
  const labelId = useId();
  const { preset } = useChatContext();
  const [inputValue, setInputValue] = useState<string | null>(null);

  const selectedValue = useMemo(() => {
    if (optionType === OptionTypes.Custom) {
      // TODO: custom logic, add to payload but not to conversation
      return inputValue;
    }

    return conversation?.[settingKey] ?? defaultValue;
  }, [conversation, defaultValue, optionType, settingKey, inputValue]);

  const handleChange = (value: string) => {
    if (optionType === OptionTypes.Custom) {
      // TODO: custom logic, add to payload but not to conversation
      setInputValue(value);
      return;
    }
    setOption(settingKey)(value);
  };

  useParameterEffects({
    preset,
    settingKey,
    defaultValue,
    conversation,
    inputValue,
    setInputValue,
    preventDelayedUpdate: true,
  });

  const dropdownOptions = useMemo(
    () =>
      items?.map((item) => {
        const value = String(item.value ?? '');
        return { value, label: item.label ?? value };
      }) ??
      options ??
      [],
    [items, options],
  );

  if (dropdownOptions.length === 0) {
    return null;
  }

  const labelText = labelCode ? (localize(label as TranslationKeys) ?? label) : label || settingKey;

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-start gap-6',
        columnSpan != null ? `col-span-${columnSpan}` : 'col-span-full',
      )}
    >
      <HoverCard openDelay={300}>
        <HoverCardTrigger className="grid h-full w-full content-between items-center gap-2">
          {showLabel === true && (
            <div className="flex w-full justify-between">
              <Label id={labelId} className="text-start text-xs font-medium">
                {labelText}
                {showDefault && (
                  <small className="high-contrast:opacity-100 opacity-40">
                    ({localize('com_endpoint_default')}: {defaultValue})
                  </small>
                )}
              </Label>
            </div>
          )}
          <Dropdown
            variant="field"
            testId="select-dropdown-button"
            aria-labelledby={showLabel === true ? labelId : undefined}
            ariaLabel={showLabel === true ? undefined : labelText}
            disabled={readonly}
            value={selectedValue ?? ''}
            onChange={handleChange}
            options={dropdownOptions}
            searchable={dropdownOptions.length > 10}
            searchPlaceholder={localize('com_ui_search')}
            searchEmptyText={localize('com_ui_no_results_found')}
            placeholder={
              placeholderCode
                ? (localize(placeholder as TranslationKeys) ?? placeholder)
                : placeholder
            }
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

export default DynamicDropdown;

import { useMemo, useState } from 'react';
import { OptionTypes } from 'librechat-data-provider';
import { Label, HoverCard, HoverCardTrigger, SelectDropDown } from '@librechat/client';
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

  if (!options || options.length === 0) {
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
                htmlFor={`${settingKey}-dynamic-dropdown`}
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
          <SelectDropDown
            showLabel={false}
            emptyTitle={true}
            disabled={readonly}
            value={selectedValue}
            setValue={handleChange}
            availableValues={options}
            containerClassName="w-full"
            className="py-1.5"
            id={`${settingKey}-dynamic-dropdown`}
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

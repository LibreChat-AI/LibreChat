import { useState } from 'react';
import { Label, Switch, HoverCard, HoverCardTrigger } from '@librechat/client';
import type { DynamicSettingProps } from 'librechat-data-provider';
import { TranslationKeys, useLocalize, useParameterEffects } from '~/hooks';
import { useChatContext } from '~/Providers';
import OptionHover from './OptionHover';
import { ESide } from '~/common';

function DynamicSwitch({
  label = '',
  settingKey,
  defaultValue,
  enumMappings,
  description = '',
  columnSpan,
  setOption,
  readonly = false,
  showDefault = false,
  labelCode = false,
  descriptionCode = false,
  conversation,
}: DynamicSettingProps) {
  const localize = useLocalize();
  const { preset } = useChatContext();
  const [inputValue, setInputValue] = useState<boolean>(!!(defaultValue as boolean | undefined));
  useParameterEffects({
    preset,
    settingKey,
    defaultValue,
    conversation,
    inputValue,
    setInputValue,
    preventDelayedUpdate: true,
  });

  const savedValue = conversation?.[settingKey] ?? defaultValue;
  const effectiveValue = enumMappings?.[String(savedValue)];
  const selectedValue = typeof effectiveValue === 'boolean' ? effectiveValue : savedValue;
  const routeIsForced =
    typeof enumMappings?.true === 'boolean' && enumMappings.true === enumMappings.false;

  const handleCheckedChange = (checked: boolean) => {
    setInputValue(checked);
    setOption(settingKey)(checked);
  };

  return (
    <div
      className={`flex flex-col items-center justify-start gap-6 ${
        columnSpan != null ? `col-span-${columnSpan}` : 'col-span-full'
      }`}
    >
      <HoverCard openDelay={300}>
        <HoverCardTrigger className="grid w-full items-center gap-2">
          <div className="flex justify-between">
            <Label
              htmlFor={`${settingKey}-dynamic-switch`}
              className="break-words text-left text-xs font-medium"
            >
              {labelCode ? (localize(label as TranslationKeys) ?? label) : label || settingKey}{' '}
              {showDefault && (
                <small className="opacity-40 high-contrast:opacity-100">
                  ({localize('com_endpoint_default')}:{' '}
                  {defaultValue != null ? localize('com_ui_on') : localize('com_ui_off')})
                </small>
              )}
            </Label>
          </div>
          <Switch
            id={`${settingKey}-dynamic-switch`}
            checked={selectedValue}
            onCheckedChange={handleCheckedChange}
            disabled={readonly || routeIsForced}
            className="flex"
            aria-label={
              labelCode ? (localize(label as TranslationKeys) ?? label) : label || settingKey
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

export default DynamicSwitch;

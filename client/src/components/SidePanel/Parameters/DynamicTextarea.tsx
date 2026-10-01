import { OptionTypes } from 'librechat-data-provider';
import { Label, TextareaAutosize, HoverCard, HoverCardTrigger } from '@librechat/client';
import type { DynamicSettingProps } from 'librechat-data-provider';
import { useLocalize, useDebouncedInput, useParameterEffects, TranslationKeys } from '~/hooks';
import { useChatContext } from '~/Providers';
import OptionHover from './OptionHover';
import { ESide } from '~/common';
import { cn } from '~/utils';

function DynamicTextarea({
  label = '',
  settingKey,
  defaultValue,
  description = '',
  columnSpan,
  setOption,
  optionType,
  placeholder = '',
  readonly = false,
  showDefault = false,
  labelCode = false,
  descriptionCode = false,
  placeholderCode = false,
  conversation,
}: DynamicSettingProps) {
  const localize = useLocalize();
  const { preset } = useChatContext();

  const [setInputValue, inputValue, setLocalValue, flushInputValue] = useDebouncedInput<
    string | null
  >({
    optionKey: settingKey,
    initialValue:
      optionType !== OptionTypes.Custom
        ? (conversation?.[settingKey] as string)
        : (defaultValue as string),
    setter: () => ({}),
    setOption,
  });

  useParameterEffects({
    preset,
    settingKey,
    defaultValue: typeof defaultValue === 'undefined' ? '' : defaultValue,
    conversation,
    inputValue,
    setInputValue: setLocalValue,
  });

  return (
    <div
      className={`flex flex-col items-center justify-start gap-6 ${
        columnSpan != null ? `col-span-${columnSpan}` : 'col-span-full'
      }`}
    >
      <HoverCard openDelay={300}>
        <HoverCardTrigger className="grid h-full w-full content-between items-center gap-2">
          <div className="flex w-full justify-between">
            <Label
              htmlFor={`${settingKey}-dynamic-textarea`}
              className="text-left text-xs font-medium"
            >
              {labelCode ? (localize(label as TranslationKeys) ?? label) : label || settingKey}{' '}
              {showDefault && (
                <small className="high-contrast:opacity-100 opacity-40">
                  (
                  {typeof defaultValue === 'undefined' || !(defaultValue as string).length
                    ? localize('com_endpoint_default_blank')
                    : `${localize('com_endpoint_default')}: ${defaultValue}`}
                  )
                </small>
              )}
            </Label>
          </div>
          <TextareaAutosize
            focusOutline="hidden"
            id={`${settingKey}-dynamic-textarea`}
            /** The field is measured by a shadow copy of itself, and the panel mounts
             *  before the sidebar has settled on a width, so that measurement can come
             *  back as one word per line. Capping the rows lets the library clamp its
             *  own answer instead of leaving a CSS max-height to hide a wrong one. */
            minRows={3}
            maxRows={8}
            disabled={readonly}
            value={inputValue ?? ''}
            onChange={setInputValue}
            /** Clicking Save blurs this first, so the pending edit is committed
             *  before submitPreset reads the preset. */
            onBlur={flushInputValue}
            aria-label={localize(label as TranslationKeys)}
            placeholder={
              placeholderCode
                ? (localize(placeholder as TranslationKeys) ?? placeholder)
                : placeholder
            }
            className={cn(
              'border-border-light bg-surface-secondary flex max-h-[220px] min-h-[76px] w-full resize-none rounded-lg border px-3 py-2 text-sm',
            )}
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

export default DynamicTextarea;

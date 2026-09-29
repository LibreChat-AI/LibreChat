import { useEffect, useRef } from 'react';
import { Label, Input, HoverCard, HoverCardTrigger } from '@librechat/client';
import { OptionTypes, SettingTypes, clampSettingRange } from 'librechat-data-provider';
import type { DynamicSettingProps } from 'librechat-data-provider';
import { useLocalize, useDebouncedInput, useParameterEffects, TranslationKeys } from '~/hooks';
import { cn, sanitizeIntegerInput } from '~/utils';
import { useChatContext } from '~/Providers';
import OptionHover from './OptionHover';
import { ESide } from '~/common';

function DynamicInput({
  type,
  range,
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
    string | number
  >({
    optionKey: settingKey,
    initialValue: optionType !== OptionTypes.Custom ? conversation?.[settingKey] : defaultValue,
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

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (type === SettingTypes.Number) {
      // Integer params: strip thousands separators so "120,000" / "120.000"
      // become 120000 instead of being truncated to 120 downstream by parseInt.
      // Keep a leading minus for fields whose range permits negatives (e.g.
      // Google thinkingBudget, where -1 selects dynamic/auto thinking).
      const allowNegative = range != null && range.min < 0;
      const sanitized = sanitizeIntegerInput(e.target.value, allowNegative);
      // A lone "-" is an in-progress negative; keep it as a string so the field
      // shows the sign instead of coercing Number("-") to NaN. It resolves to a
      // number as soon as a digit is typed.
      setInputValue(sanitized, sanitized !== '-');
      return;
    }
    setInputValue(e, type === SettingTypes.String ? false : !isNaN(Number(e.target.value)));
  };

  /** The schema declares a range for number fields, but nothing enforced it, so
   *  a value past the endpoint's ceiling (a Google output limit above 65535,
   *  say) was persisted and only rejected later by the provider. Clamping on
   *  blur rather than on change leaves partially typed numbers alone. */
  const handleInputBlur = () => {
    /** Clicking Save blurs the field first, so committing the pending edit here
     *  is what stops submitPreset reading the value from before it. */
    flushInputValue();
    if (type !== SettingTypes.Number || range == null) {
      return;
    }
    if (inputValue === '' || inputValue == null || inputValue === '-') {
      return;
    }
    const numeric = Number(inputValue);
    if (Number.isNaN(numeric)) {
      return;
    }
    const clamped = clampSettingRange(numeric, range);
    if (clamped === numeric) {
      return;
    }
    /** Two writes, because one alone is not enough. Going through the debounced
     *  setter supersedes the out-of-range value typing already queued (lodash
     *  debounce keeps only the latest args) but would not land for another
     *  delay, so a Save clicked inside that window would still read the bad
     *  value. Calling setOption directly closes that window; the later trailing
     *  invocation then rewrites the same clamped value. */
    setInputValue(clamped, true);
    setOption?.(settingKey)(clamped);
  };

  /** A model switch can change this field's bounds while a write typed just
   *  before it is still queued. Clamping only what is already committed would
   *  let that queued value land afterwards, past the new ceiling. Re-clamping
   *  through the same debouncer replaces its arguments, so the queued write
   *  becomes the corrected one. */
  const rangeKey = range != null ? `${range.min}:${range.max}:${range.positiveMin ?? ''}` : '';
  /** The panel stays mounted while navigating, so the stored value can be
   *  replaced under an unchanged range. */
  const identityKey = preset?.presetId ?? conversation?.conversationId ?? '';
  /** Null rather than the first pair, so a stored value that the shared range
   *  allowed but the selected model does not is normalized on mount too, not
   *  only once the user switches models or blurs the field. */
  const normalizedRef = useRef<{
    identity: string;
    range: string;
    stored: unknown;
  } | null>(null);
  const storedValue = conversation?.[settingKey];
  useEffect(() => {
    const normalized = normalizedRef.current;
    const identityChanged = normalized == null || normalized.identity !== identityKey;
    const rangeChanged = normalized == null || normalized.range !== rangeKey;
    /** Applying a preset over the open conversation replaces the stored value
     *  without touching either key, and useParameterEffects then pushes it into
     *  this field. The user's own edits reach the conversation through this
     *  same field, so by the time they land the two agree and the value stays
     *  on the blur-clamped path rather than being corrected mid-edit. */
    const replacedExternally =
      normalized != null && normalized.stored !== storedValue && storedValue !== inputValue;
    normalizedRef.current = { identity: identityKey, range: rangeKey, stored: storedValue };
    if (!identityChanged && !rangeChanged && !replacedExternally) {
      return;
    }
    if (type !== SettingTypes.Number || range == null) {
      return;
    }
    /** Only a range the model actually narrowed should rewrite a stored value.
     *  A model that ignores this parameter leaves the shared fallback in place,
     *  and clamping to that would discard a value set for another model. */
    if (range.modelSpecific !== true) {
      return;
    }
    /** A range change is the one trigger where the local value is what matters:
     *  a write typed just before the model switch is still queued in it. The
     *  others are a value arriving from outside this field, which the local one
     *  has not caught up to yet. */
    const candidate = identityChanged || replacedExternally ? storedValue : inputValue;
    if (candidate === '' || candidate == null || candidate === '-') {
      return;
    }
    const numeric = Number(candidate);
    if (Number.isNaN(numeric)) {
      return;
    }
    const clamped = clampSettingRange(numeric, range);
    if (clamped === numeric) {
      return;
    }
    setInputValue(clamped, true);
    setOption?.(settingKey)(clamped);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityKey, rangeKey, storedValue]);

  const placeholderText = placeholderCode
    ? localize(placeholder as TranslationKeys) || placeholder
    : placeholder;

  return (
    <div
      className={`flex flex-col items-center justify-start gap-6 ${
        columnSpan != null ? `col-span-${columnSpan}` : 'col-span-full'
      }`}
    >
      <HoverCard openDelay={300}>
        <HoverCardTrigger className="grid w-full items-center gap-2">
          <div className="flex w-full justify-between">
            <Label
              htmlFor={`${settingKey}-dynamic-input`}
              className="text-left text-xs font-medium"
            >
              {labelCode ? localize(label as TranslationKeys) || label : label || settingKey}{' '}
              {showDefault && (
                <small className="opacity-40 high-contrast:opacity-100">
                  (
                  {typeof defaultValue === 'undefined' || !(defaultValue as string).length
                    ? localize('com_endpoint_default_blank')
                    : `${localize('com_endpoint_default')}: ${defaultValue}`}
                  )
                </small>
              )}
            </Label>
          </div>
          <Input
            id={`${settingKey}-dynamic-input`}
            disabled={readonly}
            inputMode={type === 'number' ? 'numeric' : undefined}
            value={inputValue ?? defaultValue ?? ''}
            onChange={handleInputChange}
            onBlur={handleInputBlur}
            placeholder={placeholderText}
            className={cn(
              'flex h-9 max-h-9 w-full resize-none rounded-lg border border-border-light bg-surface-secondary px-3 py-2',
            )}
          />
        </HoverCardTrigger>
        {description && (
          <OptionHover
            description={
              descriptionCode
                ? localize(description as TranslationKeys) || description
                : description
            }
            side={ESide.Left}
          />
        )}
      </HoverCard>
    </div>
  );
}

export default DynamicInput;

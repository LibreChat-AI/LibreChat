import { useEffect, useId, useMemo, useState } from 'react';
import { BrainCircuit, ChevronDown, X } from 'lucide-react';
import { clampSettingRange, reasoningOverrideSchema } from 'librechat-data-provider';
import {
  Input,
  Button,
  Slider,
  Popover as PopoverRoot,
  PopoverClose,
  PopoverPortal,
  useLocalize,
  PopoverContent,
  PopoverTrigger,
} from '@librechat/client';
import type { SettingDefinition, TReasoningOverride } from 'librechat-data-provider';
import { formatTokens } from '../../../core/usage';

export type ReasoningControlProps = {
  index: number;
  setting: SettingDefinition;
  value?: TReasoningOverride;
  disabled?: boolean;
  onChange: (value: TReasoningOverride) => void;
};

/** Translates a key. Declared as a method so a host's localize, typed with its own narrower key
 *  union, still fits: the keys passed here come from setting definitions, not from that union. */
type Localize = {
  translate(phraseKey: string, options?: Record<string, string | number>): string;
}['translate'];

const translated = (value: string | number | boolean | undefined, localize: Localize) =>
  typeof value === 'string' && value.startsWith('com_') ? localize(value) : String(value ?? '');

/**
 * The composer's reasoning control for a setting the Thinking pill cannot show as levels: a
 * token budget, or an enum without options to grade. A trigger opens a modal popover with a
 * slider (and, for a budget, a number field and an Auto toggle); every committed change is
 * validated as a reasoning override and handed to the host.
 */
function ReasoningControl({
  index,
  setting,
  value,
  disabled = false,
  onChange,
}: ReasoningControlProps): React.JSX.Element {
  const localize = useLocalize();
  const labelId = useId();
  const options = setting.options ?? [];
  const isEnum = setting.type === 'enum' && options.length > 0;
  const label = translated(setting.label ?? setting.key, localize);
  const selectedValue = value?.key === setting.key ? value.value : setting.default;
  const selectedIndex = isEnum ? Math.max(0, options.indexOf(String(selectedValue ?? ''))) : 0;
  let displayValue = String(selectedValue ?? localize('com_ui_auto'));
  if (isEnum) {
    displayValue = translated(
      setting.enumMappings?.[options[selectedIndex]] ?? options[selectedIndex],
      localize,
    );
  } else if (selectedValue === -1) {
    displayValue = localize('com_ui_auto');
  } else if (typeof selectedValue === 'number') {
    displayValue = `${formatTokens(selectedValue)} ${localize('com_ui_tokens')}`;
  }
  const [numericValue, setNumericValue] = useState(String(selectedValue ?? -1));

  useEffect(() => {
    if (!isEnum) {
      setNumericValue(String(selectedValue ?? -1));
    }
  }, [isEnum, selectedValue]);

  const emit = (nextValue: string | number) => {
    const parsed = reasoningOverrideSchema.safeParse({ key: setting.key, value: nextValue });
    if (parsed.success) {
      onChange(parsed.data);
    }
  };

  const range = useMemo(() => setting.range ?? { min: -1, max: 200000, step: 1 }, [setting.range]);
  const numericMin = range.positiveMin ?? Math.max(0, range.min);
  const parsedNumericValue = Number(numericValue);
  const numericScaleValue = Number.isFinite(parsedNumericValue)
    ? Math.min(range.max, Math.max(numericMin, parsedNumericValue))
    : numericMin;
  const isAuto = range.min === -1 && numericValue === '-1';

  const emitNumericValue = (nextValue: number) => {
    setNumericValue(String(nextValue));
    emit(nextValue);
  };

  const commitNumericValue = () => {
    const parsed = numericValue.trim() === '' ? range.min : Number(numericValue);
    const nextValue = clampSettingRange(
      Number.isFinite(parsed) ? Math.round(parsed) : range.min,
      range,
    );
    setNumericValue(String(nextValue));
    if (nextValue !== (selectedValue ?? range.min)) {
      emit(nextValue);
    }
  };

  return (
    <PopoverRoot modal>
      <PopoverTrigger asChild>
        {/* `composer-trigger` keeps it lit while its popover is up, through the
            `aria-expanded` the trigger carries. */}
        <Button
          variant="composer-trigger"
          disabled={disabled}
          aria-label={`${localize('com_ui_composer_thinking')} ${displayValue}`}
        >
          <BrainCircuit className="size-4" aria-hidden="true" />
          <ChevronDown className="size-3" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverPortal>
        <PopoverContent
          data-chat-pane-portal={index}
          role="dialog"
          aria-label={label}
          align="end"
          sideOffset={6}
          className="w-72 max-w-[calc(100vw-2rem)] overflow-hidden"
        >
          <div className="flex items-center gap-2 px-4 py-3">
            <BrainCircuit className="text-text-secondary size-4 shrink-0" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div id={labelId} className="truncate text-sm font-medium">
                {label}
              </div>
              <div className="text-text-secondary truncate text-xs">
                {localize('com_ui_composer_thinking')}
              </div>
            </div>
            <PopoverClose asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={localize('com_ui_close')}
                className="group -me-1 shrink-0"
              >
                <X
                  className="text-text-secondary group-hover:text-text-primary size-4"
                  aria-hidden="true"
                />
              </Button>
            </PopoverClose>
          </div>
          <div className="border-border-light border-t px-4 pt-3 pb-4">
            {isEnum ? (
              <>
                <div className="text-text-primary mb-4 text-sm font-medium">{displayValue}</div>
                <div className="py-1">
                  <Slider
                    aria-labelledby={labelId}
                    aria-valuetext={displayValue}
                    value={[selectedIndex]}
                    min={0}
                    max={options.length - 1}
                    step={1}
                    onValueChange={([nextIndex]) => emit(options[nextIndex])}
                  />
                </div>
                <div className="text-text-secondary mt-2.5 flex justify-between gap-4 text-xs">
                  <span className="truncate">
                    {translated(setting.enumMappings?.[options[0]] ?? options[0], localize)}
                  </span>
                  <span className="truncate text-end">
                    {translated(
                      setting.enumMappings?.[options[options.length - 1]] ??
                        options[options.length - 1],
                      localize,
                    )}
                  </span>
                </div>
              </>
            ) : (
              <>
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <div className="bg-surface-primary h-8 w-24 shrink-0 rounded-lg font-medium shadow-xs">
                      <Input
                        type="number"
                        aria-label={label}
                        value={numericValue === '-1' ? '' : numericValue}
                        placeholder={formatTokens(numericMin)}
                        min={numericMin}
                        max={range.max}
                        step={range.step ?? 1}
                        onChange={(event) => setNumericValue(event.target.value)}
                        onBlur={commitNumericValue}
                        className="h-8 w-24 text-end"
                      />
                    </div>
                    <span className="text-text-secondary truncate text-xs">
                      {localize('com_ui_tokens')}
                    </span>
                  </div>
                  {range.min === -1 && (
                    <Button
                      type="button"
                      variant={isAuto ? 'default' : 'ghost'}
                      size="sm"
                      aria-pressed={isAuto}
                      onClick={() => emitNumericValue(-1)}
                      className="h-8 shrink-0"
                    >
                      <span className="text-xs">{localize('com_ui_auto')}</span>
                    </Button>
                  )}
                </div>
                <div className="py-1">
                  <Slider
                    aria-labelledby={labelId}
                    aria-valuetext={
                      isAuto
                        ? localize('com_ui_auto')
                        : `${formatTokens(numericScaleValue)} ${localize('com_ui_tokens')}`
                    }
                    value={[numericScaleValue]}
                    min={numericMin}
                    max={range.max}
                    step={range.step ?? 1}
                    onValueChange={([nextValue]) => emitNumericValue(nextValue)}
                  />
                </div>
                <div className="text-text-secondary mt-2.5 flex justify-between gap-4 text-xs">
                  <span>{formatTokens(numericMin)}</span>
                  <span>{formatTokens(range.max)}</span>
                </div>
              </>
            )}
          </div>
        </PopoverContent>
      </PopoverPortal>
    </PopoverRoot>
  );
}

export default ReasoningControl;

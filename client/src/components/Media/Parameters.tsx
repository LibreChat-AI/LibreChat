import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  Checkbox,
  ControlCombobox,
  Input,
  Label,
  Textarea,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  labelVariants,
  disclosureChevronVariants,
} from '@librechat/client';
import type { MediaEnumControl, MediaNumberControl } from 'librechat-data-provider';
import type { MediaDraftForm } from './useMediaDraftForm';
import type { MediaFormSelection } from './selection';
import type { EnumKey, NumericKey } from './options';
import { mediaControlLabels } from './labels';
export function MediaParameters({
  form,
  selection,
}: {
  form: MediaDraftForm;
  selection: MediaFormSelection;
}) {
  const [advanced, setAdvanced] = useState(false);
  const {
    id,
    catalog,
    portal,
    localize,
    draft,
    change,
    param,
    controls,
    parameters,
    providerOptionsText,
    invalidSettings,
    optionsInvalid,
  } = form;
  const { capability } = selection;
  const numeric = (key: NumericKey, control?: MediaNumberControl) => {
    if (!control) return null;
    const label = localize(mediaControlLabels[key]);
    const value = parameters[key] ?? draft.parameters[key] ?? '';
    const invalid =
      invalidSettings.includes(key) ||
      (value !== '' &&
        (!Number.isFinite(value) ||
          value < control.min ||
          value > control.max ||
          (control.values != null && !control.values.includes(value))));
    return (
      <div key={key} className="space-y-1">
        <Label variant="section" htmlFor={`${id}-${key}`}>
          {label}
        </Label>
        {control.values ? (
          <ControlCombobox
            showCarat
            selectId={`${id}-${key}`}
            ariaLabel={label}
            ariaInvalid={invalid}
            ariaDescribedBy={invalid ? `${id}-unsupported` : undefined}
            selectedValue={String(value)}
            items={control.values.map((item) => ({ value: String(item), label: String(item) }))}
            setValue={(next) => param(key, Number(next))}
            variant="field"
            isCollapsed={false}
            portal={portal}
          />
        ) : (
          <Input
            id={`${id}-${key}`}
            type="number"
            min={control.min}
            max={control.max}
            step={
              ['strength', 'guidance', 'upscaleFactor', 'creativity', 'durationSeconds'].includes(
                key,
              )
                ? 'any'
                : 1
            }
            value={value}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? `${id}-unsupported` : undefined}
            onChange={(event) =>
              param(key, event.target.value === '' ? undefined : Number(event.target.value))
            }
          />
        )}
      </div>
    );
  };
  const enumeration = (key: EnumKey, control?: MediaEnumControl) => {
    if (!control) return null;
    const label = localize(mediaControlLabels[key]);
    const value = parameters[key] ?? draft.parameters[key] ?? '';
    const invalid =
      invalidSettings.includes(key) ||
      (value ? !control.values.includes(value) : !!control.required);
    return (
      <div key={key} className="space-y-1">
        <Label variant="section" htmlFor={`${id}-${key}`}>
          {label}
        </Label>
        <ControlCombobox
          showCarat
          selectId={`${id}-${key}`}
          ariaLabel={label}
          ariaInvalid={invalid}
          ariaDescribedBy={invalid ? `${id}-unsupported` : undefined}
          selectedValue={value}
          selectPlaceholder={localize('com_media_choose_value')}
          items={control.values.map((value) => ({ value, label: value }))}
          setValue={(value) => {
            if (key === 'format') {
              if (value === 'png' || value === 'jpeg' || value === 'webp' || value === 'svg')
                param(key, value);
            } else if (key === 'background') {
              if (value === 'auto' || value === 'opaque' || value === 'transparent')
                param(key, value);
            } else param(key, value);
          }}
          variant="field"
          isCollapsed={false}
          portal={portal}
        />
      </div>
    );
  };
  return (
    <>
      <div className="border-border-light grid grid-cols-2 gap-3 border-t pt-4">
        {numeric('count', controls.count)}
        {controls.quality?.required && enumeration('quality', controls.quality)}
        {enumeration('aspectRatio', controls.aspectRatio)}
        {capability.operation === 'video.generate' ? (
          <>
            {numeric('durationSeconds', capability.controls.durationSeconds)}
            {enumeration('resolution', capability.controls.resolution)}
            {enumeration('size', capability.controls.size)}
            {numeric('upscaleFactor', capability.controls.upscaleFactor)}
          </>
        ) : (
          <>
            {enumeration('size', capability.controls.size)}
            {enumeration('resolution', capability.controls.resolution)}
          </>
        )}
      </div>
      <div className="border-border-light border-t pt-3">
        <Collapsible open={advanced} onOpenChange={setAdvanced}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="group/disclosure flex w-full items-center justify-between gap-2 py-1"
            >
              <span className={labelVariants({ variant: 'section' })}>
                {localize('com_media_advanced')}
              </span>
              <ChevronDown
                className={`size-4 ${disclosureChevronVariants({ expanded: advanced })}`}
                aria-hidden="true"
              />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3">
            <div className="grid grid-cols-2 gap-3">
              {numeric('seed', controls.seed)}
              {numeric('outputCompression', controls.outputCompression)}
              {numeric('strength', controls.strength)}
              {numeric('guidance', controls.guidance)}
              {numeric('creativity', controls.creativity)}
              {capability.operation === 'video.generate' ? (
                capability.controls.audio && (
                  <div className="col-span-2 flex items-center gap-2">
                    <Checkbox
                      id={`${id}-audio`}
                      aria-label={localize(mediaControlLabels.audio)}
                      checked={parameters.audio ?? false}
                      onCheckedChange={(checked) => param('audio', checked === true)}
                    />
                    <Label variant="section" htmlFor={`${id}-audio`}>
                      {localize(mediaControlLabels.audio)}
                    </Label>
                  </div>
                )
              ) : (
                <>
                  {!capability.controls.quality?.required &&
                    enumeration('quality', capability.controls.quality)}
                  {enumeration('format', capability.controls.format)}
                  {enumeration('background', capability.controls.background)}
                </>
              )}
              {controls.negativePrompt && (
                <div className="col-span-2 space-y-1.5">
                  <Label variant="section" htmlFor={`${id}-negative-prompt`}>
                    {localize('com_media_negative_prompt')}
                  </Label>
                  <Textarea
                    id={`${id}-negative-prompt`}
                    value={draft.parameters.negativePrompt ?? ''}
                    maxLength={catalog.limits.maxPromptChars}
                    onChange={(event) => param('negativePrompt', event.target.value)}
                    rows={2}
                  />
                </div>
              )}
              {(controls.providerOptions?.length || providerOptionsText) && (
                <div className="col-span-2 space-y-1.5">
                  <Label variant="section" htmlFor={`${id}-provider-options`}>
                    {localize('com_media_provider_options')}
                  </Label>
                  <p
                    id={`${id}-provider-options-hint`}
                    className="text-text-secondary text-xs leading-5"
                  >
                    {localize('com_media_provider_options_hint', {
                      names: controls.providerOptions?.join(', ') ?? '',
                    })}
                  </p>
                  <Textarea
                    id={`${id}-provider-options`}
                    value={providerOptionsText}
                    onChange={(event) => change({ providerOptionsText: event.target.value })}
                    rows={4}
                    spellCheck={false}
                    aria-invalid={optionsInvalid || undefined}
                    aria-describedby={`${id}-provider-options-hint${optionsInvalid ? ` ${id}-provider-options-error` : ''}`}
                  />
                </div>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </>
  );
}

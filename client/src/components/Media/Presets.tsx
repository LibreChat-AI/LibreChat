import { useId, useRef, useState } from 'react';
import { BookCopy, Star, StarOff, Trash } from 'lucide-react';
import {
  Button,
  Checkbox,
  Chip,
  ControlCombobox,
  Input,
  Label,
  Spinner,
  OGDialog,
  OGDialogContent,
  OGDialogTitle,
  OGDialogDescription,
  TooltipAnchor,
} from '@librechat/client';
import type { MediaCatalog, MediaPreset, MediaPresetSettings } from 'librechat-data-provider';
import type { UseQueryResult } from '@tanstack/react-query';
import { useMediaPresetMutations } from '~/data-provider';
import { mediaOperationLabels } from './labels';
import { useLocalize } from '~/hooks';
import { useMediaHost } from './host';

export function MediaPresets({
  catalog,
  presets,
  current,
  activePresetId,
  portal,
  onApply,
}: {
  catalog: MediaCatalog;
  presets: UseQueryResult<MediaPreset[]>;
  /** The settings a new preset captures; absent while no model is selected. */
  current?: MediaPresetSettings;
  /** The preset the current settings still match, so the field can name it. */
  activePresetId?: string;
  portal: boolean;
  /** Restores a complete preset; false when its model or references are unavailable. */
  onApply: (preset: MediaPreset) => boolean;
}) {
  const host = useMediaHost();
  const localize = useLocalize();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [asDefault, setAsDefault] = useState(false);
  const [confirming, setConfirming] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [fieldNotice, setFieldNotice] = useState<string>();
  const { create, update, remove } = useMediaPresetMutations(host);
  const busy = create.isLoading || update.isLoading || remove.isLoading;
  const items = presets.data ?? [];
  const active = items.find((preset) => preset.presetId === activePresetId);
  const hasHostedInputs = current?.inputs?.some((input) => !!input.sourceURL) ?? false;
  const modelName = (settings: MediaPresetSettings) =>
    catalog.offerings.find(
      (item) => item.connectionId === settings.connectionId && item.modelId === settings.modelId,
    )?.modelName ?? settings.modelId;
  const describe = (preset: MediaPreset) =>
    [
      modelName(preset.settings),
      localize(mediaOperationLabels[preset.settings.operation]),
      ...(preset.settings.inputs?.length
        ? [localize('com_media_preset_references', { count: preset.settings.inputs.length })]
        : []),
      ...(preset.isDefault ? [localize('com_ui_default')] : []),
    ].join(' · ');
  const close = (next: boolean) => {
    setOpen(next);
    if (next) return;
    setConfirming(undefined);
    setNotice(undefined);
  };
  const save = async () => {
    if (!current || !title.trim() || hasHostedInputs) return;
    setNotice(undefined);
    try {
      await create.mutateAsync({ title: title.trim(), isDefault: asDefault, settings: current });
      if (!host.isCurrentSession()) return;
      setTitle('');
      setAsDefault(false);
      setNotice(localize('com_media_preset_saved'));
    } catch {
      if (host.isCurrentSession()) setNotice(localize('com_media_preset_error'));
    }
  };
  const apply = (preset: MediaPreset) => {
    if (onApply(preset)) {
      close(false);
      return;
    }
    setNotice(localize('com_media_preset_unavailable'));
  };
  const mutate = async (action: () => Promise<unknown>) => {
    setNotice(undefined);
    try {
      await action();
      return host.isCurrentSession();
    } catch {
      if (host.isCurrentSession()) setNotice(localize('com_media_preset_error'));
      return false;
    }
  };
  let displayValue: string | undefined;
  if (active) displayValue = active.title;
  else if (items.length > 0) displayValue = localize('com_ui_custom');
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <Label variant="section" htmlFor={`${id}-preset`} className="min-w-0 truncate">
          {localize('com_media_presets')}
        </Label>
        <Button
          ref={trigger}
          variant="section-action"
          size="xs"
          className="-mr-2 shrink-0"
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          <BookCopy className="size-3.5" aria-hidden="true" />
          {localize('com_ui_manage')}
        </Button>
      </div>
      <ControlCombobox
        showCarat
        selectId={`${id}-preset`}
        ariaLabel={localize('com_media_presets')}
        variant="field"
        isCollapsed={false}
        portal={portal}
        disabled={items.length === 0}
        selectedValue={active?.presetId ?? ''}
        displayValue={displayValue}
        selectPlaceholder={localize(
          items.length > 0 ? 'com_media_preset_choose' : 'com_media_presets_none',
        )}
        items={items.map((preset) => ({
          value: preset.presetId,
          label: preset.title,
          description: describe(preset),
        }))}
        setValue={(value) => {
          const preset = items.find((item) => item.presetId === value);
          if (!preset) return;
          setFieldNotice(onApply(preset) ? undefined : localize('com_media_preset_unavailable'));
        }}
      />
      {fieldNotice && (
        <p role="status" className="text-text-secondary text-xs">
          {fieldNotice}
        </p>
      )}
      <OGDialog open={open} onOpenChange={close} triggerRef={trigger}>
        <OGDialogContent
          className="max-h-[85dvh] w-11/12 max-w-lg overflow-y-auto"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
        >
          <OGDialogTitle>{localize('com_media_presets')}</OGDialogTitle>
          <OGDialogDescription>{localize('com_media_presets_description')}</OGDialogDescription>
          {current && host.canCreate && (
            <form
              noValidate
              className="border-border-light space-y-3 rounded-xl border p-3"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <div className="space-y-1">
                <Label variant="section" htmlFor={`${id}-title`}>
                  {localize('com_media_preset_name')}
                </Label>
                <Input
                  id={`${id}-title`}
                  value={title}
                  maxLength={catalog.limits.maxTitleChars}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </div>
              <p className="text-text-secondary text-xs">
                {modelName(current)} · {localize(mediaOperationLabels[current.operation])}
              </p>
              {!!current.inputs?.length && (
                <p className="text-text-secondary text-xs">
                  {localize('com_media_preset_references', { count: current.inputs.length })}
                </p>
              )}
              {hasHostedInputs && (
                <p role="status" className="text-text-secondary text-sm">
                  {localize('com_media_preset_hosted_inputs')}
                </p>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`${id}-default`}
                    aria-labelledby={`${id}-default-label`}
                    checked={asDefault}
                    onCheckedChange={(checked) => setAsDefault(checked === true)}
                  />
                  <Label id={`${id}-default-label`} htmlFor={`${id}-default`}>
                    {localize('com_media_preset_default')}
                  </Label>
                </div>
                <Button type="submit" size="sm" disabled={busy || !title.trim() || hasHostedInputs}>
                  {create.isLoading && <Spinner className="size-4" />}
                  {localize('com_media_preset_save')}
                </Button>
              </div>
            </form>
          )}
          {notice && (
            <p role="status" className="text-text-secondary text-sm">
              {notice}
            </p>
          )}
          {presets.isLoading && (
            <p role="status" className="text-text-secondary flex items-center gap-2 text-sm">
              <Spinner className="size-4" />
              {localize('com_media_loading')}
            </p>
          )}
          {presets.isError && (
            <div role="alert" className="flex items-center gap-3 text-sm">
              <span>{localize('com_media_load_failed')}</span>
              <Button variant="outline" size="sm" onClick={() => void presets.refetch()}>
                {localize('com_ui_retry')}
              </Button>
            </div>
          )}
          {presets.isSuccess && items.length === 0 && (
            <p className="text-text-secondary text-sm">{localize('com_media_presets_empty')}</p>
          )}
          {items.length > 0 && (
            <ul className="divide-border-light divide-y" aria-label={localize('com_media_presets')}>
              {items.map((preset) => (
                <li key={preset.presetId} className="flex flex-wrap items-center gap-2 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      <span className="truncate">{preset.title}</span>
                      {preset.isDefault && <Chip>{localize('com_ui_default')}</Chip>}
                    </p>
                    <p className="text-text-secondary truncate text-xs">{describe(preset)}</p>
                  </div>
                  {confirming === preset.presetId ? (
                    <span className="flex items-center gap-1">
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={busy}
                        onClick={async () => {
                          if (await mutate(() => remove.mutateAsync(preset.presetId)))
                            setConfirming(undefined);
                        }}
                      >
                        {localize('com_ui_delete')}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setConfirming(undefined)}>
                        {localize('com_ui_cancel')}
                      </Button>
                    </span>
                  ) : (
                    <span className="flex items-center gap-0.5">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={() => apply(preset)}
                      >
                        {localize('com_media_preset_apply')}
                      </Button>
                      {host.canCreate && (
                        <>
                          <TooltipAnchor
                            description={localize(
                              preset.isDefault
                                ? 'com_media_preset_unset_default'
                                : 'com_media_preset_set_default',
                            )}
                            render={
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                disabled={busy}
                                aria-pressed={preset.isDefault}
                                aria-label={localize(
                                  preset.isDefault
                                    ? 'com_media_preset_unset_default'
                                    : 'com_media_preset_set_default',
                                )}
                                onClick={() =>
                                  void mutate(() =>
                                    update.mutateAsync({
                                      presetId: preset.presetId,
                                      update: { isDefault: !preset.isDefault },
                                    }),
                                  )
                                }
                              >
                                {preset.isDefault ? (
                                  <StarOff className="size-4" aria-hidden="true" />
                                ) : (
                                  <Star className="size-4" aria-hidden="true" />
                                )}
                              </Button>
                            }
                          />
                          <TooltipAnchor
                            description={localize('com_media_preset_delete')}
                            render={
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                disabled={busy}
                                aria-label={localize('com_media_preset_delete')}
                                onClick={() => setConfirming(preset.presetId)}
                              >
                                <Trash className="size-4" aria-hidden="true" />
                              </Button>
                            }
                          />
                        </>
                      )}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </OGDialogContent>
      </OGDialog>
    </div>
  );
}

import { useRef } from 'react';
import { Film, ImagePlus, Pencil, Plus, X } from 'lucide-react';
import { Button, ControlCombobox, Label, Radio, TooltipAnchor } from '@librechat/client';
import type { MediaCatalog, MediaOffering } from 'librechat-data-provider';
import type { MediaDraftForm } from './useMediaDraftForm';
import type { MediaFormSelection } from './selection';
import { MediaParameters } from './Parameters';
import { useMediaCredentials } from './Keys';
import { mediaErrorLabels } from './labels';
import { MediaPresets } from './Presets';
import { offeringId } from './options';
export function MediaSettings({
  form,
  selection,
}: {
  form: MediaDraftForm;
  selection: MediaFormSelection | undefined;
}) {
  const {
    id,
    catalog,
    portal,
    features,
    presets,
    localize,
    offerings,
    providerTag,
    selectedRoute,
    staleRoute,
    draft,
    change,
    applyPreset,
  } = form;
  const unavailableProvider = (reason: MediaOffering['unavailableReason']) =>
    reason === 'not_ready'
      ? localize('com_media_provider_configuration_required')
      : localize(mediaErrorLabels[reason ?? 'unsupported']);
  const connectionTrigger = useRef<HTMLButtonElement>(null);
  const credentials = useMediaCredentials(catalog, `${id}-connection`);
  const providerRequiresKey = (connectionId: string, reason: MediaOffering['unavailableReason']) =>
    (reason === 'credentials_required' ||
      reason === 'credentials_expired' ||
      reason === 'gemini_key_required') &&
    credentials.canConfigure(connectionId);
  const providerAction = (connectionId: string) => {
    const action = credentials.action(connectionId);
    if (!action) return;
    const integration = catalog.integrations?.find((item) => item.connectionId === connectionId);
    return {
      ...action,
      activateOnSelect: providerRequiresKey(connectionId, integration?.unavailableReason),
    };
  };
  if (!selection) {
    const integrations: NonNullable<MediaCatalog['integrations']> = [
      ...catalog.offerings,
      ...(catalog.integrations ?? []),
    ];
    const message = localize(
      offerings.length > 0 ? 'com_media_selection_unavailable' : 'com_media_no_models',
    );
    const hasDraft = !!draft.offering || !!draft.prompt || draft.inputs.length > 0;
    return (
      <div className="space-y-3">
        {credentials.dialog}
        {!hasDraft && <p role="status">{message}</p>}
        <Label htmlFor={`${id}-connection`}>{localize('com_media_connection')}</Label>
        <ControlCombobox
          ref={connectionTrigger}
          ariaLabel={localize('com_media_connection')}
          selectId={`${id}-connection`}
          optionAction={providerAction}
          selectedValue=""
          selectPlaceholder={localize('com_media_choose_model')}
          isCollapsed={false}
          variant="field"
          portal={portal}
          items={[...new Map(integrations.map((item) => [item.connectionId, item])).values()].map(
            (item) => ({
              value: item.connectionId,
              label: item.connectionName,
              description: item.available ? undefined : unavailableProvider(item.unavailableReason),
              disabled:
                !offerings.some((candidate) => candidate.connectionId === item.connectionId) &&
                !providerRequiresKey(item.connectionId, item.unavailableReason),
            }),
          )}
          setValue={(value) => {
            const next =
              offerings.find(
                (item) =>
                  item.connectionId === value &&
                  item.capabilities.some((cap) => cap.operation === draft.operation),
              ) ?? offerings.find((item) => item.connectionId === value);
            if (!next) return;
            const cap =
              next.capabilities.find((item) => item.operation === draft.operation) ??
              next.capabilities[0];
            change({
              offering: offeringId(next),
              operation: cap.operation,
              providerTag: next.defaultProviderTag,
              providerOptionsText: undefined,
              parameters: { count: cap.controls.count?.default ?? cap.controls.count?.min ?? 1 },
            });
          }}
        />
        {draft.offering && offerings.length > 0 && (
          <Button variant="outline" onClick={() => connectionTrigger.current?.click()}>
            {localize('com_media_choose_model')}
          </Button>
        )}
      </div>
    );
  }
  const {
    offering,
    operations,
    activeOperation,
    modeOfferings,
    availableForMode,
    connections,
    selectOffering,
    compareCandidates,
    compareOffering,
    compareInvalid,
    currentSettings,
    activePresetId,
    chooseOperation,
  } = selection;
  const icons = { 'image.generate': ImagePlus, 'image.edit': Pencil, 'video.generate': Film };
  const operationLabels = {
    'image.generate': 'com_media_image',
    'image.edit': 'com_ui_edit',
    'video.generate': 'com_media_video',
  } as const;
  return (
    <section className="space-y-4" aria-label={localize('com_media_settings')}>
      {credentials.dialog}
      {features.presets && (
        <MediaPresets
          catalog={catalog}
          presets={presets}
          current={currentSettings}
          activePresetId={activePresetId}
          portal={portal}
          onApply={applyPreset}
        />
      )}
      <div className="space-y-1">
        <Label variant="section" id={`${id}-operation`}>
          {localize('com_media_operation')}
        </Label>
        <Radio
          fullWidth
          aria-labelledby={`${id}-operation`}
          value={activeOperation}
          onChange={chooseOperation}
          options={operations.map((operation) => {
            const Icon = icons[operation];
            return {
              value: operation,
              label: localize(operationLabels[operation]),
              icon: <Icon className="size-4" aria-hidden="true" />,
            };
          })}
        />
      </div>
      <div className="space-y-3">
        <div className="space-y-1">
          <Label variant="section" htmlFor={`${id}-connection`}>
            {localize('com_media_connection')}
          </Label>
          <ControlCombobox
            showCarat
            selectId={`${id}-connection`}
            optionAction={providerAction}
            ariaLabel={localize('com_media_connection')}
            variant="field"
            isCollapsed={false}
            portal={portal}
            selectedValue={offering.connectionId}
            displayValue={offering.connectionName}
            items={[...connections.values()].map(({ value, label, unavailableReason }) => {
              const unavailable = !modeOfferings.some(
                (item) => item.connectionId === value && availableForMode(item),
              );
              return {
                value,
                label,
                description: unavailable ? unavailableProvider(unavailableReason) : undefined,
                disabled: unavailable && !providerRequiresKey(value, unavailableReason),
              };
            })}
            setValue={(value) => {
              const next = modeOfferings.find(
                (item) => item.connectionId === value && availableForMode(item),
              );
              if (next) selectOffering(next, activeOperation);
            }}
          />
        </div>
        <div className="space-y-1">
          <Label variant="section" htmlFor={`${id}-model`}>
            {localize('com_ui_model')}
          </Label>
          <ControlCombobox
            showCarat
            selectId={`${id}-model`}
            ariaLabel={localize('com_ui_model')}
            variant="field"
            isCollapsed={false}
            portal={portal}
            selectedValue={offeringId(offering)}
            displayValue={offering.modelName}
            items={modeOfferings
              .filter((item) => item.connectionId === offering.connectionId)
              .map((item) => ({
                value: offeringId(item),
                label: item.modelName,
                description: availableForMode(item)
                  ? undefined
                  : localize(mediaErrorLabels[item.unavailableReason ?? 'unsupported']),
                disabled: !availableForMode(item),
              }))}
            setValue={(value) => {
              const next = modeOfferings.find((item) => offeringId(item) === value);
              if (next && availableForMode(next)) selectOffering(next, activeOperation);
            }}
          />
        </div>
        {offering.api === 'openrouter.images' && (offering.routes?.length || staleRoute) && (
          <div className="space-y-1">
            <Label variant="section" htmlFor={`${id}-route`}>
              {localize('com_media_provider_route')}
            </Label>
            <ControlCombobox
              showCarat
              selectId={`${id}-route`}
              ariaLabel={localize('com_media_provider_route')}
              ariaInvalid={staleRoute}
              ariaDescribedBy={staleRoute ? `${id}-stale-route` : undefined}
              variant="field"
              isCollapsed={false}
              portal={portal}
              selectedValue={providerTag ?? ''}
              displayValue={selectedRoute?.providerName ?? providerTag}
              items={(offering.routes ?? []).map((route) => ({
                value: route.providerTag,
                label: route.providerName,
                disabled: !route.capabilities.some((cap) => cap.operation === activeOperation),
              }))}
              setValue={(value) => {
                const route = offering.routes?.find((item) => item.providerTag === value);
                const cap = route?.capabilities.find((item) => item.operation === activeOperation);
                if (cap)
                  change({
                    providerTag: value,
                    providerOptionsText: undefined,
                    parameters: {
                      count: cap.controls.count?.default ?? cap.controls.count?.min ?? 1,
                    },
                  });
              }}
            />
          </div>
        )}
      </div>
      {features.compare && (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <Label variant="section" htmlFor={`${id}-compare`} className="min-w-0 truncate">
              {localize('com_media_compare')}
            </Label>
            {draft.compare ? (
              <TooltipAnchor
                description={localize('com_media_compare_remove')}
                render={
                  <Button
                    variant="section-action"
                    size="icon-xs"
                    className="-mr-1.5"
                    aria-label={localize('com_media_compare_remove')}
                    onClick={() => change({ compare: undefined })}
                  >
                    <X className="size-3.5" aria-hidden="true" />
                  </Button>
                }
              />
            ) : (
              <Button
                variant="section-action"
                size="xs"
                className="-mr-2 shrink-0"
                disabled={compareCandidates.length === 0}
                onClick={() => {
                  const next = compareCandidates[0];
                  if (next)
                    change({
                      compare: { offering: offeringId(next), providerTag: next.defaultProviderTag },
                    });
                }}
              >
                <Plus className="size-3.5" aria-hidden="true" />
                {localize('com_media_compare_add')}
              </Button>
            )}
          </div>
          {draft.compare && (
            <>
              <ControlCombobox
                showCarat
                selectId={`${id}-compare`}
                ariaLabel={localize('com_media_compare_model')}
                ariaInvalid={compareInvalid}
                variant="field"
                isCollapsed={false}
                portal={portal}
                selectedValue={draft.compare.offering}
                displayValue={compareOffering?.modelName}
                selectPlaceholder={localize('com_media_choose_model')}
                items={compareCandidates.map((item) => ({
                  value: offeringId(item),
                  label: item.modelName,
                  description: item.connectionName,
                }))}
                setValue={(value) => {
                  const next = compareCandidates.find((item) => offeringId(item) === value);
                  if (next)
                    change({ compare: { offering: value, providerTag: next.defaultProviderTag } });
                }}
              />
              <p
                role={compareInvalid ? 'status' : undefined}
                className="text-text-secondary text-xs leading-5"
              >
                {localize(
                  compareInvalid ? 'com_media_compare_unsupported' : 'com_media_compare_hint',
                )}
              </p>
            </>
          )}
        </div>
      )}
      <MediaParameters form={form} selection={selection} />
    </section>
  );
}

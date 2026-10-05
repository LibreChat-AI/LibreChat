import { resolveMediaParameters, validateMediaCapability } from 'librechat-data-provider';
import type { MediaOffering, MediaOperation, MediaPresetSettings } from 'librechat-data-provider';
import type { MediaDraftForm } from './useMediaDraftForm';
import type { MediaDraft } from './state';
import {
  comparisonParameters,
  offeringId,
  sameInputs,
  sameParameters,
  supportsMode,
} from './options';
export function getMediaSelection(form: MediaDraftForm) {
  const {
    catalog,
    features,
    presets,
    savedDraft,
    offerings,
    offering,
    providerTag,
    capabilities,
    draft,
    capability,
    hostedRoles,
    change,
    parameters,
    validation,
    validationInputs,
  } = form;
  if (!offering || !capability) return;
  const operations = (['image.generate', 'image.edit', 'video.generate'] as const).filter(
    (operation) =>
      offerings.some((item) => item.capabilities.some((cap) => cap.operation === operation)),
  );
  const activeOperation = draft.operation === 'image.edit' ? draft.operation : capability.operation;
  const modeOfferings = catalog.offerings.filter((item) => supportsMode(item, activeOperation));
  const availableForMode = (item: MediaOffering) =>
    item.available && item.capabilities.some((cap) => cap.operation === activeOperation);
  const connections = new Map(
    modeOfferings.map((item) => [
      item.connectionId,
      {
        value: item.connectionId,
        label: item.connectionName,
        unavailableReason: item.unavailableReason,
      },
    ]),
  );
  for (const integration of catalog.integrations ?? []) {
    if (integration.api.endsWith('.videos') !== (activeOperation === 'video.generate')) continue;
    connections.set(integration.connectionId, {
      value: integration.connectionId,
      label: integration.connectionName,
      unavailableReason: integration.unavailableReason,
    });
  }
  const selectOffering = (next: typeof offering, operation: MediaOperation, switchMode = false) => {
    const preferredProvider =
      offeringId(next) === offeringId(offering) ? providerTag : next.defaultProviderTag;
    const route =
      next.routes?.find(
        (item) =>
          item.providerTag === preferredProvider &&
          item.capabilities.some((cap) => cap.operation === operation),
      ) ??
      next.routes?.find((item) => item.capabilities.some((cap) => cap.operation === operation));
    const cap = (route?.capabilities ?? next.capabilities).find(
      (item) => item.operation === operation,
    );
    if (!cap) return;
    const update: Partial<MediaDraft> = {
      offering: offeringId(next),
      providerTag: route?.providerTag ?? next.defaultProviderTag,
      providerOptionsText: undefined,
      operation,
      parameters: { count: cap.controls.count?.default ?? cap.controls.count?.min ?? 1 },
    };
    if (switchMode && activeOperation === 'video.generate' && operation !== activeOperation) {
      update.videoAutoEdit = savedDraft.autoEdit !== false;
    }
    if (switchMode && operation === 'image.generate') {
      update.autoEdit = false;
      update.parentTurnId = undefined;
      update.inputs = [];
      update.assets = [];
    } else if (
      switchMode &&
      (operation === 'image.edit' ||
        (operation === 'video.generate' && activeOperation !== 'video.generate')) &&
      !savedDraft.inputs.length &&
      !savedDraft.parentTurnId
    ) {
      update.autoEdit = operation === 'video.generate' ? (savedDraft.videoAutoEdit ?? true) : true;
    }
    change(update);
  };
  const inputsValid = !validation.some((issue) => issue.field === 'inputs');
  const compareCandidates = features.compare
    ? modeOfferings.filter(
        (item) => availableForMode(item) && offeringId(item) !== offeringId(offering),
      )
    : [];
  const compareOffering = draft.compare
    ? compareCandidates.find((item) => offeringId(item) === draft.compare?.offering)
    : undefined;
  const compareRoute = compareOffering?.routes?.find(
    (route) =>
      route.providerTag === (draft.compare?.providerTag ?? compareOffering.defaultProviderTag),
  );
  const compareCapability = (compareRoute?.capabilities ?? compareOffering?.capabilities)?.find(
    (item) => item.operation === activeOperation,
  );
  const compareInputsValid =
    !!compareCapability &&
    (!(draft.compare?.providerTag ?? compareOffering?.defaultProviderTag) || !!compareRoute) &&
    validateMediaCapability(
      {
        operation: compareCapability.operation,
        inputs: validationInputs,
        prompt: draft.prompt,
        parameters: comparisonParameters(compareCapability, parameters.count, draft.inputs),
      },
      compareCapability,
      catalog.limits,
    ).length === 0;
  const compareInvalid = features.compare && !!draft.compare && !compareInputsValid;
  const currentSettings: MediaPresetSettings = {
    operation: activeOperation,
    connectionId: offering.connectionId,
    modelId: offering.modelId,
    providerTag,
    parameters,
    inputs: draft.inputs.map(({ file_id, role, sourceURL }) => ({ file_id, role, sourceURL })),
  };
  const activePresetId = presets.data?.find(
    (preset) =>
      preset.settings.operation === activeOperation &&
      preset.settings.connectionId === offering.connectionId &&
      preset.settings.modelId === offering.modelId &&
      (preset.settings.providerTag ?? undefined) === (providerTag ?? undefined) &&
      sameInputs(preset.settings.inputs ?? [], draft.inputs) &&
      sameParameters(
        resolveMediaParameters(
          { ...preset.settings, inputs: preset.settings.inputs ?? [] },
          capability,
          {
            optionalChoices: true,
          },
        ),
        parameters,
      ),
  )?.presetId;
  const uploadLimit = Math.min(
    catalog.limits.maxInputs,
    Math.max(
      capability.inputs.max,
      capabilities?.find((item) => item.operation === 'image.edit')?.inputs.max ?? 0,
    ),
  );
  const imageRoles =
    capabilities?.find((item) => item.operation === 'image.edit')?.inputs.roles ?? [];
  const localAccept = [
    [...capability.inputs.roles, ...imageRoles].some((role) =>
      ['reference', 'start_frame', 'end_frame'].includes(role),
    )
      ? 'image/*'
      : '',
    capability.inputs.roles.includes('video') && !hostedRoles.includes('video') ? 'video/*' : '',
    capability.inputs.roles.includes('audio') && !hostedRoles.includes('audio') ? 'audio/*' : '',
  ]
    .filter(Boolean)
    .join(',');
  const chooseOperation = (value: string) => {
    const operation = operations.find((item) => item === value);
    if (!operation) return;
    const next = offering.capabilities.some((cap) => cap.operation === operation)
      ? offering
      : offerings.find((item) => item.capabilities.some((cap) => cap.operation === operation));
    if (next) selectOffering(next, operation, true);
  };
  return {
    offering,
    capability,
    operations,
    activeOperation,
    modeOfferings,
    availableForMode,
    connections,
    selectOffering,
    inputsValid,
    compareCandidates,
    compareOffering,
    compareRoute,
    compareCapability,
    compareInvalid,
    currentSettings,
    activePresetId,
    uploadLimit,
    localAccept,
    chooseOperation,
  };
}
export type MediaFormSelection = NonNullable<ReturnType<typeof getMediaSelection>>;

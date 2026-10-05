import { useEffect, useRef } from 'react';
import { useAtom } from 'jotai';
import { mediaURLUploadRequestSchema, validateMediaCapability } from 'librechat-data-provider';
import type { MediaCatalog, MediaPreset, MediaSelection } from 'librechat-data-provider';
import type { MediaEditTarget } from './context';
import type { FormControls } from './options';
import type { MediaDraft } from './state';
import { withMediaContext, mediaParameterContext, mediaContextParameters } from './context';
import { offeringId, readProviderOptions, mediaInputsWithMetadata } from './options';
import { mediaFeatures, useMediaHost } from './host';
import { useMediaPresets } from '~/data-provider';
import { mediaDraftFamily } from './state';
import { useLocalize } from '~/hooks';
export type MediaDraftFormProps = {
  catalog: MediaCatalog;
  threadId?: string;
  initialSelection?: MediaSelection;
  imageContext?: MediaEditTarget;
  videoContext?: MediaEditTarget;
  videoContextUnavailable?: boolean;
  portal?: boolean;
  normalizeDraft?: boolean;
};
export function useMediaDraftForm({
  catalog,
  threadId,
  initialSelection,
  imageContext,
  videoContext,
  videoContextUnavailable = false,
  portal = false,
  normalizeDraft = true,
}: MediaDraftFormProps) {
  const id = `media-form-${threadId ?? 'new'}`;
  const host = useMediaHost();
  const features = mediaFeatures(host);
  const presets = useMediaPresets(host, features.presets);
  const localize = useLocalize();
  const draftKey = `${host.scope}:${threadId ?? 'new'}`;
  const [savedDraft, setDraft] = useAtom(mediaDraftFamily(draftKey));
  const offerings = catalog.offerings.filter(
    (offering) => offering.available && offering.capabilities.length > 0,
  );
  const initialOffering = offerings.find(
    (item) =>
      item.connectionId === initialSelection?.connectionId &&
      item.modelId === initialSelection.modelId,
  );
  const implicitDefault =
    !!initialOffering &&
    savedDraft.revision === 1 &&
    !savedDraft.prompt &&
    savedDraft.inputs.length === 0 &&
    !savedDraft.parentTurnId;
  const offering =
    savedDraft.offering && !implicitDefault
      ? offerings.find((item) => offeringId(item) === savedDraft.offering)
      : (initialOffering ?? offerings[0]);
  const providerTag =
    (implicitDefault || !savedDraft.offering
      ? initialSelection?.providerTag
      : savedDraft.providerTag) ?? offering?.defaultProviderTag;
  const selectedRoute = offering?.routes?.find((route) => route.providerTag === providerTag);
  const staleRoute = !!providerTag && !selectedRoute;
  const capabilities = selectedRoute?.capabilities ?? offering?.capabilities;
  const selectedCapability =
    capabilities?.find((item) => item.operation === savedDraft.operation) ?? capabilities?.[0];
  const draft = withMediaContext(
    savedDraft,
    { image: imageContext, video: videoContext },
    selectedCapability?.operation,
  );
  const automaticReference = draft !== savedDraft;
  const capability =
    capabilities?.find((item) => item.operation === draft.operation) ?? selectedCapability;
  /** Uploads switch between image operations themselves, so only the media kind owns them. */
  const referenceOwner = JSON.stringify([
    draftKey,
    offering?.connectionId,
    offering?.modelId,
    providerTag,
    capability?.operation.split('.')[0],
  ]);
  const hostedRoles = capability?.inputs.hostedRoles ?? [];
  const referenceURLRole =
    draft.referenceURLRole && hostedRoles.includes(draft.referenceURLRole)
      ? draft.referenceURLRole
      : (capability?.inputs.requiredRoles?.find(
          (role): role is 'video' | 'audio' =>
            (role === 'video' || role === 'audio') && hostedRoles.includes(role),
        ) ?? hostedRoles[0]);
  const referenceURL = mediaURLUploadRequestSchema.safeParse({
    url: draft.referenceURL?.trim() ?? '',
    role: referenceURLRole,
  });
  const unsupportedContext =
    (draft.operation === 'image.edit' && capability?.operation !== 'image.edit') ||
    (automaticReference &&
      draft.operation === 'video.generate' &&
      !capability?.inputs.roles.includes('video'));
  const unavailableContext =
    videoContextUnavailable &&
    selectedCapability?.operation === 'video.generate' &&
    draft.autoEdit !== false &&
    !draft.inputs.length &&
    !draft.parentTurnId;
  const presetsPending = features.presets && presets.isLoading && presets.fetchStatus !== 'idle';
  useEffect(() => {
    if (!normalizeDraft || !offering || !capability || presetsPending) return;
    if (draft.offering && (!implicitDefault || draft.offering === offeringId(offering))) return;
    setDraft((previous) =>
      previous.offering && !(implicitDefault && previous.revision === 1)
        ? previous
        : {
            ...previous,
            offering: offeringId(offering),
            providerTag,
            operation: capability.operation,
            parameters: {
              count: capability.controls.count?.default ?? capability.controls.count?.min ?? 1,
            },
            revision: previous.revision + 1,
          },
    );
  }, [
    draft.offering,
    implicitDefault,
    offering,
    capability,
    providerTag,
    setDraft,
    presetsPending,
    normalizeDraft,
  ]);
  const change = (update: Partial<MediaDraft>) =>
    setDraft((previous) => ({
      ...previous,
      ...update,
      ...(update.parameters && !update.parameterContexts
        ? {
            parameterContexts: Object.fromEntries(
              Object.keys(update.parameters).map((key) => [
                key,
                mediaParameterContext({
                  operation: update.operation ?? draft.operation,
                  inputs: update.inputs ?? draft.inputs,
                }),
              ]),
            ),
          }
        : {}),
      revision: previous.revision + 1,
    }));
  const applyPreset = ({ settings, assets }: MediaPreset, onlyIfUntouched = false) => {
    const next = offerings.find(
      (item) => item.connectionId === settings.connectionId && item.modelId === settings.modelId,
    );
    const route = next?.routes?.find((item) => item.providerTag === settings.providerTag);
    const cap = (route?.capabilities ?? next?.capabilities)?.find(
      (item) => item.operation === settings.operation,
    );
    if (!next || !cap) return false;
    if (settings.providerTag && !route) return false;
    const inputs = settings.inputs ?? [];
    const references = inputs.map((input) =>
      assets.find((asset) => asset.file_id === input.file_id),
    );
    // The server omits deleted or expired files. Never restore only part of a saved reference set.
    if (inputs.some((input, index) => input.sourceURL || !references[index])) return false;
    if (
      validateMediaCapability(
        { ...settings, inputs: mediaInputsWithMetadata(inputs, assets) },
        cap,
        catalog.limits,
        {
          checkInputs: inputs.length > 0,
        },
      ).length
    )
      return false;
    const update: Partial<MediaDraft> = {
      offering: offeringId(next),
      providerTag: route?.providerTag ?? next.defaultProviderTag,
      providerOptionsText: undefined,
      operation: settings.operation,
      parameters: settings.parameters,
    };
    if (settings.inputs !== undefined || settings.operation === 'image.generate') {
      update.autoEdit = settings.operation === 'image.edit' && inputs.length === 0;
      update.parentTurnId = undefined;
      update.referenceURL = undefined;
      update.inputs = inputs.map(({ file_id, role }) => ({ file_id, role }));
      update.assets = references.filter((asset) => asset !== undefined);
    } else if (
      settings.operation === 'image.edit' &&
      !savedDraft.inputs.length &&
      !savedDraft.parentTurnId
    ) {
      update.autoEdit = true;
    }
    if (onlyIfUntouched)
      setDraft((previous) =>
        (previous.offering && previous.revision > 1) ||
        previous.prompt ||
        previous.inputs.length ||
        previous.assets.length ||
        previous.parentTurnId
          ? previous
          : { ...previous, ...update, revision: previous.revision + 1 },
      );
    else change(update);
    return true;
  };
  const defaultPreset = presets.data?.find((preset) => preset.isDefault);
  const untouched =
    !savedDraft.offering &&
    !initialOffering &&
    !savedDraft.prompt &&
    savedDraft.inputs.length === 0 &&
    savedDraft.assets.length === 0 &&
    !savedDraft.parentTurnId;
  const seedPreset = useRef(applyPreset);
  seedPreset.current = applyPreset;
  useEffect(() => {
    if (normalizeDraft && untouched && defaultPreset) seedPreset.current(defaultPreset, true);
  }, [defaultPreset, untouched, normalizeDraft]);
  const param = <K extends keyof MediaDraft['parameters']>(
    key: K,
    value: MediaDraft['parameters'][K],
  ) => {
    const parameters = { ...draft.parameters, [key]: value };
    if (key === 'size') {
      delete parameters.resolution;
      delete parameters.aspectRatio;
    } else if (key === 'resolution' || key === 'aspectRatio') delete parameters.size;
    change({
      parameters,
      parameterContexts: {
        ...savedDraft.parameterContexts,
        [key]: mediaParameterContext(draft),
      },
    });
  };
  const controls: FormControls = capability?.controls ?? {};
  const parameters = capability
    ? mediaContextParameters(
        savedDraft,
        draft,
        capability,
        capabilities ?? [],
        catalog.limits,
        automaticReference,
      )
    : { ...draft.parameters };
  const providerOptionsText =
    draft.providerOptionsText ??
    (draft.parameters.providerOptions
      ? JSON.stringify(draft.parameters.providerOptions, null, 2)
      : '');
  const options = readProviderOptions(providerOptionsText, catalog);
  delete parameters.providerOptions;
  if (options.value && Object.keys(options.value).length)
    parameters.providerOptions = options.value;
  const validationInputs = mediaInputsWithMetadata(draft.inputs, draft.assets);
  const maxPromptChars = Math.min(
    catalog.limits.maxPromptChars,
    capability?.maxPromptChars ?? Infinity,
  );
  const promptInvalid = draft.prompt.length > maxPromptChars;
  const validation = capability
    ? validateMediaCapability(
        {
          operation: capability.operation,
          inputs: validationInputs,
          prompt: draft.prompt,
          parameters,
        },
        capability,
        catalog.limits,
      )
    : [];
  const invalidSettings = [
    ...new Set(
      validation.flatMap((issue) =>
        issue.field === 'inputs' || issue.field === 'prompt' ? [] : [issue.field],
      ),
    ),
  ];
  const optionsInvalid = options.invalid || invalidSettings.includes('providerOptions');
  return {
    id,
    catalog,
    threadId,
    portal,
    host,
    features,
    presets,
    localize,
    draftKey,
    savedDraft,
    setDraft,
    offerings,
    offering,
    providerTag,
    selectedRoute,
    staleRoute,
    capabilities,
    draft,
    automaticReference,
    capability,
    referenceOwner,
    hostedRoles,
    referenceURLRole,
    referenceURL,
    unsupportedContext,
    unavailableContext,
    change,
    applyPreset,
    param,
    controls,
    parameters,
    providerOptionsText,
    invalidSettings,
    optionsInvalid,
    validation,
    validationInputs,
    maxPromptChars,
    promptInvalid,
  };
}
export type MediaDraftForm = ReturnType<typeof useMediaDraftForm>;

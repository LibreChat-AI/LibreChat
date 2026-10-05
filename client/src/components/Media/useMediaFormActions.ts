import { useEffect, useRef, useState } from 'react';
import { v4 } from 'uuid';
import { useStore } from 'jotai';
import { mediaSubmissionRequestSchema, validateMediaCapability } from 'librechat-data-provider';
import type { MediaDraftForm } from './useMediaDraftForm';
import type { MediaFormSelection } from './selection';
import type { MediaDraft, MediaSend } from './state';
import { useMediaUpload } from '~/data-provider';
import { comparisonParameters } from './options';
import { mediaErrorCode } from './commands';
import { mediaErrorLabels } from './labels';
import { mediaDraftFamily } from './state';
export function useMediaFormActions(
  form: MediaDraftForm,
  selection: MediaFormSelection | undefined,
  send: MediaSend,
  busy: boolean,
) {
  const {
    catalog,
    threadId,
    host,
    localize,
    draftKey,
    setDraft,
    offering,
    providerTag,
    staleRoute,
    capabilities,
    draft,
    capability,
    referenceOwner,
    hostedRoles,
    referenceURL,
    unsupportedContext,
    unavailableContext,
    change,
    parameters,
    invalidSettings,
    optionsInvalid,
    validation,
  } = form;
  const [error, setError] = useState<string>();
  const store = useStore();
  const batch = useRef(false);
  const uploads = useMediaUpload(host, referenceOwner);
  const { uploading } = uploads;
  useEffect(() => {
    setError(undefined);
  }, [referenceOwner]);
  async function submit() {
    if (!selection) return;
    const { inputsValid, compareOffering, compareRoute, compareCapability, compareInvalid } =
      selection;

    if (
      !offering ||
      !capability ||
      !host.canCreate ||
      busy ||
      uploading ||
      validation.length ||
      invalidSettings.length ||
      optionsInvalid ||
      staleRoute ||
      !inputsValid ||
      unsupportedContext ||
      unavailableContext ||
      compareInvalid
    )
      return;
    setError(undefined);
    const comparing = !!compareOffering && !!compareCapability;
    const parsed = mediaSubmissionRequestSchema.safeParse({
      schemaVersion: 1,
      clientRequestId: v4(),
      threadId,
      parentTurnId: threadId ? draft.parentTurnId : undefined,
      selection: {
        connectionId: offering.connectionId,
        modelId: offering.modelId,
        catalogVersion: catalog.version,
        providerTag,
      },
      operation: capability.operation,
      prompt: draft.prompt,
      inputs: draft.inputs,
      parameters,
      temporary: !threadId && draft.temporary ? true : undefined,
      comparisonId: comparing ? v4() : undefined,
    });
    if (
      !parsed.success ||
      validateMediaCapability(parsed.data, capability, catalog.limits).length
    ) {
      setError(localize('com_media_error_invalid_request'));
      return;
    }
    const comparison = comparing
      ? mediaSubmissionRequestSchema.safeParse({
          schemaVersion: 1,
          clientRequestId: v4(),
          threadId,
          parentTurnId: threadId ? draft.parentTurnId : undefined,
          selection: {
            connectionId: compareOffering.connectionId,
            modelId: compareOffering.modelId,
            catalogVersion: catalog.version,
            providerTag: compareRoute?.providerTag ?? compareOffering.defaultProviderTag,
          },
          operation: compareCapability.operation,
          prompt: draft.prompt,
          inputs: draft.inputs,
          parameters: comparisonParameters(compareCapability, parameters.count, draft.inputs),
          comparisonId: parsed.data.comparisonId,
        })
      : undefined;
    if (
      comparison &&
      (!comparison.success ||
        validateMediaCapability(comparison.data, compareCapability!, catalog.limits).length)
    ) {
      setError(localize('com_media_compare_unsupported'));
      return;
    }
    await send({
      kind: 'submission',
      request: parsed.data,
      ...(comparison?.success ? { following: comparison.data } : {}),
      draftKey,
      draftRevision: draft.revision,
    });
  }
  async function uploadOne(file: File): Promise<boolean> {
    const stored = store.get(mediaDraftFamily(draftKey));
    const currentDraft = stored.revision === draft.revision ? draft : stored;
    if (
      !host.canCreate ||
      !capability ||
      !selection ||
      currentDraft.inputs.length >= selection.uploadLimit
    )
      return false;
    const imageCapabilities = capabilities?.find((item) => item.operation === 'image.edit');
    const roles =
      file.type.startsWith('image/') && imageCapabilities
        ? imageCapabilities.inputs.roles
        : capability.inputs.roles;
    let role: MediaDraft['inputs'][number]['role'] | undefined;
    if (file.type.startsWith('video/')) role = 'video';
    else if (file.type.startsWith('audio/')) role = 'audio';
    else if (file.type.startsWith('image/'))
      role = (['reference', 'start_frame', 'end_frame'] as const).find((value) =>
        roles.includes(value),
      );
    if (!role || !roles.includes(role)) {
      setError(localize('com_media_upload_unsupported'));
      return false;
    }
    if (hostedRoles.some((hostedRole) => hostedRole === role)) {
      setError(localize('com_media_reference_needs_url'));
      return false;
    }
    setError(undefined);
    change({
      autoEdit: unavailableContext ? currentDraft.autoEdit : false,
      parentTurnId: currentDraft.parentTurnId,
      inputs: currentDraft.inputs,
      assets: currentDraft.assets,
    });
    try {
      const body = new FormData();
      body.append('file', file);
      const response = await uploads.uploadFile(body);
      if (!response) return false;
      setDraft((previous) => ({
        ...previous,
        revision: previous.revision + 1,
        autoEdit: false,
        assets: [...previous.assets, response.file],
        inputs: [
          ...previous.inputs,
          {
            file_id: response.file.file_id,
            role,
          },
        ],
        operation:
          file.type.startsWith('image/') && imageCapabilities ? 'image.edit' : previous.operation,
      }));
      return true;
    } catch (failure) {
      setError(localize(mediaErrorLabels[mediaErrorCode(failure)]));
      return false;
    }
  }
  const uploadCurrent = useRef(uploadOne);
  const uploadOwner = useRef(referenceOwner);
  uploadCurrent.current = uploadOne;
  uploadOwner.current = referenceOwner;
  async function uploadFiles(files: File[]): Promise<boolean> {
    if (batch.current || uploading || !files.length) return false;
    batch.current = true;
    let uploaded = false;
    try {
      for (const file of files) {
        if (uploadOwner.current !== referenceOwner || !host.isCurrentSession()) break;
        if (!(await uploadCurrent.current(file))) break;
        uploaded = true;
      }
      return uploaded;
    } finally {
      batch.current = false;
    }
  }
  const uploadFile = (file?: File) => uploadFiles(file ? [file] : []);
  async function uploadURL(): Promise<boolean> {
    if (
      !host.canCreate ||
      !capability ||
      uploading ||
      !referenceURL.success ||
      !hostedRoles.includes(referenceURL.data.role) ||
      draft.inputs.length >= Math.min(catalog.limits.maxInputs, capability.inputs.max)
    )
      return false;
    setError(undefined);
    const payload = referenceURL.data;
    change({
      autoEdit: unavailableContext ? draft.autoEdit : false,
      inputs: draft.inputs,
      assets: draft.assets,
    });
    try {
      const response = await uploads.uploadURL(payload);
      if (!response) return false;
      setDraft((previous) => ({
        ...previous,
        revision: previous.revision + 1,
        autoEdit: false,
        referenceURL: previous.referenceURL?.trim() === payload.url ? '' : previous.referenceURL,
        assets: [...previous.assets, response.file],
        inputs: [
          ...previous.inputs,
          { file_id: response.file.file_id, role: payload.role, sourceURL: response.sourceURL },
        ],
      }));
      return true;
    } catch (failure) {
      setError(localize(mediaErrorLabels[mediaErrorCode(failure)]));
      return false;
    }
  }
  return { error, uploads, uploading, submit, uploadFile, uploadFiles, uploadURL };
}

export type MediaFormActions = ReturnType<typeof useMediaFormActions>;

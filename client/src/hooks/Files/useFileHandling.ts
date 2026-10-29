import React, { useCallback, useEffect, useRef, useMemo, useState } from 'react';
import { v4 } from 'uuid';
import debounce from 'lodash/debounce';
import { useToastContext } from '@librechat/client';
import { useQueryClient } from '@tanstack/react-query';
import { useSetRecoilState, useRecoilCallback } from 'recoil';
import {
  megabyte,
  QueryKeys,
  Constants,
  EToolResources,
  mergeFileConfig,
  isAssistantsEndpoint,
  isEphemeralAgentId,
  getEndpointFileConfig,
  defaultAssistantsVersion,
} from 'librechat-data-provider';
import type {
  TError,
  EModelEndpoint,
  TEndpointsConfig,
  EndpointFileConfig,
} from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import type { SkippedUpload, UploadPartition } from '~/utils';
import type { ExtendedFile, FileSetter } from '~/common';
import type { FileSearchUploadContext } from './search';
import {
  logger,
  validateFiles,
  cachePreview,
  partitionUploads,
  validateFileSizes,
  validateFileLimit,
  getCachedPreview,
  removePreviewEntry,
  validateFileDuplicates,
} from '~/utils';
import {
  beginFileSearchUpload,
  captureFileSearchUpload,
  canRestoreFileSearchUpload,
  cancelFileSearchUpload,
  completeFileSearchUpload,
} from './search';
import { useGetFileConfig, useUploadFileMutation } from '~/data-provider';
import useAgentUploadTarget from '~/hooks/Agents/useAgentUploadTarget';
import useLocalize, { TranslationKeys } from '~/hooks/useLocalize';
import { useChatSettings } from '~/Providers/ChatSettingsContext';
import { useDelayedUploadToast } from './useDelayedUploadToast';
import { useChatContext } from '~/Providers/ChatContext';
import { importWithRecovery } from '~/lib/assets/lazy';
import { captureComposerDraft } from '~/utils/drafts';
import { ephemeralAgentByConvoId } from '~/store';
import useClientResize from './useClientResize';
import useUpdateFiles from './useUpdateFiles';

type UseFileHandling = {
  fileSetter?: FileSetter;
  fileFilter?: (file: File) => boolean;
  additionalMetadata?: Record<string, string | undefined>;
  /** Overrides `endpoint` for upload routing; also used as `endpointType` fallback when `endpointTypeOverride` is not set */
  endpointOverride?: EModelEndpoint | string;
  /** Overrides `endpointType` independently from `endpointOverride` */
  endpointTypeOverride?: EModelEndpoint | string;
};

export type FileHandlingState = {
  index?: number;
  files: Map<string, ExtendedFile>;
  setFiles: FileSetter;
  setFilesLoading?: React.Dispatch<React.SetStateAction<boolean>>;
  conversation?: TConversation | null;
};

type ProcessedUpload = {
  extendedFile: ExtendedFile;
  preview: string;
  recovery: UploadRecovery;
  resizeDetails?: {
    originalSize: number;
    newSize: number;
    compressionRatio: number;
  };
};

export type UploadLifecycleCallbacks = {
  /** Immutable operation intent, captured before queue/config/preparation/download waits. */
  fileSearch?: Readonly<{ context: FileSearchUploadContext; activate: () => void }>;
  /** Preassigned id so callers can persist recovery before the shared upload queue waits. */
  fileId?: string;
  /** An attachment being replaced remains in state until the replacement succeeds, but should not
   * count against this upload's file and total-size limits. */
  replacesFileId?: string;
  /** Read once the queue and config waits are over, immediately before the batch is written into
   * the shared file state. A `false` return abandons the batch so a delayed upload cannot land in
   * a composer the user has since navigated away from. */
  shouldCommit?: () => boolean;
  /** UI ownership remains independent of a replacement's pre-staging eligibility. */
  isCurrent?: () => boolean;
  onStart?: (fileId: string) => void;
  onSuccess?: (fileId: string) => void;
  onError?: (fileId: string) => void;
  onAbort?: (fileId: string) => void;
};

const noop = () => {};
type UploadRecovery = UploadLifecycleCallbacks & {
  status: 'staged' | 'uploading' | 'settled' | 'canceled';
  dispose?: () => void;
  body?: FormData;
  onFileSearchSuccess?: () => void;
};
const uploadErrorCallbacks = new Map<string, UploadRecovery>();

const takeUploadRecovery = (fileId: string, body?: FormData): UploadRecovery | undefined => {
  const callbacks = uploadErrorCallbacks.get(fileId);
  if (body && callbacks?.body !== body) {
    return undefined;
  }
  uploadErrorCallbacks.delete(fileId);
  if (callbacks) {
    callbacks.status = 'settled';
  }
  return callbacks;
};

export const clearUploadRecovery = (fileId: string, retainFileSearch = false) => {
  const recovery = uploadErrorCallbacks.get(fileId);
  const onAbort = recovery?.onAbort;
  if (retainFileSearch && recovery?.fileSearch && recovery.status !== 'canceled') {
    recovery.onStart = undefined;
    recovery.onSuccess = undefined;
    recovery.onError = undefined;
    recovery.onAbort = undefined;
  } else {
    uploadErrorCallbacks.delete(fileId);
    if (recovery) {
      recovery.status = 'canceled';
      recovery.dispose?.();
    }
  }
  if (!retainFileSearch) {
    cancelFileSearchUpload(fileId);
  }
  onAbort?.(fileId);
};

export const hasInFlightUpload = (fileId: string, conversationId?: string): boolean => {
  const recovery = uploadErrorCallbacks.get(fileId);
  return (
    recovery != null &&
    (conversationId == null ||
      (recovery.fileSearch?.context.conversationId === conversationId &&
        canRestoreFileSearchUpload(fileId, conversationId, recovery.fileSearch.context)))
  );
};

type UploadScope = {
  queue: Promise<void>;
  /** Accepted uploads that have not been observed in the shared file state yet */
  recent: Map<string, ExtendedFile>;
};

/**
 * Upload batches are validated against the file map they write to, so every hook instance
 * sharing a setter (attachment menu, paste routing, SharePoint) must share one queue.
 */
const uploadScopes = new WeakMap<FileSetter, UploadScope>();

const getUploadScope = (fileSetter: FileSetter): UploadScope => {
  const scope = uploadScopes.get(fileSetter);
  if (scope != null) {
    return scope;
  }

  const created: UploadScope = { queue: Promise.resolve(), recent: new Map() };
  uploadScopes.set(fileSetter, created);
  return created;
};

const mergeRecentUploads = (
  files: Map<string, ExtendedFile>,
  recent: Map<string, ExtendedFile>,
): Map<string, ExtendedFile> => {
  if (recent.size === 0) {
    return files;
  }

  const merged = new Map(files);
  for (const [file_id, extendedFile] of recent) {
    if (!merged.has(file_id)) {
      merged.set(file_id, extendedFile);
    }
  }
  return merged;
};

const useFileHandlingCore = (params: UseFileHandling | undefined, fileState: FileHandlingState) => {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const { showToast } = useToastContext();
  const [errors, setErrors] = useState<string[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);
  const { startUploadTimer, clearUploadTimer } = useDelayedUploadToast();
  const { files, setFiles, conversation, index = 0 } = fileState;
  const owner = useMemo(
    () => ({ index, fileSetter: params?.fileSetter }),
    [index, params?.fileSetter],
  );
  const currentConversationRef = useRef(conversation?.conversationId ?? Constants.NEW_CONVO);
  currentConversationRef.current = conversation?.conversationId ?? Constants.NEW_CONVO;
  const ownerRef = useRef<typeof owner | null>(owner);
  ownerRef.current = owner;
  useEffect(() => {
    ownerRef.current = owner;
    return () => {
      ownerRef.current = null;
    };
  }, [owner]);
  const filesRef = useRef(files);
  filesRef.current = files;
  const fileSetter = params?.fileSetter ?? setFiles;
  const uploadScope = getUploadScope(fileSetter);
  /** Reservations are only observable when the rendered state is the state being written */
  const tracksReservations = fileSetter === setFiles;
  if (tracksReservations) {
    for (const file_id of uploadScope.recent.keys()) {
      if (files.has(file_id)) {
        uploadScope.recent.delete(file_id);
      }
    }
  }
  const composerRoute = window.location.pathname + window.location.search;
  useEffect(() => {
    if (!tracksReservations) return;
    for (const fileId of files.keys()) {
      const recovery = uploadErrorCallbacks.get(fileId);
      if (recovery?.isCurrent?.() === false) recovery.dispose?.();
    }
  }, [files, conversation?.conversationId, composerRoute, tracksReservations]);

  const setFilesLoading = fileState.setFilesLoading ?? noop;
  const setEphemeralAgent = useSetRecoilState(
    ephemeralAgentByConvoId(conversation?.conversationId ?? Constants.NEW_CONVO),
  );
  const activateFileSearch = useRecoilCallback(
    ({ set }) =>
      (conversationId: string) =>
        set(ephemeralAgentByConvoId(conversationId), (previous) => ({
          ...previous,
          [EToolResources.file_search]: true,
        })),
    [],
  );
  const { isTemporary } = useChatSettings();
  const setError = (error: string) => setErrors((prevErrors) => [...prevErrors, error]);

  /** Names the files left out of a batch that is otherwise still uploading. Callers report a batch
   * rejected in full through the existing all-or-nothing errors instead. */
  const reportSkippedUploads = (
    skipped: SkippedUpload[],
    endpointFileConfig: EndpointFileConfig,
  ) => {
    if (skipped.length === 0) {
      return;
    }
    const duplicates: string[] = [];
    const oversized: string[] = [];
    const unsupported: string[] = [];
    for (const { file, reason } of skipped) {
      if (reason === 'duplicate') {
        duplicates.push(file.name);
        continue;
      }
      if (reason === 'unsupportedType') {
        unsupported.push(file.name);
        continue;
      }
      oversized.push(file.name);
    }
    if (duplicates.length > 0) {
      setError(localize('com_error_files_skipped_dupe', { 0: duplicates.join(', ') }));
    }
    if (oversized.length > 0) {
      setError(
        localize('com_error_files_skipped_size', {
          0: `${(endpointFileConfig.fileSizeLimit ?? 0) / megabyte}`,
          1: oversized.join(', '),
        }),
      );
    }
    if (unsupported.length > 0) {
      setError(localize('com_error_files_skipped_type', { 0: unsupported.join(', ') }));
    }
  };
  const { addFile, replaceFile, updateFileById, deleteFileById } = useUpdateFiles(fileSetter);
  const { isConfigPending, waitForConfig, resizeImageIfNeeded } = useClientResize();

  const agent_id = params?.additionalMetadata?.agent_id ?? '';
  const assistant_id = params?.additionalMetadata?.assistant_id ?? '';
  const isConversationUpload = !agent_id && !assistant_id;
  const endpointOverride = params?.endpointOverride;
  const endpointTypeOverride = params?.endpointTypeOverride;
  const endpointType = useMemo(
    () => endpointTypeOverride ?? endpointOverride ?? conversation?.endpointType,
    [endpointTypeOverride, endpointOverride, conversation?.endpointType],
  );
  const endpoint = useMemo(
    () => endpointOverride ?? conversation?.endpoint ?? 'default',
    [endpointOverride, conversation?.endpoint],
  );
  const uploadTarget = useAgentUploadTarget(conversation);
  /** An agent's file policy lives under its provider, which is the entry the server
   *  validates against. An explicit override names its own endpoint and keeps it. */
  const agentProvider = endpointOverride != null ? undefined : uploadTarget.agentProvider;
  const agentEndpointType = endpointOverride != null ? undefined : uploadTarget.endpointType;
  const usesResponsesApi = uploadTarget.useResponsesApi;

  const { data: fileConfig = null } = useGetFileConfig({
    select: (data) => mergeFileConfig(data),
  });
  const fileConfigRef = useRef(fileConfig);
  fileConfigRef.current = fileConfig;

  const displayToast = useCallback(() => {
    if (errors.length > 1) {
      // TODO: this should not be a dynamic localize input!!
      const errorList = Array.from(new Set(errors))
        .map((e, i) => `${i > 0 ? '• ' : ''}${localize(e as TranslationKeys) || e}\n`)
        .join('');
      showToast({
        message: errorList,
        status: 'error',
        duration: 5000,
      });
    } else if (errors.length === 1) {
      // TODO: this should not be a dynamic localize input!!
      const message = localize(errors[0] as TranslationKeys) || errors[0];
      showToast({
        message,
        status: 'error',
        duration: 5000,
      });
    }

    setErrors([]);
  }, [errors, showToast, localize]);

  const debouncedDisplayToast = useMemo(() => debounce(displayToast, 250), [displayToast]);

  useEffect(() => {
    if (errors.length > 0) {
      debouncedDisplayToast();
    }

    return () => debouncedDisplayToast.cancel();
  }, [errors, debouncedDisplayToast]);

  const uploadFile = useUploadFileMutation(
    {
      onSuccess: (data, body) => {
        /** Every client-side handle for this upload — the file map key, the delayed
         * toast timer, the recovery callbacks — is the id the request was sent with.
         * `temp_file_id` is the server's echo of it, so trusting the echo turns any
         * mismatch into a completion update applied to a key that does not exist:
         * the attachment stays below `progress: 1` and the send button never
         * re-enables. Reconcile against the id we own. */
        const fileId = (body.get('file_id') as string | null) ?? data.temp_file_id;
        const recovery = takeUploadRecovery(fileId, body);
        if (!recovery) {
          return;
        }
        recovery.onFileSearchSuccess?.();
        recovery?.onSuccess?.(fileId);
        clearUploadTimer(fileId);
        if (agent_id) {
          queryClient.refetchQueries([QueryKeys.agent, agent_id]);
          return;
        }
        if (recovery.isCurrent?.() === false) {
          recovery.dispose?.();
          return;
        }
        updateFileById(
          fileId,
          {
            progress: 0.9,
            filepath: data.filepath,
          },
          assistant_id ? true : false,
          recovery.isCurrent,
        );

        setTimeout(() => {
          if (recovery.isCurrent?.() === false) {
            recovery.dispose?.();
            return;
          }
          const cachedBlob = getCachedPreview(fileId);
          if (cachedBlob && data.file_id !== fileId) {
            cachePreview(data.file_id, cachedBlob);
            removePreviewEntry(fileId);
          }
          updateFileById(
            fileId,
            {
              progress: 1,
              file_id: data.file_id,
              /** The stored temporary id has to stay the one this entry is keyed
               * by: removal reads `file_id` and `temp_file_id` off the value and
               * deletes those keys, and the draft restore correlates the cached
               * record by the key it saved. Keeping the server's echo here would
               * leave a chip that Remove deletes server-side but cannot clear. */
              temp_file_id: fileId,
              filepath: data.filepath,
              type: data.type,
              height: data.height,
              width: data.width,
              filename: data.filename,
              source: data.source,
              embedded: data.embedded,
              llmDeliveryPath: data.llmDeliveryPath,
            },
            assistant_id ? true : false,
            recovery.isCurrent,
          );
        }, 300);
      },
      onError: (_error, body) => {
        const error = _error as TError | undefined;
        const file_id = body.get('file_id') as string;
        const uploadLifecycle = takeUploadRecovery(file_id, body);
        if (!uploadLifecycle) {
          return;
        }
        console.log('upload error', error);
        uploadLifecycle.dispose?.();
        cancelFileSearchUpload(file_id);
        const tool_resource = body.get('tool_resource');
        if (
          tool_resource === EToolResources.execute_code &&
          uploadLifecycle.isCurrent?.() !== false
        ) {
          setEphemeralAgent((prev) => ({
            ...prev,
            [EToolResources.execute_code]: false,
          }));
        }
        clearUploadTimer(file_id);

        let errorMessage = 'com_error_files_upload';

        if (error?.code === 'ERR_CANCELED') {
          errorMessage = 'com_error_files_upload_canceled';
        } else if (error?.response?.data?.message) {
          errorMessage = error.response.data.message;
        }
        setError(errorMessage);
        uploadLifecycle?.onError?.(file_id);
      },
    },
    abortControllerRef.current?.signal,
  );

  const captureUploadLifecycle = (
    toolResource?: string,
    lifecycle?: UploadLifecycleCallbacks,
  ): UploadLifecycleCallbacks | undefined => {
    const ownsDraft = captureComposerDraft(
      index,
      conversation?.conversationId ?? Constants.NEW_CONVO,
    );
    if (isConversationUpload) {
      const originId = conversation?.conversationId ?? Constants.NEW_CONVO;
      const shouldCommit = lifecycle?.shouldCommit;
      const previousOwner = lifecycle?.isCurrent;
      const usesComposerOwner = ownsDraft.registered && params?.fileSetter == null;
      const isCurrent = () =>
        (usesComposerOwner || ownerRef.current === owner) &&
        ownsDraft() &&
        (usesComposerOwner ||
          currentConversationRef.current === originId ||
          currentConversationRef.current === ownsDraft.conversationId()) &&
        previousOwner?.() !== false;
      lifecycle = {
        ...lifecycle,
        isCurrent,
        shouldCommit: () => isCurrent() && shouldCommit?.() !== false,
      };
    }
    if (
      lifecycle?.fileSearch ||
      !isConversationUpload ||
      isAssistantsEndpoint(endpointType ?? endpoint) ||
      toolResource !== EToolResources.file_search ||
      !isEphemeralAgentId(conversation?.agent_id)
    ) {
      return lifecycle;
    }
    return {
      ...lifecycle,
      fileSearch: {
        context: captureFileSearchUpload(
          conversation?.conversationId ?? Constants.NEW_CONVO,
          ownsDraft,
        ),
        activate: () => activateFileSearch(ownsDraft.conversationId()),
      },
    };
  };

  const canStageUpload = (fileId: string, recovery: UploadRecovery): boolean => {
    if (recovery.status !== 'staged') return false;
    if (recovery.shouldCommit?.() !== false) return true;
    if (uploadErrorCallbacks.get(fileId) === recovery) clearUploadRecovery(fileId);
    return false;
  };

  const uploadWithRecovery = (
    formData: FormData,
    file_id: string,
    uploadLifecycle: UploadRecovery,
  ) => {
    /* Capture the originating conversation's setter, not the mutation observer's
     * current conversation. Removal clears this callback before any late success. */
    if (!canStageUpload(file_id, uploadLifecycle)) {
      return;
    }
    const callbacks = uploadLifecycle;
    callbacks.status = 'uploading';
    callbacks.body = formData;
    const operation = uploadLifecycle?.fileSearch;
    if (operation && formData.get('tool_resource') === EToolResources.file_search) {
      const intent = beginFileSearchUpload(file_id, operation.context);
      callbacks.onFileSearchSuccess = () => {
        if (
          completeFileSearchUpload(
            file_id,
            operation.context.conversationId,
            intent.persisted ? undefined : intent.choiceRevision,
          )
        ) {
          operation.activate();
        }
      };
    }
    uploadErrorCallbacks.set(file_id, callbacks);
    callbacks.onStart?.(file_id);
    if (callbacks.shouldCommit?.() === false) {
      clearUploadRecovery(file_id);
      return;
    }
    if (callbacks.status === 'uploading') {
      uploadFile.mutate(formData);
    }
  };

  const startUpload = async (extendedFile: ExtendedFile, uploadLifecycle: UploadRecovery) => {
    if (!canStageUpload(extendedFile.file_id, uploadLifecycle)) {
      return;
    }
    const filename = extendedFile.file?.name ?? 'File';
    startUploadTimer(extendedFile.file_id, filename, extendedFile.size);

    const formData = new FormData();
    formData.append('endpoint', endpoint);
    formData.append('endpointType', endpointType ?? '');
    /* Azure carries native documents only through the Responses API, so routing needs to
     * know which one this conversation uses. A saved agent holds the setting on its own
     * record when the conversation does not carry one, which is the same fallback the
     * attach menu and the drop handler resolve. */
    if (usesResponsesApi === true) {
      formData.append('useResponsesApi', 'true');
    }
    formData.append('file', extendedFile.file as File, encodeURIComponent(filename));
    formData.append('file_id', extendedFile.file_id);
    if (
      isConversationUpload &&
      conversation?.conversationId &&
      conversation.conversationId !== Constants.NEW_CONVO
    ) {
      formData.append('conversationId', conversation.conversationId);
    }
    if (isTemporary && isConversationUpload) {
      formData.append('isTemporary', 'true');
    }

    const width = extendedFile.width ?? 0;
    const height = extendedFile.height ?? 0;
    if (width) {
      formData.append('width', width.toString());
    }
    if (height) {
      formData.append('height', height.toString());
    }

    const metadata = params?.additionalMetadata ?? {};
    if (params?.additionalMetadata) {
      for (const [key, value = ''] of Object.entries(metadata)) {
        if (value) {
          formData.append(key, value);
        }
      }
    }

    if (!isAssistantsEndpoint(endpointType ?? endpoint)) {
      if (!agent_id) {
        formData.append('message_file', 'true');
      }
      const tool_resource = extendedFile.tool_resource;
      if (tool_resource != null) {
        formData.append('tool_resource', tool_resource);
      }
      if (conversation?.agent_id != null && formData.get('agent_id') == null) {
        formData.append('agent_id', conversation.agent_id);
      }

      uploadWithRecovery(formData, extendedFile.file_id, uploadLifecycle);
      return;
    }

    const convoModel = conversation?.model ?? '';
    const convoAssistantId = conversation?.assistant_id ?? '';

    if (!assistant_id) {
      formData.append('message_file', 'true');
    }

    const endpointsConfig = queryClient.getQueryData<TEndpointsConfig>([QueryKeys.endpoints]);
    const version = endpointsConfig?.[endpoint]?.version ?? defaultAssistantsVersion[endpoint];

    if (!assistant_id && convoAssistantId) {
      formData.append('version', version);
      formData.append('model', convoModel);
      formData.append('assistant_id', convoAssistantId);
    }

    const formVersion = (formData.get('version') ?? '') as string;
    if (!formVersion) {
      formData.append('version', version);
    }

    const formModel = (formData.get('model') ?? '') as string;
    if (!formModel) {
      formData.append('model', convoModel);
    }

    uploadWithRecovery(formData, extendedFile.file_id, uploadLifecycle);
  };

  const loadImage = (
    extendedFile: ExtendedFile,
    preview: string,
    uploadLifecycle: UploadRecovery,
  ) => {
    const img = new Image();
    img.onload = async () => {
      if (!canStageUpload(extendedFile.file_id, uploadLifecycle)) {
        return;
      }
      const measuredFile: ExtendedFile = {
        ...extendedFile,
        width: img.width,
        height: img.height,
        progress: 0.6,
      };
      replaceFile(measuredFile, uploadLifecycle.isCurrent);

      await startUpload(measuredFile, uploadLifecycle);
    };
    /** The upload only starts once the browser has decoded the image, so a decode
     * it refuses (unsupported codec, truncated bytes, a revoked object URL) would
     * otherwise strand the attachment below `progress: 1` — which reads as "still
     * uploading" and keeps the composer's send button disabled for the rest of the
     * session, with nothing to click and no error to explain it. Drop the file and
     * say so instead. */
    img.onerror = () => {
      if (!canStageUpload(extendedFile.file_id, uploadLifecycle)) {
        return;
      }
      const recovery = takeUploadRecovery(extendedFile.file_id);
      recovery?.dispose?.();
      recovery?.onError?.(extendedFile.file_id);
      setError('com_error_files_process');
    };
    img.src = preview;
  };

  /** Resolves to whether the files passed validation and were accepted for upload. */
  const processFiles = async (
    originalFileList: File[],
    _toolResource?: string,
    uploadLifecycle?: UploadLifecycleCallbacks,
    assignedRecovery?: UploadRecovery,
  ): Promise<boolean> => {
    const fileList =
      assignedRecovery?.status === 'canceled' ? originalFileList.slice(1) : originalFileList;
    if (assignedRecovery?.status === 'canceled' && fileList.length === 0) {
      setFilesLoading(false);
      return false;
    }
    abortControllerRef.current = new AbortController();

    const existingFiles = tracksReservations
      ? mergeRecentUploads(filesRef.current, uploadScope.recent)
      : filesRef.current;
    const currentFileConfig = fileConfigRef.current;
    const endpointFileConfig = getEndpointFileConfig({
      endpoint: agentProvider ?? endpoint,
      fileConfig: currentFileConfig,
      endpointType: agentProvider != null ? agentEndpointType : endpointType,
    });
    /** The source remains visible until success, so exclude only its matching entry from this
     * upload's validation tallies. All other callers validate against the complete file map. */
    const filesForValidation = (() => {
      const replacesFileId = uploadLifecycle?.replacesFileId;
      if (replacesFileId == null || replacesFileId === '') {
        return existingFiles;
      }
      const withoutSource = new Map(existingFiles);
      for (const [key, existingFile] of existingFiles) {
        if (
          key === replacesFileId ||
          existingFile.file_id === replacesFileId ||
          existingFile.temp_file_id === replacesFileId
        ) {
          withoutSource.delete(key);
          break;
        }
      }
      return withoutSource;
    })();

    /** Drop duplicates one by one rather than rejecting everything picked alongside them, and hand
     * the survivors to `validateFiles`. Sizes wait for the partition below, once processing has
     * settled each file's final bytes, which is also where the file count is finally applied: a
     * file still headed for the discard pile must not spend a `fileLimit` slot. */
    const selection = partitionUploads({
      files: filesForValidation,
      fileList,
      endpointFileConfig,
      fileConfig: currentFileConfig,
      toolResource: _toolResource,
      skipSizeValidation: true,
    });
    /** Nothing survived, so the whole selection is rejected and the untouched list reports it
     * through the usual checks in their usual order. */
    const acceptedFileList =
      selection.keptIndices.length > 0
        ? selection.keptIndices.map((index) => fileList[index])
        : fileList;

    /* Validate files */
    let filesAreValid: boolean;
    try {
      filesAreValid = validateFiles({
        files: filesForValidation,
        fileList: acceptedFileList,
        setError,
        fileConfig: currentFileConfig,
        endpointFileConfig,
        toolResource: _toolResource,
        skipSizeValidation: true,
        skipBatchRules: selection.keptIndices.length > 0,
      });
    } catch (error) {
      console.error('file validation error', error);
      setError('com_error_files_validation');
      setFilesLoading(false);
      return false;
    }
    if (!filesAreValid) {
      setFilesLoading(false);
      return false;
    }

    const includesAssignedFile =
      assignedRecovery?.status === 'staged' &&
      (selection.keptIndices.length === 0 || selection.keptIndices[0] === 0);
    if (assignedRecovery && !includesAssignedFile) {
      if (uploadErrorCallbacks.get(uploadLifecycle?.fileId ?? '') === assignedRecovery) {
        takeUploadRecovery(uploadLifecycle?.fileId ?? '');
      }
    }

    /* Process files */
    const processedUploads: ProcessedUpload[] = [];
    for (const [fileIndex, originalFile] of acceptedFileList.entries()) {
      if (uploadLifecycle?.shouldCommit?.() === false) break;
      const usesAssignedId = fileIndex === 0 && includesAssignedFile;
      const file_id = usesAssignedId && uploadLifecycle?.fileId ? uploadLifecycle.fileId : v4();
      const recovery: UploadRecovery =
        usesAssignedId && assignedRecovery
          ? assignedRecovery
          : { ...uploadLifecycle, status: 'staged' };
      uploadErrorCallbacks.set(file_id, recovery);
      let currentPreview: string | undefined;
      let ownedFile = originalFile;
      recovery.dispose = () => {
        recovery.dispose = undefined;
        const ownsEntry = (currentFiles: Map<string, ExtendedFile>) => {
          const owner = uploadErrorCallbacks.get(file_id);
          const entry = currentFiles.get(file_id);
          return (
            (owner == null || owner === recovery) &&
            entry != null &&
            entry.progress < 1 &&
            (entry.file === originalFile || entry.file === ownedFile)
          );
        };
        const owner = uploadErrorCallbacks.get(file_id);
        if (owner == null || owner === recovery) {
          deleteFileById(file_id, ownsEntry);
          removePreviewEntry(file_id);
          uploadScope.recent.delete(file_id);
          if (ownsEntry(filesRef.current)) {
            const remaining = new Map(filesRef.current);
            remaining.delete(file_id);
            filesRef.current = remaining;
          }
        }
        clearUploadTimer(file_id);
        if (currentPreview) URL.revokeObjectURL(currentPreview);
      };
      try {
        // Create initial preview with original file
        const initialPreview = URL.createObjectURL(originalFile);
        currentPreview = initialPreview;
        cachePreview(file_id, initialPreview);

        // Create initial ExtendedFile to show immediately
        const initialExtendedFile: ExtendedFile = {
          file_id,
          file: originalFile,
          type: originalFile.type,
          preview: initialPreview,
          progress: 0.1, // Show as processing
          size: originalFile.size,
        };

        if (_toolResource != null && _toolResource !== '') {
          initialExtendedFile.tool_resource = _toolResource;
        }

        // Add file immediately to show in UI
        addFile(initialExtendedFile, recovery.isCurrent);

        const originalFileName = originalFile.name.toLowerCase();

        // Check if HEIC conversion is needed and show toast
        const isHEIC =
          originalFile.type === 'image/heic' ||
          originalFile.type === 'image/heif' ||
          /\.(heic|heif)$/.test(originalFileName);

        if (isHEIC) {
          showToast({
            message: localize('com_info_heic_converting'),
            status: 'info',
            duration: 3000,
          });
        }

        const heicProcessedFile = isHEIC
          ? await importWithRecovery(() => import('~/utils/heicConverter')).then(
              ({ processFileForUpload }) =>
                processFileForUpload(originalFile, 0.9, (conversionProgress) => {
                  if (!canStageUpload(file_id, recovery)) return;
                  const adjustedProgress = 0.1 + conversionProgress * 0.4;
                  replaceFile(
                    {
                      ...initialExtendedFile,
                      progress: adjustedProgress,
                    },
                    recovery.isCurrent,
                  );
                }),
            )
          : originalFile;

        if (!canStageUpload(file_id, recovery)) continue;
        let finalProcessedFile = heicProcessedFile;
        let resizeDetails: ProcessedUpload['resizeDetails'];

        // Apply client-side resizing if available and appropriate
        if (heicProcessedFile.type.startsWith('image/')) {
          try {
            const resizeResult = await resizeImageIfNeeded(heicProcessedFile);
            finalProcessedFile = resizeResult.file;

            if (resizeResult.resized && resizeResult.result) {
              const { originalSize, newSize, compressionRatio } = resizeResult.result;
              resizeDetails = { originalSize, newSize, compressionRatio };
            }
          } catch (resizeError) {
            if (!canStageUpload(file_id, recovery)) continue;
            console.warn('Image resize failed, using original:', resizeError);
            // Continue with HEIC processed file if resizing fails
          }
        }

        if (!canStageUpload(file_id, recovery)) continue;
        // If file was processed (HEIC converted or resized), update with new file and preview
        if (finalProcessedFile !== originalFile) {
          URL.revokeObjectURL(initialPreview); // Clean up original preview
          const newPreview = URL.createObjectURL(finalProcessedFile);
          currentPreview = newPreview;
          cachePreview(file_id, newPreview);

          ownedFile = finalProcessedFile;
          const updatedExtendedFile: ExtendedFile = {
            ...initialExtendedFile,
            file: finalProcessedFile,
            type: finalProcessedFile.type,
            preview: newPreview,
            progress: 0.5, // Processing complete, ready for upload
            size: finalProcessedFile.size,
          };

          replaceFile(updatedExtendedFile, recovery.isCurrent);
          processedUploads.push({
            extendedFile: updatedExtendedFile,
            recovery,
            preview: newPreview,
            resizeDetails,
          });
        } else {
          // Update progress to show ready for upload
          const readyExtendedFile = {
            ...initialExtendedFile,
            progress: 0.2,
          };
          replaceFile(readyExtendedFile, recovery.isCurrent);
          processedUploads.push({
            extendedFile: readyExtendedFile,
            recovery,
            preview: initialPreview,
            resizeDetails,
          });
        }
      } catch (error) {
        if (recovery.status === 'canceled') continue;
        takeUploadRecovery(file_id)?.dispose?.();
        console.log('file handling error', error);
        if (error instanceof Error && error.message.includes('HEIC')) {
          setError('com_error_heic_conversion');
        } else {
          setError('com_error_files_process');
        }
      }
    }

    const discardProcessedUpload = ({ extendedFile, recovery }: ProcessedUpload) => {
      if (uploadErrorCallbacks.get(extendedFile.file_id) === recovery) {
        takeUploadRecovery(extendedFile.file_id);
      }
      recovery.dispose?.();
    };

    const discardProcessedUploads = () => {
      for (const upload of processedUploads) {
        discardProcessedUpload(upload);
      }
    };

    const eligibleUploads = processedUploads.filter(({ extendedFile, recovery }) =>
      canStageUpload(extendedFile.file_id, recovery),
    );
    const processedFileList = eligibleUploads.map(({ extendedFile }) => extendedFile.file as File);

    let batch: UploadPartition;
    let acceptedUploads: ProcessedUpload[];
    try {
      batch = partitionUploads({
        files: filesForValidation,
        fileList: processedFileList,
        endpointFileConfig,
        fileConfig: currentFileConfig,
        toolResource: _toolResource,
      });
      acceptedUploads = batch.keptIndices.map((index) => eligibleUploads[index]);
      const acceptedFiles = acceptedUploads.map(({ extendedFile }) => extendedFile.file as File);
      /** `fileLimit` and `totalSizeLimit` describe the batch rather than any one file, so both are
       * applied to whatever survived the per-file partition above. */
      const batchIsValid =
        acceptedUploads.length > 0 &&
        validateFileLimit({
          files: filesForValidation,
          fileList: acceptedFiles,
          setError,
          endpointFileConfig,
        }) &&
        validateFileSizes({
          files: filesForValidation,
          fileList: acceptedFiles,
          setError,
          endpointFileConfig,
        });
      if (!batchIsValid) {
        /** Nothing is left to upload, so this is the pre-existing all-or-nothing rejection and it
         * keeps reporting itself that way instead of as per-file skip notices. */
        if (acceptedUploads.length === 0) {
          const noDuplicates = validateFileDuplicates({
            files: filesForValidation,
            fileList: processedFileList,
            setError,
          });
          if (noDuplicates) {
            validateFileSizes({
              files: filesForValidation,
              fileList: processedFileList,
              setError,
              endpointFileConfig,
            });
          }
        }
        discardProcessedUploads();
        setFilesLoading(false);
        return false;
      }
    } catch (error) {
      console.error('file validation error', error);
      setError('com_error_files_validation');
      discardProcessedUploads();
      setFilesLoading(false);
      return false;
    }

    for (const { index } of batch.skipped) {
      discardProcessedUpload(eligibleUploads[index]);
    }
    /** Held until the batch is known to be uploading: a selection that is rejected in full reports
     * itself through the batch-level errors alone, never alongside a partial-success notice. */
    reportSkippedUploads([...selection.skipped, ...batch.skipped], endpointFileConfig);

    const filesWithProcessedUploads = new Map(existingFiles);
    for (const { extendedFile } of acceptedUploads) {
      filesWithProcessedUploads.set(extendedFile.file_id, extendedFile);
      if (tracksReservations) {
        uploadScope.recent.set(extendedFile.file_id, extendedFile);
      }
    }
    filesRef.current = filesWithProcessedUploads;

    for (const { extendedFile, preview, resizeDetails, recovery } of acceptedUploads) {
      if (resizeDetails) {
        const { originalSize, newSize, compressionRatio } = resizeDetails;
        showToast({
          message: localize('com_info_image_resized', {
            0: (originalSize / (1024 * 1024)).toFixed(1),
            1: (newSize / (1024 * 1024)).toFixed(1),
            2: Math.round((1 - compressionRatio) * 100),
          }),
          status: 'success',
          duration: 3000,
        });
      }

      if (extendedFile.file?.type.startsWith('image/') === true) {
        loadImage(extendedFile, preview, recovery);
        continue;
      }

      await startUpload(extendedFile, recovery);
    }

    return acceptedUploads.length > 0;
  };

  const handleFiles = async (
    _files: FileList | File[],
    _toolResource?: string,
    uploadLifecycle?: UploadLifecycleCallbacks,
  ): Promise<boolean> => {
    const lifecycle = captureUploadLifecycle(_toolResource, uploadLifecycle);
    /** `FileList` is live: copy it before yielding, as callers reset the input synchronously */
    const fileList = Array.from(_files);
    const assignedFileId = lifecycle?.fileId;
    const assignedRecovery: UploadRecovery | undefined =
      assignedFileId && lifecycle ? { ...lifecycle, status: 'staged' } : undefined;
    if (assignedFileId && assignedRecovery) {
      if (uploadErrorCallbacks.has(assignedFileId)) {
        clearUploadRecovery(assignedFileId);
      }
      uploadErrorCallbacks.set(assignedFileId, assignedRecovery);
    }
    const releaseAssignedRecovery = () => {
      if (assignedFileId && uploadErrorCallbacks.get(assignedFileId) === assignedRecovery) {
        takeUploadRecovery(assignedFileId)?.dispose?.();
      }
    };
    /** Started before queueing so every waiting batch shares one bounded config window */
    const configReady = isConfigPending ? waitForConfig() : undefined;
    const previousProcessing = uploadScope.queue;
    let releaseProcessing: () => void = () => undefined;
    uploadScope.queue = new Promise<void>((resolve) => {
      releaseProcessing = resolve;
    });

    try {
      await previousProcessing;
      await configReady;
      if (lifecycle?.shouldCommit?.() === false) {
        releaseAssignedRecovery();
        setFilesLoading(false);
        return false;
      }
      const accepted = await processFiles(fileList, _toolResource, lifecycle, assignedRecovery);
      if (!accepted) {
        releaseAssignedRecovery();
      }
      return accepted;
    } catch (error) {
      releaseAssignedRecovery();
      throw error;
    } finally {
      releaseProcessing();
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>, _toolResource?: string) => {
    event.stopPropagation();
    if (event.target.files) {
      setFilesLoading(true);
      handleFiles(event.target.files, _toolResource);
      // reset the input
      event.target.value = '';
    }
  };

  const abortUpload = (fileId?: string) => {
    if (abortControllerRef.current) {
      logger.log('files', 'Aborting upload');
      abortControllerRef.current.abort('User aborted upload');
      abortControllerRef.current = null;
    }
    if (fileId) {
      clearUploadRecovery(fileId);
      return;
    }
    for (const uploadId of Array.from(uploadErrorCallbacks.keys())) {
      clearUploadRecovery(uploadId);
    }
  };

  return {
    handleFileChange,
    handleFiles,
    captureUploadLifecycle,
    abortUpload,
    setFiles,
    files,
  };
};

export const useFileHandlingNoChatContext = (
  params: UseFileHandling | undefined,
  fileState: FileHandlingState,
) => useFileHandlingCore(params, fileState);

const useFileHandling = (params?: UseFileHandling) => {
  const { files, setFiles, setFilesLoading, conversation, index } = useChatContext();

  return useFileHandlingCore(params, {
    index,
    files,
    setFiles,
    conversation,
    setFilesLoading,
  });
};

export default useFileHandling;

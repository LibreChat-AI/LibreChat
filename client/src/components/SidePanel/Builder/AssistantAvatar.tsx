import { useState, useEffect, useRef, useMemo } from 'react';
import { useToastContext } from '@librechat/client';
import { useQueryClient } from '@tanstack/react-query';
import {
  fileConfig as defaultFileConfig,
  QueryKeys,
  defaultOrderQuery,
  mergeFileConfig,
} from 'librechat-data-provider';
import type {
  Metadata,
  Assistant,
  AssistantsEndpoint,
  AssistantCreateParams,
  AssistantListResponse,
} from 'librechat-data-provider';
import type { UseMutationResult } from '@tanstack/react-query';
import { useUploadAssistantAvatarMutation, useGetFileConfig } from '~/data-provider';
import { AvatarMenu } from '~/components/SidePanel/Agents/Images';
import { useAssistantsMapContext } from '~/Providers';
import { AssistantAvatar, NoImage } from './Images';
// import { Spinner } from '@librechat/client';
import { useLocalize } from '~/hooks';
import { formatBytes } from '~/utils';

/** Assistants have no avatar reset, so the shared menu only offers the upload. */
const noReset = () => undefined;

function Avatar({
  endpoint,
  version,
  assistant_id,
  metadata,
  createMutation,
}: {
  endpoint: AssistantsEndpoint;
  version: number | string;
  assistant_id: string | null;
  metadata: null | Metadata;
  createMutation: UseMutationResult<Assistant, Error, AssistantCreateParams>;
}) {
  // console.log('Avatar', assistant_id, metadata, createMutation);
  const queryClient = useQueryClient();
  const assistantsMap = useAssistantsMapContext();
  const [progress, setProgress] = useState<number>(1);
  const [input, setInput] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const lastSeenCreatedId = useRef<string | null>(null);
  const { data: fileConfig = defaultFileConfig } = useGetFileConfig({
    select: (data) => mergeFileConfig(data),
  });

  const localize = useLocalize();
  const { showToast } = useToastContext();

  const activeModel = useMemo(() => {
    return assistantsMap?.[endpoint][assistant_id ?? '']?.model ?? '';
  }, [assistantsMap, endpoint, assistant_id]);

  const { mutate: uploadAvatar } = useUploadAssistantAvatarMutation({
    onMutate: () => {
      setProgress(0.4);
    },
    onSuccess: (data, vars) => {
      if (vars.postCreation !== true) {
        showToast({ message: localize('com_ui_upload_success') });
      } else if (lastSeenCreatedId.current !== createMutation.data?.id) {
        lastSeenCreatedId.current = createMutation.data?.id ?? '';
      }

      setInput(null);
      setPreviewUrl(data.metadata?.avatar as string | null);

      const res = queryClient.getQueryData<AssistantListResponse | undefined>([
        QueryKeys.assistants,
        endpoint,
        defaultOrderQuery,
      ]);

      if (!res?.data || !res) {
        return;
      }

      const assistants = res.data.map((assistant) => {
        if (assistant.id === assistant_id) {
          return {
            ...assistant,
            ...data,
          };
        }
        return assistant;
      });

      queryClient.setQueryData<AssistantListResponse>(
        [QueryKeys.assistants, endpoint, defaultOrderQuery],
        {
          ...res,
          data: assistants,
        },
      );

      setProgress(1);
    },
    onError: (error) => {
      console.error('Error:', error);
      setInput(null);
      setPreviewUrl(null);
      showToast({ message: localize('com_ui_upload_error'), status: 'error' });
      setProgress(1);
    },
  });

  useEffect(() => {
    if (input) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setPreviewUrl(reader.result as string);
      };
      reader.readAsDataURL(input);
    }
  }, [input]);

  useEffect(() => {
    setPreviewUrl((metadata?.avatar as string | undefined) ?? null);
  }, [metadata]);

  useEffect(() => {
    /** Experimental: Condition to prime avatar upload before Assistant Creation
     * - If the createMutation state Id was last seen (current) and the createMutation is successful
     * we can assume that the avatar upload has already been initiated and we can skip the upload
     *
     * The mutation state is not reset until the user deliberately selects a new assistant or an assistant is deleted
     *
     * This prevents the avatar from being uploaded multiple times before the user selects a new assistant
     * while allowing the user to upload to prime the avatar and other values before the assistant is created.
     */
    const sharedUploadCondition = !!(
      createMutation.isSuccess &&
      input &&
      previewUrl &&
      previewUrl.includes('base64')
    );
    if (sharedUploadCondition && lastSeenCreatedId.current === createMutation.data.id) {
      return;
    }

    if (sharedUploadCondition && createMutation.data.id) {
      console.log('[AssistantAvatar] Uploading Avatar after Assistant Creation');

      const formData = new FormData();
      formData.append('file', input, input.name);
      formData.append('assistant_id', createMutation.data.id);

      uploadAvatar({
        assistant_id: createMutation.data.id,
        model: activeModel,
        postCreation: true,
        formData,
        endpoint,
        version,
      });
    }
  }, [
    createMutation.data,
    createMutation.isSuccess,
    input,
    previewUrl,
    uploadAvatar,
    activeModel,
    endpoint,
    version,
  ]);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];

    if (fileConfig.avatarSizeLimit && file && file.size <= fileConfig.avatarSizeLimit) {
      if (!file) {
        console.error('No file selected');
        return;
      }

      setInput(file);

      if (!assistant_id) {
        // wait for successful form submission before uploading avatar
        console.log('[AssistantAvatar] No assistant_id, will wait until form submission + upload');
        return;
      }

      const formData = new FormData();
      formData.append('file', file, file.name);
      formData.append('assistant_id', assistant_id);

      uploadAvatar({
        assistant_id,
        model: activeModel,
        formData,
        endpoint,
        version,
      });
    } else {
      const megabytes = fileConfig.avatarSizeLimit ? formatBytes(fileConfig.avatarSizeLimit) : 2;
      showToast({
        message: localize('com_ui_upload_invalid_var', { 0: megabytes + '' }),
        status: 'error',
      });
    }
  };

  return (
    <div className="flex w-full items-center justify-center gap-4">
      <AvatarMenu
        trigger={
          <button
            type="button"
            className="h-20 w-20"
            aria-label={localize('com_ui_upload_avatar_label')}
          >
            {previewUrl ? <AssistantAvatar url={previewUrl} progress={progress} /> : <NoImage />}
          </button>
        }
        handleFileChange={handleFileChange}
        onReset={noReset}
        canReset={false}
      />
    </div>
  );
}

export default Avatar;

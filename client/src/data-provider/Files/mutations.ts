import { useToastContext } from '@librechat/client';
import { EToolResources } from 'librechat-data-provider';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  QueryKeys,
  dataService,
  MutationKeys,
  defaultOrderQuery,
  isAssistantsEndpoint,
} from 'librechat-data-provider';
import type { UseMutationResult } from '@tanstack/react-query';
import type * as t from 'librechat-data-provider';
import { invalidateRecentFiles } from '~/utils/files';
import { useGetStartupConfig } from '../Endpoints';
import { useLocalize } from '~/hooks';

export const useUploadFileMutation = (
  _options?: t.UploadMutationOptions,
  signal?: AbortSignal | null,
): UseMutationResult<
  t.TFileUpload, // response data
  unknown, // error
  FormData, // request
  unknown // context
> => {
  const { data: startupConfig } = useGetStartupConfig();
  const sseEnabled = startupConfig?.fileUploadSseEnabled === true;
  const queryClient = useQueryClient();
  const { onSuccess, ...options } = _options || {};
  return useMutation([MutationKeys.fileUpload], {
    mutationFn: (body: FormData) => {
      const width = body.get('width') ?? '';
      const height = body.get('height') ?? '';
      const version = body.get('version') ?? '';
      const endpoint = (body.get('endpoint') ?? '') as string;
      if (isAssistantsEndpoint(endpoint) && version === '2') {
        return dataService.uploadFile(body, signal, sseEnabled);
      }

      if (width !== '' && height !== '') {
        return dataService.uploadImage(body, signal, sseEnabled);
      }

      return dataService.uploadFile(body, signal, sseEnabled);
    },
    ...options,
    onSuccess: (data, formData, context) => {
      /** `temp_file_id` is the server's echo of the `file_id` the request was sent
       * with, and that request id is what every client-side handle for the upload
       * is keyed by — the composer's file map, the draft it saves, the delayed
       * toast timer. A record cached under an echo that disagrees cannot be
       * correlated back to the draft, so the attachment is silently dropped on the
       * next conversation switch or reload. Normalize once, on the way in. */
      const requestFileId = (formData.get('file_id') as string | null) ?? data.temp_file_id;
      const file =
        data.temp_file_id === requestFileId ? data : { ...data, temp_file_id: requestFileId };

      queryClient.setQueryData<t.TFile[] | undefined>([QueryKeys.files], (_files) => [
        file,
        ...(_files ?? []),
      ]);
      invalidateRecentFiles(queryClient);

      const endpoint = formData.get('endpoint');
      const message_file = formData.get('message_file');
      const agent_id = (formData.get('agent_id') as string | undefined) ?? '';
      const assistant_id = (formData.get('assistant_id') as string | undefined) ?? '';
      const tool_resource = (formData.get('tool_resource') as string | undefined) ?? '';

      if (message_file === 'true') {
        onSuccess?.(file, formData, context);
        return;
      }

      if (agent_id && tool_resource) {
        queryClient.setQueryData<t.Agent>([QueryKeys.agent, agent_id], (agent) => {
          if (!agent) {
            return agent;
          }

          const update = {};
          const prevResources = agent.tool_resources ?? {};
          const prevResource: t.ExecuteCodeResource | t.AgentFileResource = agent.tool_resources?.[
            tool_resource
          ] ?? {
            file_ids: [],
          };
          if (!prevResource.file_ids) {
            prevResource.file_ids = [];
          }
          prevResource.file_ids.push(data.file_id);
          update['tool_resources'] = {
            ...prevResources,
            [tool_resource]: prevResource,
          };
          if (!agent.tools?.includes(tool_resource)) {
            update['tools'] = [...(agent.tools ?? []), tool_resource];
          }
          return {
            ...agent,
            ...update,
          };
        });
      }

      if (!assistant_id) {
        onSuccess?.(file, formData, context);
        return;
      }

      queryClient.setQueryData<t.AssistantListResponse>(
        [QueryKeys.assistants, endpoint, defaultOrderQuery],
        (prev) => {
          if (!prev) {
            return prev;
          }

          return {
            ...prev,
            data: prev.data.map((assistant) => {
              if (assistant.id !== assistant_id) {
                return assistant;
              }

              const update = {};
              if (!tool_resource) {
                update['file_ids'] = [...(assistant.file_ids ?? []), data.file_id];
              }
              if (tool_resource === EToolResources.code_interpreter) {
                const prevResources = assistant.tool_resources ?? {};
                const prevResource = assistant.tool_resources?.[tool_resource] ?? {
                  file_ids: [],
                };
                if (!prevResource.file_ids) {
                  prevResource.file_ids = [];
                }
                prevResource.file_ids.push(data.file_id);
                update['tool_resources'] = {
                  ...prevResources,
                  [tool_resource]: prevResource,
                };
              }
              return {
                ...assistant,
                ...update,
              };
            }),
          };
        },
      );
      onSuccess?.(file, formData, context);
    },
  });
};

/**
 * Owner-scoped usage touch for uploads entering the client-side queue, so the
 * upload-window TTL cannot reap them while the message waits out a long run.
 * Fire-and-forget: failures are tolerated (send-time marking is the backstop).
 */
export const useMarkFilesUsageMutation = (): UseMutationResult<
  t.TFilesUsageResponse, // response data
  unknown, // error
  t.TFilesUsageBody, // request
  unknown // context
> => {
  return useMutation([MutationKeys.fileUsage], {
    mutationFn: (body: t.TFilesUsageBody) => dataService.markFilesUsage(body),
  });
};

export const useDeleteFilesMutation = (
  _options?: t.DeleteMutationOptions,
): UseMutationResult<
  t.DeleteFilesResponse, // response data
  unknown, // error
  t.DeleteFilesBody, // request
  unknown // context
> => {
  const queryClient = useQueryClient();
  const { showToast } = useToastContext();
  const localize = useLocalize();
  const { onSuccess, onError, silent = false, ...options } = _options || {};
  return useMutation([MutationKeys.fileDelete], {
    mutationFn: (body: t.DeleteFilesBody) => dataService.deleteFiles(body),
    ...options,
    onError: (error, vars, context) => {
      if (!silent && error && typeof error === 'object' && 'response' in error) {
        const errorWithResponse = error as { response?: { status?: number } };
        if (errorWithResponse.response?.status === 403) {
          showToast({
            message: localize('com_ui_delete_not_allowed'),
            status: 'error',
          });
        }
      }
      onError?.(error, vars, context);
    },
    onSuccess: (data, vars, context) => {
      /** Only a reported failure leaves a record on disk, so everything else the request named
       * is gone. Reading it the other way around would strand a row the server never had: a
       * file another tab already deleted matches no record, and the route answers that with
       * both id lists empty. Failed ids stay cached so the retry can still find them. */
      const failed = new Set(data?.failedFileIds ?? []);
      queryClient.setQueryData<t.TFile[] | undefined>([QueryKeys.files], (cachefiles) => {
        const { files: filesDeleted } = vars;
        const requested = filesDeleted.reduce((acc, file) => {
          acc.add(file.file_id);
          return acc;
        }, new Set<string>());

        return (cachefiles ?? []).filter(
          (file) => !requested.has(file.file_id) || failed.has(file.file_id),
        );
      });
      invalidateRecentFiles(queryClient);

      /** A storage failure still answers 200, so reporting success off the status alone would
       * tell the user a file is gone while it is sitting on disk and back in their list. */
      if (!silent) {
        showToast(
          failed.size > 0
            ? { message: localize('com_ui_delete_partial_failure'), status: 'error' }
            : { message: localize('com_ui_delete_success'), status: 'success' },
        );
      }

      onSuccess?.(data, vars, context);
      if (vars.agent_id != null && vars.agent_id) {
        queryClient.refetchQueries([QueryKeys.agent, vars.agent_id]);
      }
    },
  });
};

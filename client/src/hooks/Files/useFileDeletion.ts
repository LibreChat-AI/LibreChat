import { useCallback, useState, useEffect } from 'react';
import debounce from 'lodash/debounce';
import { FileSources, EToolResources, removeNullishValues } from 'librechat-data-provider';
import type { UseMutateAsyncFunction } from '@tanstack/react-query';
import type * as t from 'librechat-data-provider';
import type { ExtendedFile, GenericSetter } from '~/common';
import {
  deletePreview,
  failedFileIdsFrom,
  removeTabAttachmentPresence,
  retainFileDeletion,
  scheduleRetainedFileDeletionRetry,
} from '~/utils';
import useSetFilesToDelete from './useSetFilesToDelete';
import { clearUploadRecovery } from './useFileHandling';

type FileMapSetter = GenericSetter<Map<string, ExtendedFile>>;

const useFileDeletion = ({
  mutateAsync,
  agent_id,
  assistant_id,
  tool_resource,
  index,
}: {
  mutateAsync: UseMutateAsyncFunction<t.DeleteFilesResponse, unknown, t.DeleteFilesBody, unknown>;
  agent_id?: string;
  assistant_id?: string;
  tool_resource?: EToolResources;
  index?: number;
}) => {
  const [_batch, setFileDeleteBatch] = useState<t.BatchFile[]>([]);
  const setFilesToDelete = useSetFilesToDelete();

  const executeBatchDelete = useCallback(
    ({
      filesToDelete,
      agent_id,
      assistant_id,
      tool_resource,
    }: {
      filesToDelete: t.BatchFile[];
      agent_id?: string;
      assistant_id?: string;
      tool_resource?: EToolResources;
    }) => {
      const payload = removeNullishValues({
        agent_id,
        assistant_id,
        tool_resource,
      });
      /** The chips are already gone by the time this runs, so a lost request leaves nothing that
       * could rebuild the payload: whatever the server did not delete is kept for the retry pass.
       * A resolved request proves nothing on its own, since a failed storage delete is reported
       * as a 200 naming the file in `failedFileIds`. */
      const retainBatch = (files: t.BatchFile[]): void => {
        /** Only a plain deletion belongs in the shared retry queue. An agent or assistant unlink
         * carries context the retry does not replay, and without it the route would take the
         * ordinary delete branch and destroy a record other references still point at. Nothing is
         * orphaned by a failed unlink either: the file and its links are all still there. */
        if (agent_id != null || assistant_id != null || tool_resource != null) {
          return;
        }
        for (const file of files) {
          retainFileDeletion({
            file_id: file.file_id,
            embedded: file.embedded ?? false,
            filepath: file.filepath ?? '',
            source: file.source ?? FileSources.local,
          });
        }
        scheduleRetainedFileDeletionRetry();
      };
      mutateAsync({ files: filesToDelete, ...payload })
        .then((result) => {
          const failed = new Set(failedFileIdsFrom(result));
          if (failed.size === 0) {
            return;
          }
          retainBatch(filesToDelete.filter((file) => failed.has(file.file_id)));
        })
        .catch(() => retainBatch(filesToDelete));
      setFileDeleteBatch([]);
    },
    [mutateAsync],
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const debouncedDelete = useCallback(debounce(executeBatchDelete, 1000), []);

  useEffect(() => {
    /** Flush, don't cancel: unmount is a normal outcome of removing the last file,
     * and a cancelled batch silently drops a delete the user already confirmed. */
    return () => debouncedDelete.flush();
  }, [debouncedDelete]);

  const deleteFile = useCallback(
    ({ file: _file, setFiles }: { file: ExtendedFile | t.TFile; setFiles?: FileMapSetter }) => {
      const {
        file_id,
        temp_file_id = '',
        filepath = '',
        source = FileSources.local,
        embedded,
        attached = false,
      } = _file as t.TFile & { attached?: boolean };

      clearUploadRecovery(file_id);
      if (temp_file_id) {
        clearUploadRecovery(temp_file_id);
      }
      removeTabAttachmentPresence([file_id, temp_file_id].filter(Boolean), index);
      const progress = _file['progress'] ?? 1;

      if (progress < 1) {
        return;
      }
      const file: t.BatchFile = {
        file_id,
        embedded,
        filepath,
        source,
      };

      if (setFiles) {
        setFiles((currentFiles) => {
          const updatedFiles = new Map(currentFiles);
          updatedFiles.delete(file_id);
          updatedFiles.delete(temp_file_id);
          const files = Object.fromEntries(updatedFiles);
          setFilesToDelete(files);
          return updatedFiles;
        });
      }

      deletePreview(file_id);
      if (temp_file_id) {
        deletePreview(temp_file_id);
      }

      if (attached) {
        return;
      }

      setFileDeleteBatch((prevBatch) => {
        const newBatch = [...prevBatch, file];
        debouncedDelete({
          filesToDelete: newBatch,
          agent_id,
          assistant_id,
          tool_resource,
        });
        return newBatch;
      });
    },
    [debouncedDelete, setFilesToDelete, agent_id, assistant_id, tool_resource, index],
  );

  const deleteFiles = useCallback(
    ({ files, setFiles }: { files: ExtendedFile[] | t.TFile[]; setFiles?: FileMapSetter }) => {
      const batchFiles: t.BatchFile[] = [];
      for (const _file of files) {
        const {
          file_id,
          embedded,
          temp_file_id,
          filepath = '',
          source = FileSources.local,
        } = _file;

        clearUploadRecovery(file_id);
        if (temp_file_id) {
          clearUploadRecovery(temp_file_id);
        }

        batchFiles.push({
          source,
          file_id,
          filepath,
          temp_file_id,
          embedded: embedded ?? false,
        });

        deletePreview(file_id);
        if (temp_file_id) {
          deletePreview(temp_file_id);
        }
      }
      removeTabAttachmentPresence(
        batchFiles.flatMap((f) => [f.file_id, f.temp_file_id].filter(Boolean) as string[]),
        index,
      );

      if (setFiles) {
        setFiles((currentFiles) => {
          const updatedFiles = new Map(currentFiles);
          batchFiles.forEach((file) => {
            updatedFiles.delete(file.file_id);
            if (file.temp_file_id) {
              updatedFiles.delete(file.temp_file_id);
            }
          });
          const filesToUpdate = Object.fromEntries(updatedFiles);
          setFilesToDelete(filesToUpdate);
          return updatedFiles;
        });
      }

      setFileDeleteBatch((prevBatch) => {
        const newBatch = [...prevBatch, ...batchFiles];
        debouncedDelete({
          filesToDelete: newBatch,
          agent_id,
          assistant_id,
        });
        return newBatch;
      });
    },
    [debouncedDelete, setFilesToDelete, agent_id, assistant_id, index],
  );

  return { deleteFile, deleteFiles };
};

export default useFileDeletion;

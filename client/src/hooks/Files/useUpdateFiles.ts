import type { ExtendedFile, FileSetter } from '~/common';
import { isComposerFileTaken, releaseComposerFile } from '~/utils/composerFiles';
import useSetFilesToDelete from './useSetFilesToDelete';

export default function useUpdateFiles(setFiles: FileSetter) {
  const setFilesToDelete = useSetFilesToDelete();

  /**
   * Always a deliberate attach: the first, synchronous step of an upload the
   * user just started, or an explicit pick from the file panel. That intent
   * outranks any earlier consumption of the same id: re-attaching a library
   * file reuses its server id, so the mark is dropped rather than obeyed.
   */
  const addFile = (newFile: ExtendedFile) => {
    releaseComposerFile(newFile.file_id);
    setFiles((currentFiles) => {
      const updatedFiles = new Map(currentFiles);
      updatedFiles.set(newFile.file_id, newFile);
      return updatedFiles;
    });
  };

  /**
   * Only ever a continuation of an upload already in the composer (conversion
   * progress, resize, image measurement). A steer or a queued message can have
   * consumed that attachment while those callbacks were in flight, and writing
   * it back would resurrect a file the message already owns, so a consumed id
   * is dropped here instead of re-entering the composer.
   */
  const replaceFile = (newFile: ExtendedFile) => {
    if (isComposerFileTaken(newFile.file_id)) {
      return;
    }
    setFiles((currentFiles) => {
      const updatedFiles = new Map(currentFiles);
      updatedFiles.set(newFile.file_id, newFile);
      return updatedFiles;
    });
  };

  const updateFileById = (fileId: string, updates: Partial<ExtendedFile>, isEntityFile = false) => {
    setFiles((currentFiles) => {
      if (!currentFiles.has(fileId)) {
        console.warn(`File with id ${fileId} not found.`);
        return currentFiles;
      }

      const updatedFiles = new Map(currentFiles);
      const currentFile = updatedFiles.get(fileId);
      if (!currentFile) {
        console.warn(`File with id ${fileId} not found.`);
        return currentFiles;
      }
      updatedFiles.set(fileId, { ...currentFile, ...updates });
      const filepath = updates['filepath'] ?? '';
      if (filepath && updates['progress'] !== 1 && !isEntityFile) {
        const files = Object.fromEntries(updatedFiles);
        setFilesToDelete(files);
      }

      return updatedFiles;
    });
  };

  const deleteFileById = (fileId: string) => {
    setFiles((currentFiles) => {
      const updatedFiles = new Map(currentFiles);
      if (updatedFiles.has(fileId)) {
        updatedFiles.delete(fileId);
      } else {
        console.warn(`File with id ${fileId} not found.`);
      }

      const files = Object.fromEntries(updatedFiles);
      setFilesToDelete(files);
      return updatedFiles;
    });
  };

  return {
    addFile,
    replaceFile,
    updateFileById,
    deleteFileById,
  };
}

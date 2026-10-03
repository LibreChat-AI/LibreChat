import { useMemo, useState, useCallback, memo } from 'react';
import type { TFile, TMessage } from 'librechat-data-provider';
import FileContainer from '~/components/Chat/Input/Files/FileContainer';
import { usesImagePreview, hydrateFileDeliveryMetadata } from '~/utils';
import { useFileMapContext, useShareContext } from '~/Providers';
import FilePreviewDialog from './FilePreviewDialog';
import Image from './Image';

/** Takes the file list rather than the message: the content-part renderer has
 * to show the non-image half of it without handing the whole message object to
 * a memoized subtree. */
const Files = ({ files: messageFiles }: { files?: TMessage['files'] }) => {
  const fileMap = useFileMapContext();
  const { shareId } = useShareContext();
  const files = useMemo(
    () => hydrateFileDeliveryMetadata(messageFiles, undefined, shareId ? undefined : fileMap),
    [messageFiles, fileMap, shareId],
  );
  const imageFiles = useMemo(() => {
    return files?.filter(usesImagePreview) || [];
  }, [files]);

  const otherFiles = useMemo(() => {
    return files?.filter((file) => !usesImagePreview(file)) || [];
  }, [files]);

  const [selectedFile, setSelectedFile] = useState<Partial<TFile> | null>(null);

  const handleClose = useCallback((open: boolean) => {
    if (!open) {
      setSelectedFile(null);
    }
  }, []);

  return (
    <>
      {otherFiles.length > 0 &&
        otherFiles.map((file) => (
          <FileContainer
            key={file.file_id}
            file={file as TFile}
            onClick={() => setSelectedFile(file)}
          />
        ))}
      {imageFiles.length > 0 &&
        imageFiles.map((file) => (
          <Image
            key={file.file_id}
            alignRight
            imagePath={file.preview ?? file.filepath ?? ''}
            height={file.height ?? 1920}
            width={file.width ?? 1080}
            altText={file.filename ?? 'Uploaded Image'}
          />
        ))}
      <FilePreviewDialog
        open={selectedFile !== null}
        onOpenChange={handleClose}
        fileName={selectedFile?.filename ?? ''}
        fileId={selectedFile?.file_id}
        filePath={selectedFile?.filepath}
        fileType={selectedFile?.type ?? undefined}
        fileSource={selectedFile?.source}
        fileSize={(selectedFile as TFile)?.bytes}
        deliveryPath={selectedFile?.llmDeliveryPath}
      />
    </>
  );
};

export default memo(Files);

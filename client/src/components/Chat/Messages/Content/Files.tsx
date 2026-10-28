import { useMemo, useState, useCallback, memo } from 'react';
import type { TFile, TMessage } from 'librechat-data-provider';
import { useMessagePartsHost } from '~/Providers/MessagePartsHostContext';
import FileContainer from '~/components/Chat/Input/Files/FileContainer';
import { usesImagePreview, hydrateFileDeliveryMetadata } from '~/utils';
import FilePreviewDialog from './FilePreviewDialog';
import { useShareContext } from '~/Providers';
import Image from './Image';

const Files = ({ message }: { message?: TMessage }) => {
  const fileMap = useMessagePartsHost().useFileMap();
  const { shareId } = useShareContext();
  const files = useMemo(
    () => hydrateFileDeliveryMetadata(message?.files, undefined, shareId ? undefined : fileMap),
    [message?.files, fileMap, shareId],
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
            buttonClassName="border-surface-user-message max-w-full bg-transparent"
            containerClassName="max-w-full"
            onClick={() => setSelectedFile(file)}
          />
        ))}
      {imageFiles.length > 0 &&
        imageFiles.map((file) => (
          <Image
            key={file.file_id}
            alignRight
            className="border-surface-user-message mt-0 shadow-none"
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

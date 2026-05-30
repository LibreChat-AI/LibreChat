import { useState, useEffect, useCallback } from 'react';
import { useRecoilValue } from 'recoil';
import type { TFile } from 'librechat-data-provider';
import { useFileDownload, revokeDownloadURL, isProxyImageSource } from '~/data-provider';
import store from '~/store';
import Image from './Image';

type ImageFileProps = {
  file: Partial<TFile>;
  localPreview?: string;
  className?: string;
  alignRight?: boolean;
};

/**
 * Renders a chat image. Sources whose URLs require server-side auth (e.g. private
 * Azure Blob) cannot be loaded by an `<img>` tag. Such images render directly when
 * the container is public; when the direct load fails, the bytes are fetched through
 * the authenticated download proxy and rendered from a local `blob:` URL.
 */
const ImageFile = ({ file, localPreview, className, alignRight = false }: ImageFileProps) => {
  const user = useRecoilValue(store.user);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const canProxy = !localPreview && !!file.file_id && isProxyImageSource(file.source);

  const { refetch } = useFileDownload(user?.id ?? '', file.file_id ?? '', {
    source: file.source,
    direct: false,
  });

  const loadViaProxy = useCallback(() => {
    if (!canProxy || blobUrl) {
      return;
    }
    refetch().then((result) => {
      if (result.data) {
        setBlobUrl(result.data);
      }
    });
  }, [canProxy, blobUrl, refetch]);

  useEffect(() => {
    return () => revokeDownloadURL(blobUrl);
  }, [blobUrl]);

  return (
    <Image
      imagePath={localPreview ?? blobUrl ?? file.filepath ?? ''}
      altText={file.filename ?? 'Uploaded Image'}
      width={file.width ?? undefined}
      height={file.height ?? undefined}
      className={className}
      alignRight={alignRight}
      onError={canProxy && !blobUrl ? loadViaProxy : undefined}
    />
  );
};

export default ImageFile;

import { useState, useEffect } from 'react';
import { useRecoilValue } from 'recoil';
import { Skeleton } from '@librechat/client';
import type { TFile } from 'librechat-data-provider';
import { useFileDownload, revokeDownloadURL, isProxyImageSource } from '~/data-provider';
import store from '~/store';
import { cn } from '~/utils';
import Image from './Image';

type ImageFileProps = {
  file: Partial<TFile>;
  localPreview?: string;
  className?: string;
  alignRight?: boolean;
};

/**
 * Renders a chat image. For sources whose URLs require server-side auth (e.g.
 * private Azure Blob), the raw URL cannot be loaded by an `<img>` tag, so the
 * bytes are fetched through the authenticated download proxy and rendered from
 * a local `blob:` URL. All other sources render their URL directly.
 */
const ImageFile = ({ file, localPreview, className, alignRight = false }: ImageFileProps) => {
  const user = useRecoilValue(store.user);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const needsProxy = !localPreview && !!file.file_id && isProxyImageSource(file.source);

  const { refetch } = useFileDownload(user?.id ?? '', file.file_id ?? '', {
    source: file.source,
    direct: false,
  });

  useEffect(() => {
    if (!needsProxy) {
      return;
    }

    let active = true;
    let created: string | null = null;
    refetch().then((result) => {
      if (!active || !result.data) {
        return;
      }
      created = result.data;
      setBlobUrl(result.data);
    });

    return () => {
      active = false;
      revokeDownloadURL(created);
    };
  }, [needsProxy, file.file_id, refetch]);

  const width = file.width ?? undefined;
  const height = file.height ?? undefined;

  if (needsProxy && !blobUrl) {
    return (
      <Skeleton
        className={cn('mt-1 w-full max-w-lg rounded-lg', alignRight && 'ml-auto', className)}
        style={width && height ? { aspectRatio: `${width} / ${height}` } : { height: '12rem' }}
      />
    );
  }

  return (
    <Image
      imagePath={localPreview ?? blobUrl ?? file.filepath ?? ''}
      altText={file.filename ?? 'Uploaded Image'}
      width={width}
      height={height}
      className={className}
      alignRight={alignRight}
    />
  );
};

export default ImageFile;

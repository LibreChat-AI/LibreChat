import React, { useState, useRef, useMemo, useEffect } from 'react';
import { cn, Skeleton } from '@librechat/client';
import { apiBaseUrl } from 'librechat-data-provider';
import type { CSSProperties } from 'react';
import { toAbsoluteFilePath } from '../../core/media';
import DialogImage from './DialogImage';

/** Max display height for chat images (Tailwind JIT class) */
export const IMAGE_MAX_H = 'max-h-[45vh]' as const;

/** Caches image dimensions by src so remounts can reserve space */
const dimensionCache = new Map<string, { width: number; height: number }>();
/** Tracks URLs that have been fully painted — skip skeleton on remount */
const paintedUrls = new Set<string>();

/** Test-only: resets module-level caches */
export function _resetImageCaches(): void {
  dimensionCache.clear();
  paintedUrls.clear();
}

export interface ImageProps {
  imagePath: string;
  altText: string;
  className?: string;
  alignRight?: boolean;
  args?: {
    prompt?: string;
    quality?: 'low' | 'medium' | 'high';
    size?: string;
    style?: string;
    [key: string]: unknown;
  };
  width?: number;
  height?: number;
}

const Image = ({
  imagePath,
  altText,
  className,
  alignRight = false,
  args,
  width,
  height,
}: ImageProps): React.JSX.Element => {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  /** Root-relative server paths (`/images/...` static, `/api/...` downloads and
   *  share routes) are resolved against the API base so they load under a
   *  subpath deployment. */
  const absoluteImageUrl = useMemo(() => toAbsoluteFilePath(imagePath, apiBaseUrl()), [imagePath]);

  const downloadImage = async () => {
    try {
      const response = await fetch(absoluteImageUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.status}`);
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = url;
      link.download = altText || 'image.png';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Download failed:', error);
      const link = document.createElement('a');
      link.href = absoluteImageUrl;
      link.download = altText || 'image.png';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  useEffect(() => {
    if (width && height && absoluteImageUrl) {
      dimensionCache.set(absoluteImageUrl, { width, height });
    }
  }, [absoluteImageUrl, width, height]);

  const dims = width && height ? { width, height } : dimensionCache.get(absoluteImageUrl);
  const hasDimensions = !!(dims?.width && dims?.height);
  /** Height over width: `.chat-image-sized` reserves the box the image will fill from it. */
  const ratio = hasDimensions
    ? ({ '--chat-image-ratio': dims.height / dims.width } as CSSProperties)
    : undefined;
  const showSkeleton = hasDimensions && !paintedUrls.has(absoluteImageUrl);

  return (
    <div className={alignRight ? 'ms-auto' : undefined}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`View ${altText} in dialog`}
        aria-haspopup="dialog"
        onClick={() => setIsOpen(true)}
        className={cn(
          'border-border-light text-text-secondary-alt relative mt-1 w-full max-w-lg cursor-pointer overflow-hidden rounded-lg border shadow-md transition-shadow',
          'focus-visible:ring-text-primary focus-visible:ring-offset-surface-primary focus:outline-hidden focus-visible:ring-2 focus-visible:ring-offset-2',
          hasDimensions && 'chat-image-sized',
          className,
        )}
        style={ratio}
      >
        {showSkeleton && <Skeleton className="absolute inset-0" aria-hidden="true" />}
        <img
          alt={altText}
          src={absoluteImageUrl}
          onLoad={() => paintedUrls.add(absoluteImageUrl)}
          className={cn(
            'relative block text-transparent',
            hasDimensions
              ? 'size-full object-contain'
              : cn('h-auto w-auto max-w-full', IMAGE_MAX_H),
          )}
        />
      </button>
      <DialogImage
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        src={absoluteImageUrl}
        downloadImage={downloadImage}
        args={args}
        triggerRef={triggerRef}
      />
    </div>
  );
};

export default Image;

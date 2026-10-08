import React, { memo, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { pxToRem, ProviderIcon } from '@librechat/client';
import type { ProviderId } from 'librechat-data-provider';

/** Intrinsic fallback for parents without a definite size; `h-full w-full` scales it elsewhere. */
const FALLBACK_ICON_PX = 20;

export const URLIcon = memo(
  ({
    iconURL,
    altName,
    containerStyle = { width: pxToRem(FALLBACK_ICON_PX), height: pxToRem(FALLBACK_ICON_PX) },
    imageStyle = { width: '100%', height: '100%' },
    className = 'icon-md mr-1 shrink-0 overflow-hidden rounded-full',
    provider,
  }: {
    iconURL: string;
    altName?: string | null;
    className?: string;
    containerStyle?: React.CSSProperties;
    imageStyle?: React.CSSProperties;
    provider?: ProviderId | null;
  }) => {
    const [imageError, setImageError] = useState(false);

    const handleImageError = () => {
      setImageError(true);
    };

    if (imageError || !iconURL) {
      const numericSize =
        typeof containerStyle.width === 'number' ? containerStyle.width : undefined;
      return (
        <div className="relative" style={{ ...containerStyle, margin: pxToRem(2) }}>
          <div className={className}>
            <ProviderIcon provider={provider} size={numericSize} className="h-full w-full" />
          </div>
          {imageError && iconURL && (
            <div
              className="bg-status-error-strong absolute flex items-center justify-center rounded-full"
              style={{ width: pxToRem(14), height: pxToRem(14), top: 0, right: 0 }}
            >
              <AlertCircle className="text-text-on-status size-2.5" aria-hidden="true" />
            </div>
          )}
        </div>
      );
    }

    return (
      <div className={className} style={containerStyle}>
        <img
          src={iconURL}
          alt={altName ?? 'Icon'}
          style={imageStyle}
          className="object-cover"
          onError={handleImageError}
          loading="lazy"
          decoding="async"
          width={FALLBACK_ICON_PX}
          height={FALLBACK_ICON_PX}
        />
      </div>
    );
  },
);

URLIcon.displayName = 'URLIcon';

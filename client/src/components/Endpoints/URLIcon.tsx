import React, { memo, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { ProviderIcon } from '@librechat/client';
import type { ProviderId } from 'librechat-data-provider';

export const URLIcon = memo(
  ({
    iconURL,
    altName,
    containerStyle = { width: 20, height: 20 },
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
        <div className="relative" style={{ ...containerStyle, margin: '2px' }}>
          <div className={className}>
            <ProviderIcon provider={provider} size={numericSize} className="h-full w-full" />
          </div>
          {imageError && iconURL && (
            <div
              className="absolute flex items-center justify-center rounded-full bg-status-error-strong"
              style={{ width: '14px', height: '14px', top: 0, right: 0 }}
            >
              <AlertCircle size={10} className="text-text-on-status" aria-hidden="true" />
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
          width={Number(containerStyle.width) || 20}
          height={Number(containerStyle.height) || 20}
        />
      </div>
    );
  },
);

URLIcon.displayName = 'URLIcon';

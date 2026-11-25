import { memo, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { cn, pxToRem, ProviderIcon } from '@librechat/client';
import type { CSSProperties, NamedExoticComponent, ReactNode } from 'react';
import type { ProviderId } from 'librechat-data-provider';

/** Intrinsic fallback for parents without a definite size; `h-full w-full` scales it elsewhere. */
const FALLBACK_ICON_PX = 20;

/** What `URLIcon` draws: an image by URL, or the provider's icon when there is none or it fails. */
export type URLIconProps = {
  iconURL: string;
  altName?: string | null;
  className?: string;
  /** The icon's width and height, as a CSS length; `100%` fills the parent. */
  size?: string;
  provider?: ProviderId | null;
};

/**
 * The size is set through a custom property and applied as an important utility: a caller's
 * `className` may carry an icon class (`icon-md`) whose own size must not win, as an inline size
 * never let it.
 */
const SIZED = 'h-(--url-icon-size)! w-(--url-icon-size)!';

/** An icon loaded from a URL, falling back to the provider's icon when it cannot load. */
export const URLIcon: NamedExoticComponent<URLIconProps> = memo(
  ({
    iconURL,
    altName,
    size = pxToRem(FALLBACK_ICON_PX),
    className = 'icon-md me-1 shrink-0 overflow-hidden rounded-full',
    provider,
  }: URLIconProps): ReactNode => {
    const [imageError, setImageError] = useState(false);

    const handleImageError = () => {
      setImageError(true);
    };

    if (imageError || !iconURL) {
      return (
        <div
          className={cn('relative m-0.5', SIZED)}
          style={{ '--url-icon-size': size } as CSSProperties}
        >
          <div className={className}>
            <ProviderIcon provider={provider} className="h-full w-full" />
          </div>
          {imageError && iconURL && (
            <div
              className="bg-status-error-strong absolute inset-e-0 top-0 flex items-center justify-center rounded-full"
              style={{ width: pxToRem(14), height: pxToRem(14) }}
            >
              <AlertCircle className="text-text-on-status size-2.5" aria-hidden="true" />
            </div>
          )}
        </div>
      );
    }

    return (
      <div className={cn(className, SIZED)} style={{ '--url-icon-size': size } as CSSProperties}>
        <img
          src={iconURL}
          alt={altName ?? 'Icon'}
          className="h-full w-full object-cover"
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

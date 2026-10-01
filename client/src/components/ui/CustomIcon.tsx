import type { ReactEventHandler } from 'react';
import useAdaptiveIcon from '~/hooks/useAdaptiveIcon';
import { cn } from '~/utils';

interface CustomIconProps {
  src: string;
  alt?: string;
  className?: string;
  monochrome?: boolean;
  onError?: ReactEventHandler<HTMLImageElement>;
}

/**
 * Renders a user-provided icon (MCP `iconPath`, group `groupIcon`). Monochrome
 * SVG glyphs are masked with `currentColor` so they follow the theme; set a
 * `text-*` class to pick the tint. `object-cover` carries over as `mask-size:
 * cover`; anything else letterboxes with `contain`. `custom-icon-tint` repaints
 * the glyph under forced-colors mode (see `style.css`).
 */
export default function CustomIcon({
  src,
  alt = '',
  className,
  monochrome,
  onError,
}: CustomIconProps) {
  const { shouldTint } = useAdaptiveIcon(src, monochrome);
  const decorative = alt === '';

  if (shouldTint) {
    const maskUrl = `url("${src.replace(/["\\\n\r\f]/g, encodeURIComponent)}")`;
    const maskSize = /\bobject-cover\b/.test(className ?? '') ? 'cover' : 'contain';
    return (
      <span
        role={decorative ? undefined : 'img'}
        aria-label={decorative ? undefined : alt}
        aria-hidden={decorative ? true : undefined}
        className={cn('custom-icon-tint inline-block', className)}
        style={{
          backgroundColor: 'currentColor',
          maskImage: maskUrl,
          WebkitMaskImage: maskUrl,
          maskRepeat: 'no-repeat',
          WebkitMaskRepeat: 'no-repeat',
          maskPosition: 'center',
          WebkitMaskPosition: 'center',
          maskSize,
          WebkitMaskSize: maskSize,
        }}
      >
        {onError != null && (
          <img src={src} alt="" aria-hidden="true" className="hidden" onError={onError} />
        )}
      </span>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      aria-hidden={decorative ? true : undefined}
      className={className}
      onError={onError}
    />
  );
}

import { useEffect, useState } from 'react';
import { PixelCard, useMediaQuery } from '@librechat/client';
import type { CSSProperties } from 'react';

type Dimensions = { width?: number; height?: number };

/** Known image proportions as a width-to-height ratio, square when they are unknown. */
export function mediaImageRatio({ width, height }: Dimensions = {}): number {
  return width && height && Number.isFinite(width / height) && width > 0 && height > 0
    ? width / height
    : 1;
}

/** Match the chat image tool's maximum size at the given proportions. */
export function mediaImageWidth(ratio: number): number {
  return Math.min(512, 512 * ratio);
}

/** Pairs with `style={{ '--media-ratio': ratio, maxWidth }}` on the same element. */
export const mediaImageFrameClass = 'aspect-(--media-ratio) w-full';

/** Decorative fill only: neither elapsed time nor a full card completes a provider job. */
export function MediaImagePixels({ createdAt }: { createdAt: string }) {
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [now, setNow] = useState(Date.now);
  const parsed = Date.parse(createdAt);
  const started = Number.isFinite(parsed) ? parsed : now;
  const elapsed = Math.max(0, now - started);
  const filled = elapsed >= 60000;
  useEffect(() => {
    if (reducedMotion || filled) return;
    const interval = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(interval);
  }, [reducedMotion, filled, createdAt]);
  return (
    <PixelCard
      noFocus
      variant="default"
      randomness={0.6}
      progress={reducedMotion ? 0.88 : Math.min(0.88, 0.12 + (elapsed / 60000) * 0.76)}
      width="100%"
      height="100%"
    />
  );
}

export function MediaImagePending({
  createdAt,
  dimensions,
  label,
  hint,
}: {
  createdAt: string;
  dimensions?: Dimensions;
  label: string;
  hint: string;
}) {
  const ratio = mediaImageRatio(dimensions);
  return (
    <div role="status" aria-label={label} className="space-y-3" data-testid="media-image-pending">
      <div
        className={`relative ${mediaImageFrameClass}`}
        style={{ '--media-ratio': ratio, maxWidth: mediaImageWidth(ratio) } as CSSProperties}
        aria-hidden="true"
      >
        <div className="absolute inset-0">
          <MediaImagePixels createdAt={createdAt} />
        </div>
      </div>
      <p className="font-medium">{label}</p>
      <p className="text-text-secondary max-w-lg text-sm leading-6">{hint}</p>
    </div>
  );
}

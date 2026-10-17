import { useEffect, useMemo, useRef } from 'react';
import { XIcon } from 'lucide-react';
import { useRecoilState } from 'recoil';
import { Button, cn } from '@librechat/client';
import type { BannerVariant } from 'librechat-data-provider';
import {
  CONFIG_HTML_TEXT_TAGS,
  CONFIG_HTML_CLASS_ATTR,
  createConfigHtmlSanitizer,
} from '~/utils/configHtml';
import { useGetBannerQuery } from '~/data-provider';
import store from '~/store';

const variantClasses: Record<BannerVariant, string> = {
  info: 'border-status-info-border bg-status-info-subtle text-status-info',
  success: 'border-status-success-border bg-status-success-subtle text-status-success',
  warning: 'border-status-warning-border bg-status-warning-subtle text-status-warning',
  error: 'border-alert-error-border bg-alert-error-fill text-status-error',
  neutral: 'border-status-neutral-border bg-status-neutral-subtle text-status-neutral',
};

export const Banner = ({ onHeightChange }: { onHeightChange?: (height: number) => void }) => {
  const { data: banner } = useGetBannerQuery();
  const [hideBannerHint, setHideBannerHint] = useRecoilState<string[]>(store.hideBannerHint);
  const bannerRef = useRef<HTMLDivElement>(null);
  const sanitize = useMemo(
    () =>
      createConfigHtmlSanitizer({
        allowedTags: CONFIG_HTML_TEXT_TAGS,
        allowedAttr: CONFIG_HTML_CLASS_ATTR,
      }),
    [],
  );

  const sanitizedMessage = useMemo(() => {
    if (!banner?.message) {
      return '';
    }
    return sanitize(banner.message);
  }, [banner?.message, sanitize]);

  useEffect(() => {
    if (onHeightChange && bannerRef.current) {
      onHeightChange(bannerRef.current.offsetHeight);
    }
  }, [banner, hideBannerHint, onHeightChange]);

  if (
    !banner ||
    (banner.bannerId && !banner.persistable && hideBannerHint.includes(banner.bannerId))
  ) {
    return null;
  }

  const onClick = () => {
    if (banner.persistable) {
      return;
    }

    setHideBannerHint([...hideBannerHint, banner.bannerId]);

    if (onHeightChange) {
      onHeightChange(0);
    }
  };

  return (
    <div
      ref={bannerRef}
      className={cn(
        'sticky top-0 z-20 flex items-center px-2 py-1 md:relative',
        banner.variant
          ? cn('border-b', variantClasses[banner.variant])
          : 'bg-presentation text-text-primary',
      )}
    >
      <div
        className={cn(
          'w-full truncate text-center text-base [&_a]:underline',
          banner.variant ? '[&_a]:text-inherit' : '[&_a]:text-link',
          !banner.persistable && 'px-4',
        )}
        dangerouslySetInnerHTML={{ __html: sanitizedMessage }}
      ></div>
      {!banner.persistable && (
        <Button
          size="icon"
          variant="ghost"
          aria-label="Dismiss banner"
          className="size-8"
          onClick={onClick}
        >
          <XIcon
            className={cn('mx-auto h-4 w-4', !banner.variant && 'text-text-primary')}
            aria-hidden="true"
          />
        </Button>
      )}
    </div>
  );
};

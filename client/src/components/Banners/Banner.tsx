import { useEffect, useMemo, useRef } from 'react';
import { XIcon } from 'lucide-react';
import { useRecoilState } from 'recoil';
import { Button, cn } from '@librechat/client';
import {
  CONFIG_HTML_TEXT_TAGS,
  CONFIG_HTML_CLASS_ATTR,
  createConfigHtmlSanitizer,
} from '~/utils/configHtml';
import { useGetBannerQuery } from '~/data-provider';
import store from '~/store';

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
      className="bg-presentation text-text-primary sticky top-0 z-20 flex items-center px-2 py-1 md:relative"
    >
      <div
        className={cn(
          '[&_a]:text-link w-full truncate text-center text-base [&_a]:underline',
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
          <XIcon className="text-text-primary mx-auto h-4 w-4" aria-hidden="true" />
        </Button>
      )}
    </div>
  );
};

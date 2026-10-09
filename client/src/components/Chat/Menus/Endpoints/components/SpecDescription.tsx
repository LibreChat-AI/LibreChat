import { useMemo } from 'react';
import { createConfigHtmlSanitizer, CONFIG_HTML_MEDIA_TAGS, CONFIG_HTML_MEDIA_ATTR } from '~/utils';

interface SpecDescriptionProps {
  description?: string;
}

export default function SpecDescription({ description }: SpecDescriptionProps) {
  const sanitize = useMemo(
    () =>
      createConfigHtmlSanitizer({
        allowedTags: CONFIG_HTML_MEDIA_TAGS,
        allowedAttr: CONFIG_HTML_MEDIA_ATTR,
      }),
    [],
  );

  if (!description) {
    return null;
  }

  if (!description.trim().startsWith('<')) {
    return <span className="break-words text-xs font-normal">{description}</span>;
  }

  return (
    <span
      className="inline-flex items-center gap-1 break-words text-xs font-normal [&_img]:inline-block [&_img]:h-3.5 [&_img]:w-3.5"
      dangerouslySetInnerHTML={{ __html: sanitize(description) }}
    />
  );
}

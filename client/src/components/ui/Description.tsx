import { useMemo } from 'react';
import type { ReactElement } from 'react';
import {
  CONFIG_HTML_LINK_ATTR,
  CONFIG_HTML_MEDIA_ATTR,
  CONFIG_HTML_MEDIA_TAGS,
  CONFIG_HTML_RICH_TEXT_TAGS,
  createConfigHtmlSanitizer,
  createConfigHtmlTextSanitizer,
} from '~/utils/configHtml';

const sanitizeDescription = createConfigHtmlSanitizer({
  allowedTags: CONFIG_HTML_RICH_TEXT_TAGS,
  allowedAttr: CONFIG_HTML_LINK_ATTR,
});
const sanitizeMediaDescription = createConfigHtmlSanitizer({
  allowedTags: CONFIG_HTML_MEDIA_TAGS,
  allowedAttr: CONFIG_HTML_MEDIA_ATTR,
});
const sanitizeDescriptionText = createConfigHtmlTextSanitizer();
const descriptionHtmlTags = new Set<string>([
  ...CONFIG_HTML_RICH_TEXT_TAGS,
  ...CONFIG_HTML_MEDIA_TAGS,
]);

export function isHtmlDescription(description?: string | null): boolean {
  const firstTag = description?.trim().match(/^<\s*\/?\s*([a-z][a-z0-9]*)\b/i)?.[1];
  return firstTag ? descriptionHtmlTags.has(firstTag.toLowerCase()) : false;
}

export function getPlainDescription(description?: string | null): string {
  if (!description) {
    return '';
  }

  if (!isHtmlDescription(description)) {
    return description;
  }

  return sanitizeDescriptionText(description);
}

interface DescriptionProps {
  as?: 'div' | 'p';
  'aria-label'?: string;
  className?: string;
  description?: string | null;
  id?: string;
  allowMedia?: boolean;
  plainText?: boolean;
}

export default function Description({
  as: Element = 'div',
  className,
  description,
  id,
  allowMedia = false,
  plainText = false,
  'aria-label': ariaLabel,
}: DescriptionProps): ReactElement | null {
  const isHtml = isHtmlDescription(description);
  const content = useMemo(() => {
    if (!isHtml) {
      return description ?? '';
    }

    if (plainText) {
      return getPlainDescription(description);
    }

    return allowMedia ? sanitizeMediaDescription(description) : sanitizeDescription(description);
  }, [allowMedia, description, isHtml, plainText]);

  if (!description) {
    return null;
  }

  if (plainText || !isHtml) {
    return (
      <Element id={id} className={className} aria-label={ariaLabel}>
        {content}
      </Element>
    );
  }

  return (
    <Element
      id={id}
      className={className}
      aria-label={ariaLabel}
      dangerouslySetInnerHTML={{ __html: content }}
    />
  );
}

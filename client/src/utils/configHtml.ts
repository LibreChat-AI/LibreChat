import DOMPurify from 'dompurify';

export const CONFIG_HTML_INLINE_TAGS = ['a', 'strong', 'b', 'em', 'i', 'br', 'code'] as const;
export const CONFIG_HTML_TEXT_TAGS = [...CONFIG_HTML_INLINE_TAGS, 'span'] as const;
export const CONFIG_HTML_BLOCK_TAGS = [...CONFIG_HTML_TEXT_TAGS, 'p'] as const;
export const CONFIG_HTML_RICH_TEXT_TAGS = [
  ...CONFIG_HTML_BLOCK_TAGS,
  'div',
  'ul',
  'ol',
  'li',
] as const;
export const CONFIG_HTML_MEDIA_TAGS = [...CONFIG_HTML_TEXT_TAGS, 'img'] as const;
export const CONFIG_HTML_LINK_ATTR = ['href', 'target', 'rel'] as const;
export const CONFIG_HTML_CLASS_ATTR = [...CONFIG_HTML_LINK_ATTR, 'class'] as const;
export const CONFIG_HTML_MEDIA_ATTR = [...CONFIG_HTML_CLASS_ATTR, 'src', 'alt'] as const;

const CONFIG_HTML_SAFE_URI =
  /^(?:(?:https?|mailto|tel):|(?!(?:\s*[a-z][a-z0-9+.-]*:|\s*\/\/))[\s\S])/i;

type ConfigHtmlSanitizerOptions = {
  allowedTags?: readonly string[];
  allowedAttr?: readonly string[];
};

export function createConfigHtmlSanitizer({
  allowedTags = CONFIG_HTML_INLINE_TAGS,
  allowedAttr = CONFIG_HTML_LINK_ATTR,
}: ConfigHtmlSanitizerOptions = {}) {
  const sanitizer = DOMPurify();
  sanitizer.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });

  return (html?: string | null): string => {
    if (!html) {
      return '';
    }
    return sanitizer.sanitize(html, {
      ALLOWED_TAGS: [...allowedTags],
      ALLOWED_ATTR: [...allowedAttr],
      ALLOWED_URI_REGEXP: CONFIG_HTML_SAFE_URI,
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
    });
  };
}

export function createConfigHtmlTextSanitizer() {
  const sanitizer = DOMPurify();

  return (html?: string | null): string => {
    if (!html) {
      return '';
    }

    const fragment = sanitizer.sanitize(html, {
      ALLOWED_TAGS: [...CONFIG_HTML_RICH_TEXT_TAGS],
      ALLOWED_ATTR: [],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      RETURN_DOM_FRAGMENT: true,
    });
    for (const element of fragment.querySelectorAll('br, p, div, ul, ol, li')) {
      element.before(' ');
      element.after(' ');
    }
    return (fragment.textContent ?? '').replace(/\s+/g, ' ').trim();
  };
}

export function sanitizeConfigHtml(html?: string | null, options?: ConfigHtmlSanitizerOptions) {
  return createConfigHtmlSanitizer(options)(html);
}

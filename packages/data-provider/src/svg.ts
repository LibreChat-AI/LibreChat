/**
 * DOMPurify policy for user-provided SVG icons, shared by the browser uploader and
 * the server trust boundary so a preview and the persisted icon cannot disagree.
 * `use` is re-added for self-contained `<defs>` references (targets restricted by
 * `restrictSvgReferences`); every SMIL element is forbidden so a stored icon
 * cannot animate forever wherever it renders.
 */
export const SVG_SANITIZE_CONFIG = {
  USE_PROFILES: { svg: true, svgFilters: true },
  ADD_TAGS: ['use'],
  ADD_ATTR: ['fr'],
  FORBID_TAGS: [
    'script',
    'foreignObject',
    'style',
    'a',
    'image',
    'animate',
    'animateColor',
    'animateMotion',
    'animateTransform',
    'mpath',
    'set',
  ],
  FORBID_ATTR: ['style'],
};

/** Element surface shared by the browser DOM and the server's jsdom. */
export interface SvgAttributeHost {
  attributes: ArrayLike<{ name: string }>;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
}

const URL_TOKEN_PREFIX = /url\(\s*['"]?\s*/gi;

/**
 * True when every `url()` token targets a fragment. Backslashes reject the value
 * outright: CSS unescapes idents before tokenizing, so `u\72l(...)` is a `url()`.
 */
function referencesOnlyFragments(value: string): boolean {
  if (value.includes('\\')) {
    return false;
  }
  if (!value.toLowerCase().includes('url(')) {
    return true;
  }
  URL_TOKEN_PREFIX.lastIndex = 0;
  while (URL_TOKEN_PREFIX.exec(value) !== null) {
    if (value[URL_TOKEN_PREFIX.lastIndex] !== '#') {
      return false;
    }
  }
  return true;
}

/** DOMPurify hook that drops every attribute referencing outside the document. */
export function restrictSvgReferences(node: SvgAttributeHost): void {
  const names: string[] = [];
  for (let i = 0; i < node.attributes.length; i += 1) {
    names.push(node.attributes[i].name);
  }
  for (const name of names) {
    const value = node.getAttribute(name)?.trim();
    if (value == null) {
      continue;
    }
    if (name === 'href' || name === 'xlink:href') {
      if (!value.startsWith('#')) {
        node.removeAttribute(name);
      }
      continue;
    }
    if (!referencesOnlyFragments(value)) {
      node.removeAttribute(name);
    }
  }
}

/** SVG names the HTML parser lowercases and its adjustment table does not restore. */
const UNADJUSTED_SVG_TAGS: Array<[RegExp, string]> = [[/(<\/?)fedropshadow\b/gi, '$1feDropShadow']];

const SVG_ROOT_TAG = /<svg(\s[^>]*)?>/i;

/**
 * Makes HTML-mode sanitizer output valid as a standalone `image/svg+xml`
 * document: restores camelCase element names the HTML parser lowercased and
 * declares the SVG namespace on the root, without which an XML parser puts the
 * root in no namespace and the icon renders blank.
 */
export function finalizeSvgMarkup(markup: string): string {
  let restored = markup;
  for (const [pattern, canonical] of UNADJUSTED_SVG_TAGS) {
    restored = restored.replace(pattern, canonical);
  }
  return restored.replace(SVG_ROOT_TAG, (tag, attributes: string | undefined) =>
    attributes != null && /\sxmlns\s*=/i.test(attributes)
      ? tag
      : `<svg xmlns="http://www.w3.org/2000/svg"${attributes ?? ''}>`,
  );
}

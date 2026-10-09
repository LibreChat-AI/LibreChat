/**
 * The global the HTML shell hands to the client for answers the server already
 * has when it serves the document. Merged rather than replaced, so several
 * injections compose in any order.
 */
const BOOTSTRAP_GLOBAL = 'window.__LIBRECHAT_CONFIG__';

export interface BootstrapInjection {
  /** Attribute marking this injection's script, so serving one shell through
   *  two injectors — or the same one twice — does not stack it. */
  sentinel: string;
  values: Record<string, boolean | number | string>;
}

/**
 * Writes server-known values into the shell's `<head>` (or the top of `<body>`
 * in a document without one), ahead of the app's own scripts so the first
 * render reads them. The caller stamps the CSP nonce afterwards.
 */
export const injectBootstrapConfig = (
  html: string,
  { sentinel, values }: BootstrapInjection,
): string => {
  if (html.includes(sentinel)) {
    return html;
  }

  /** A `<` in the payload could close the inline script; it never has to be raw. */
  const payload = JSON.stringify(values).replace(/</g, '\\u003c');
  const script = `<script ${sentinel}>${BOOTSTRAP_GLOBAL}=Object.assign({},${BOOTSTRAP_GLOBAL},${payload});</script>`;

  /* Replacements are functions: a `$&`, `$1` or `$'` inside a value is data, and
     a replacement string would have `String.replace` expand it instead. */
  if (html.includes('</head>')) {
    return html.replace('</head>', () => `${script}</head>`);
  }

  return html.replace(
    /<body([^>]*)>/i,
    (_match, attributes: string) => `<body${attributes}>${script}`,
  );
};

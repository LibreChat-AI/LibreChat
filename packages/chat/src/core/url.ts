const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/**
 * Allowlist-based URL validator for markdown artifact rendering.
 * The logic body is duplicated verbatim into the generated static HTML
 * template (`EMBEDDED_IS_SAFE_URL` in the app's `client/src/utils/markdown.ts`). Any behavioral change
 * here MUST be applied to both copies. A sync-verification test in
 * `markdown.test.ts` enforces this.
 */
export const isSafeUrl = (url: string): boolean => {
  const trimmed = url.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('#') || trimmed.startsWith('.')) {
    return true;
  }
  try {
    return SAFE_PROTOCOLS.has(new URL(trimmed).protocol);
  } catch {
    return false;
  }
};

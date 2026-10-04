/**
 * Schemes a link taken out of an export may use.
 *
 * Every URL in an archive is attacker-controlled, and the citation renderers
 * put them straight into `href`/`src` (`Web/Sources.tsx`, `SourceHovercard`,
 * `Citation`) with no transform of their own. React 18 still emits
 * `javascript:` URLs (it only warns), and a shared conversation carries its
 * search results verbatim to every viewer (`SENSITIVE_SHARED_FILE_FIELDS`
 * deliberately preserves them), so an unfiltered link is stored XSS against
 * whoever opens the share.
 *
 * The filter lives here, where the source is built, rather than at each sink:
 * a dropped URL means one missing citation, where a dropped sink means a live
 * vulnerability.
 */
const SAFE_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Returns the URL when it is safe to render as a link, and `null` otherwise.
 * A relative or unparseable URL is also rejected: an export's citations are
 * always absolute, so anything else is either corrupt or crafted.
 */
export function safeSourceUrl(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }
  try {
    return SAFE_PROTOCOLS.has(new URL(url).protocol) ? url : null;
  } catch {
    return null;
  }
}

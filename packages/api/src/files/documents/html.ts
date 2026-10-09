import yauzl from 'yauzl';
import { excelMimeTypes, megabyte } from 'librechat-data-provider';
import { tryLibreOfficePreview } from './libreoffice';
import { assertSafeZipSize } from './zipSafety';

/**
 * Maximum decompressed size we'll accept from a single PPTX entry. Mirrors the
 * `ODT_MAX_DECOMPRESSED_SIZE` cap in `crud.ts` — both pptx and odt are zip
 * archives whose central directory's `uncompressedSize` cannot be trusted.
 */
const PPTX_MAX_ENTRY_SIZE = 50 * megabyte;

/** Cap on the number of slides we'll render — pathological decks bail early. */
const PPTX_MAX_SLIDES = 500;

/** Per-sheet row cap for spreadsheet rendering. Above this we truncate with a
 *  visible banner so a 100k-row sheet doesn't blow the 512KB cache cap. */
const SPREADSHEET_MAX_ROWS_PER_SHEET = 5_000;

/** Lazy-loaded `sanitize-html` module (commonjs interop). */
let sanitizeHtmlModule: typeof import('sanitize-html') | null = null;
async function getSanitizer(): Promise<typeof import('sanitize-html')> {
  if (sanitizeHtmlModule) {
    return sanitizeHtmlModule;
  }
  const mod = await import('sanitize-html');
  sanitizeHtmlModule = (mod.default ?? mod) as typeof import('sanitize-html');
  return sanitizeHtmlModule;
}

/**
 * Sanitize HTML produced by mammoth / SheetJS / our own pptx renderer for
 * embedding in the Sandpack `static` iframe. Allows the structural and
 * formatting tags those producers emit, plus inline `data:` images (mammoth
 * inlines DOCX images as base64). Strips `<script>`, `<iframe>`, event
 * handlers, `javascript:` URLs, and color-bearing inline styles.
 *
 * The Sandpack iframe is itself a sandbox — this is defense in depth, not
 * the sole barrier.
 */
export async function sanitizeOfficeHtml(html: string): Promise<string> {
  const sanitizeHtml = await getSanitizer();
  return sanitizeHtml(html, {
    allowedTags: [
      'a',
      'b',
      'blockquote',
      'br',
      'caption',
      'code',
      'col',
      'colgroup',
      'div',
      'em',
      'figure',
      'figcaption',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'hr',
      'i',
      'img',
      'li',
      'ol',
      'p',
      'pre',
      'section',
      'small',
      'span',
      'strong',
      'sub',
      'sup',
      'table',
      'tbody',
      'td',
      'tfoot',
      'th',
      'thead',
      'tr',
      'u',
      'ul',
    ],
    allowedAttributes: {
      a: ['href', 'name', 'target', 'rel', 'title'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      table: ['border', 'cellpadding', 'cellspacing', 'class'],
      td: ['colspan', 'rowspan', 'class', 'style'],
      th: ['colspan', 'rowspan', 'scope', 'class', 'style'],
      col: ['span', 'width', 'style'],
      colgroup: ['span', 'width', 'style'],
      div: ['class'],
      span: ['class'],
      section: ['class', 'aria-labelledby'],
      h1: ['id', 'class'],
      h2: ['id', 'class'],
      h3: ['id', 'class'],
      h4: ['id', 'class'],
      h5: ['id', 'class'],
      h6: ['id', 'class'],
      p: ['class'],
      ol: ['class'],
      ul: ['class'],
      li: ['class'],
      blockquote: ['class'],
      tbody: ['class'],
      thead: ['class'],
      tr: ['class'],
      tfoot: ['class'],
    },
    /* `data:` is intentionally NOT in the global scheme list — it's only
     * allowed for `<img src>` (mammoth inlines DOCX images as base64
     * `data:image/...` URIs). Without this scoping, an `<a href="data:
     * text/html,<script>…</script>">` smuggled through DOCX/PPTX would
     * survive sanitization and open attacker-controlled HTML in a new
     * tab when clicked — the Sandpack iframe sandbox doesn't gate
     * `target="_blank"` navigations. */
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: {
      img: ['http', 'https', 'data'],
    },
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, rel: 'noopener noreferrer', target: '_blank' },
      }),
    },
    /* sanitize-html runs `allowedAttributes` BEFORE per-attribute filtering, so
     * `style` only survives where we explicitly allow it (td/th/col/colgroup).
     * For those we still want to drop color declarations — defense against the
     * mammoth/SheetJS hardcoded color-on-white issue. */
    allowedStyles: {
      '*': {
        'text-align': [/^left$|^right$|^center$|^justify$/],
        'font-weight': [/^[1-9]00$|^bold$|^normal$/],
        'font-style': [/^italic$|^normal$/],
        width: [/^\d+(?:\.\d+)?(?:px|%|em|rem)?$/],
        height: [/^\d+(?:\.\d+)?(?:px|%|em|rem)?$/],
        'min-width': [/^\d+(?:\.\d+)?(?:px|%|em|rem)?$/],
        'vertical-align': [/^top$|^middle$|^bottom$|^baseline$/],
      },
    },
  });
}

/**
 * Wrap a sanitized HTML body in a complete document with the styles we want
 * inside the Sandpack iframe. The CSS palette uses `prefers-color-scheme` so
 * the iframe inherits dark/light from its parent (Sandpack iframes inherit
 * the prefers-color-scheme media query from the host document).
 */
function wrapAsDocument(bodyHtml: string, extraHeadHtml = ''): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Preview</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #1f2937;
  --muted: #6b7280;
  --border: rgba(128, 128, 128, 0.25);
  --row-alt: rgba(128, 128, 128, 0.04);
  --row-hover: rgba(59, 130, 246, 0.08);
  --header-bg: rgba(243, 244, 246, 0.95);
  --tab-active-bg: rgba(229, 231, 235, 0.95);
  --tab-bg: transparent;
  --link: #2563eb;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1a1a2e;
    --fg: #e5e7eb;
    --muted: #9ca3af;
    --border: rgba(128, 128, 128, 0.35);
    --row-alt: rgba(255, 255, 255, 0.03);
    --row-hover: rgba(59, 130, 246, 0.12);
    --header-bg: rgba(31, 41, 55, 0.95);
    --tab-active-bg: rgba(55, 65, 81, 0.95);
    --link: #60a5fa;
  }
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 14px;
  line-height: 1.5;
}
body { padding: 16px; }
a { color: var(--link); }
img { max-width: 100%; height: auto; }
h1 { font-size: 1.5rem; font-weight: 700; margin: 0.75em 0 0.5em; }
h2 { font-size: 1.25rem; font-weight: 600; margin: 0.75em 0 0.5em; }
h3 { font-size: 1.1rem;  font-weight: 600; margin: 0.5em 0 0.25em; }
h4, h5, h6 { font-weight: 600; margin: 0.5em 0 0.25em; }
p { margin: 0.4em 0; }
ul, ol { padding-left: 1.5em; margin: 0.5em 0; }
table { border-collapse: collapse; font-size: 0.85rem; line-height: 1.3; margin: 0.5em 0; max-width: 100%; }
th, td {
  border: 1px solid var(--border);
  padding: 0.4em 0.6em;
  text-align: left;
  vertical-align: top;
  white-space: nowrap;
}
thead th, table th[scope="col"] {
  background: var(--header-bg);
  font-weight: 600;
  position: sticky;
  top: 0;
  z-index: 1;
}
tbody tr:nth-child(even) { background: var(--row-alt); }
tbody tr:hover { background: var(--row-hover); }
.lc-banner {
  background: var(--row-alt);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 10px;
  margin: 0 0 8px;
  font-size: 0.8rem;
  color: var(--muted);
}
.lc-table-scroll { overflow-x: auto; max-width: 100%; }
${extraHeadHtml}
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

/* =============================================================================
 * DOCX → HTML
 * ============================================================================= */

/**
 * Style-map directives that broaden mammoth's default heading detection.
 * Mammoth's stock map only promotes paragraphs whose ms-word style name
 * matches `Heading 1`/`Heading 2`/etc. — useless for code-generated
 * docs (e.g. python-docx output) that apply direct character formatting
 * instead of named styles. The `Title`/`Subtitle` mappings catch the
 * built-in title styles used by Word's Insert > Cover Page workflow;
 * explicit `Heading 1` thru `Heading 6` mappings retain mammoth's
 * defaults; and `:fresh` tells mammoth not to merge consecutive
 * matching paragraphs into a single heading element.
 */
const DOCX_STYLE_MAP = [
  "p[style-name='Title'] => h1.lc-docx-title:fresh",
  "p[style-name='Subtitle'] => h2.lc-docx-subtitle:fresh",
  "p[style-name='Heading 1'] => h1:fresh",
  "p[style-name='Heading 2'] => h2:fresh",
  "p[style-name='Heading 3'] => h3:fresh",
  "p[style-name='Heading 4'] => h4:fresh",
  "p[style-name='Heading 5'] => h5:fresh",
  "p[style-name='Heading 6'] => h6:fresh",
  "p[style-name='Quote'] => blockquote:fresh",
];

/**
 * CSS layered on top of `wrapAsDocument`'s base styles to give mammoth's
 * flat output more visual structure. Mammoth strips the navy banners,
 * cell shading, and column layouts that direct-formatted docs apply, so
 * the source loses most of its presentation. We compensate with three
 * targeted heuristics:
 *
 *   1. The first row of any `<table>` gets sticky-header styling
 *      regardless of `<thead>` (mammoth never emits `<thead>`).
 *   2. Tables get alternating row stripes so dense data blocks stay
 *      scannable even without the source's hand-tuned shading.
 *   3. A bold-only-child paragraph (`<p><strong>X</strong></p>`) is the
 *      python-docx idiom for a "section heading"; styled as a
 *      pseudo-h2 with a thin accent border so the document's structure
 *      survives the round-trip.
 */
const DOCX_EXTRA_CSS = `
.lc-docx h1 { font-size: 1.5rem; font-weight: 700; margin: 1em 0 0.5em; padding-bottom: 0.3em; border-bottom: 2px solid var(--border); }
.lc-docx h2 { font-size: 1.2rem; font-weight: 600; margin: 1em 0 0.4em; padding-left: 0.6em; border-left: 3px solid var(--link); }
.lc-docx h3 { font-size: 1.05rem; font-weight: 600; margin: 0.8em 0 0.3em; color: var(--link); }
.lc-docx-title { text-align: center; border-bottom: none; }
.lc-docx-subtitle { text-align: center; border-left: none; padding-left: 0; color: var(--muted); font-style: italic; font-weight: 400; }
.lc-docx p { margin: 0.5em 0; }
.lc-docx p:has(> strong:only-child) { margin: 1em 0 0.4em; padding-left: 0.6em; border-left: 3px solid var(--link); font-size: 1.05rem; }
.lc-docx p:has(> strong:only-child) strong { font-weight: 600; }
.lc-docx table { width: 100%; max-width: 100%; }
.lc-docx td, .lc-docx th { white-space: normal; }
.lc-docx table tr:first-child td { background: var(--header-bg); font-weight: 600; }
.lc-docx table tr:nth-child(even):not(:first-child) td { background: var(--row-alt); }
.lc-docx ul, .lc-docx ol { margin: 0.5em 0; padding-left: 1.6em; }
.lc-docx li { margin: 0.15em 0; }
.lc-docx blockquote { border-left: 3px solid var(--border); color: var(--muted); margin: 0.8em 0; padding: 0.2em 0 0.2em 0.8em; }
`.trim();

/* =============================================================================
 * DOCX CDN renderer (high-fidelity path)
 *
 * Embeds the binary as base64 inside a self-contained HTML document and
 * relies on `docx-preview` loaded from a pinned CDN URL with SRI
 * integrity to render it inside the Sandpack iframe. The iframe is a
 * real browser DOM — `docx-preview`'s "browser-first" design is a
 * feature here, not a limitation: we get cell shading, run-level
 * colors/fonts, headers/footers, columns, and inline images at no
 * server-side parsing cost.
 *
 * Trade-offs vs the mammoth path:
 *   + Far higher visual fidelity (4/5 vs 2/5).
 *   + No server-side jsdom; no extra Node deps; iframe sandbox isolates
 *     any parser bug from the API process.
 *   − base64 inflates the binary by ~33%, so files above
 *     `MAX_DOCX_CDN_BINARY_BYTES` fall back to the mammoth path so the
 *     wrapped HTML doesn't blow the `MAX_TEXT_CACHE_BYTES` (512KB) cap
 *     on `attachment.text`. Telemetry should track how often we hit the
 *     fallback — if it's frequent, the next move is to lift the cap
 *     for office types specifically rather than embed via signed URL.
 *
 * Library + version pinning (jsdelivr SRI hashes computed at the
 * version listed; refresh by `openssl dgst -sha384 -binary FILE |
 * openssl base64 -A` on the file at the URL):
 *   docx-preview 0.3.7 — Apache-2.0, ~75KB UMD
 *   jszip 3.10.1 — MIT, ~98KB (peer dep of docx-preview)
 * Both are pinned to specific minor versions; SRI guarantees the byte
 * content can't change underneath us even if the version were ever
 * republished.
 */
const DOCX_PREVIEW_CDN = {
  jszip: {
    src: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
    integrity: 'sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG',
  },
  docxPreview: {
    src: 'https://cdn.jsdelivr.net/npm/docx-preview@0.3.7/dist/docx-preview.min.js',
    integrity: 'sha384-Fw+ZM2MtvxCe867uRzZY5GtGP+gs0NLvrlJS768RZWuKhOHMN4Fln3i3gMt1NSyQ',
  },
} as const;

/**
 * Maximum DOCX binary size (in bytes) we'll embed via the CDN-rendered
 * path. Empirical headroom: with ~33% base64 inflation and ~5KB of
 * wrapper boilerplate, 350KB of binary fits well under the 512KB
 * `MAX_TEXT_CACHE_BYTES` cap on `attachment.text` with margin to spare.
 */
const MAX_DOCX_CDN_BINARY_BYTES = 350 * 1024;

/**
 * Mirror of `MAX_TEXT_CACHE_BYTES` from `~/files/code/extract` — the
 * 512 KB ceiling that `attachment.text` is truncated to before hitting
 * the SSE wire and the database. We mirror (rather than import) to
 * avoid the cycle: `extract.ts` already imports `bufferToOfficeHtml`
 * from this module. The dispatcher uses this to drop CDN-with-fallback
 * docs that would exceed the cap and fall back to mammoth-only.
 *
 * If the upstream constant ever changes, update this value too. The
 * `cap-mirrors-extract` test in `html.spec.ts` pins the relationship.
 */
const OFFICE_HTML_OUTPUT_CAP = 512 * 1024;

/**
 * Build the CDN-rendered HTML document for a DOCX. The base64 payload
 * lives inside a `<script type="application/octet-stream;base64">`
 * — this is HTML5-spec-compliant for "data block" scripts (browsers
 * treat unrecognized script types as opaque text) and avoids any risk
 * of HTML escaping a `</script>` substring inside the binary.
 *
 * The CSP locks the page down to the pinned CDN host: scripts only
 * from jsdelivr (with SRI), no outbound `fetch`/`XHR`, no eval, images
 * only `self`/`data:`/`blob:` (docx-preview uses `URL.createObjectURL`
 * for inline images), styles inline (`docx-preview` injects per-doc
 * styles into `<head>` at render time).
 */
function buildDocxCdnDocument(base64: string, mammothFallbackHtml: string): string {
  /* `connect-src` allows fetches to:
   *   - `'self'`: the sandpack-static-server origin the iframe runs in
   *     (covers any same-origin sourcemap fetches the bundler embedded)
   *   - `https://cdn.jsdelivr.net`: where the renderer script came from
   *     (DevTools fetches `.min.js.map` from the same host as the script
   *     to map minified line numbers; with `'none'` the console fills
   *     with CSP violations every time DevTools is open)
   *
   * Exfiltration risk is minimal: the iframe is cross-origin to the
   * LibreChat host so an attacker can't read application data from it,
   * and the only meaningful target ('self' or jsdelivr) isn't useful
   * for exfiltrating slide content to a host the attacker controls. */
  const csp = [
    "default-src 'none'",
    "script-src https://cdn.jsdelivr.net 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src 'self' data: blob:",
    'font-src data:',
    "connect-src 'self' https://cdn.jsdelivr.net",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  /* Body styling for the embedded mammoth fallback. The CDN-rendered
   * path normally hides this content, but on air-gapped networks where
   * `cdn.jsdelivr.net` is blocked the fallback handler reveals it so
   * the user gets a readable preview instead of the legacy "Preview
   * unavailable" message — Codex P2 review on PR #12934. We inline the
   * shared `DOCX_EXTRA_CSS` rules here (rather than `<link>` to a
   * cross-origin sheet) because the CSP locks `style-src` to inline
   * only and the wrapped mammoth output uses the same `.lc-docx`
   * classes. */
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Preview</title>
<style>
/* Lock the docx-preview iframe to LIGHT color-scheme. docx-preview
 * is designed for page-style rendering (white pages with the docs
 * native colors). When the OS is in dark mode and we declare
 * color-scheme as both light and dark, browsers inherit dark-mode
 * colors for inheritable text properties, which made docx-previews
 * body text (no explicit color) inherit our light-grey --fg on the
 * white page bg — barely-visible translucent rendering on PR #12934
 * manual e2e. Hardcoding light keeps the page contrast right; the
 * mammoth-only path (wrapAsDocument) still respects the users OS
 * scheme since it owns its own bg + text colors. */
:root { color-scheme: light; --bg: #ffffff; --fg: #1f2937; --muted: #6b7280; --link: #2563eb; --border: #e5e7eb; --header-bg: #f3f4f6; --row-alt: #f9fafb; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
#lc-render { padding: 16px; }
#lc-fallback { padding: 24px 24px 32px; font-size: 14px; line-height: 1.5; color: var(--fg); }
#lc-fallback-notice { font-size: 12px; color: var(--muted); border-bottom: 1px solid var(--border); padding-bottom: 8px; margin: 0 0 16px; }
.lc-docx-loading { display: flex; align-items: center; justify-content: center; height: 60vh; color: var(--muted); font-size: 14px; }
${DOCX_EXTRA_CSS}
/* docx-preview emits its own per-document <style> tags inside #lc-render
 * — leave them be. These rules just keep the host frame consistent with
 * dark mode and bound the rendered document width. */
/* docx-preview wraps each section in .docx-wrapper and sets explicit
 * inline width on .docx from the source pageSize. With ignoreWidth:true
 * set on the renderer those inline widths are skipped, but we override
 * defensively so the doc fills the artifact panel even if a future
 * library version regresses. padding:0 on the wrapper drops the margin
 * docx-preview otherwise reserves for page-edge whitespace. */
#lc-render .docx-wrapper {
  background: transparent !important;
  padding: 0 !important;
  width: 100% !important;
}
#lc-render .docx-wrapper > section.docx {
  width: 100% !important;
  max-width: 100% !important;
  min-height: 0 !important;
  padding: 0 !important;
  box-shadow: none !important;
  margin: 0 0 1em 0 !important;
}
/* Removed dark-mode override here — locking the CDN doc to
 * color-scheme: light means --fg is always the light-mode dark-grey.
 * Re-introducing a dark-mode media query would override docx-previews
 * native text color and re-create the translucent rendering issue. */
</style>
<script src="${DOCX_PREVIEW_CDN.jszip.src}" integrity="${DOCX_PREVIEW_CDN.jszip.integrity}" crossorigin="anonymous"></script>
<script src="${DOCX_PREVIEW_CDN.docxPreview.src}" integrity="${DOCX_PREVIEW_CDN.docxPreview.integrity}" crossorigin="anonymous"></script>
</head>
<body>
<div id="lc-render"><div class="lc-docx-loading">Loading preview…</div></div>
<div id="lc-fallback" hidden>
<p id="lc-fallback-notice">High-fidelity renderer unavailable (CDN blocked or offline). Showing the simplified preview below.</p>
<article class="lc-docx">${mammothFallbackHtml}</article>
</div>
<script id="lc-doc-data" type="application/octet-stream;base64">${base64}</script>
<script>
(function () {
  function showFallback(reason) {
    var loading = document.querySelector('.lc-docx-loading');
    if (loading) { loading.remove(); }
    /* Hide the empty render slot so the embedded mammoth preview owns
     * the viewport — otherwise a stripe of padded empty space sits
     * above the fallback content. Codex P2 review on PR #12934. */
    var render = document.getElementById('lc-render');
    if (render) { render.hidden = true; }
    var fallback = document.getElementById('lc-fallback');
    var reasonText = reason ? String(reason).slice(0, 500) : 'no reason reported';
    if (fallback) {
      fallback.hidden = false;
      fallback.title = reasonText;
    }
    /* Mirror to DevTools so the reason is visible without inspecting
     * the title attribute or expanding details elements. */
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[docx-preview] CDN renderer fell through to mammoth:', reasonText);
    }
  }
  if (typeof docx === 'undefined' || typeof docx.renderAsync !== 'function') {
    showFallback('renderer-not-loaded');
    return;
  }
  try {
    var b64 = document.getElementById('lc-doc-data').textContent.trim();
    var bytes = Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); });
    docx.renderAsync(bytes.buffer, document.getElementById('lc-render'), null, {
      className: 'docx',
      inWrapper: true,
      /* ignoreWidth: true tells docx-preview to skip the document's
       * native page width (8.5in / 21cm typically) and render at the
       * iframe container's full width. Without this the rendered doc
       * floats with whitespace on either side in a wide artifact
       * panel — fine on letter-sized screens, ugly in our context. */
      ignoreWidth: true,
      ignoreHeight: false,
      ignoreFonts: false,
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      experimental: false,
      trimXmlDeclaration: true,
      useBase64URL: false,
      useMathMLPolyfill: false,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
    }).then(function () {
      var loading = document.querySelector('.lc-docx-loading');
      if (loading) { loading.remove(); }
    }).catch(function (err) {
      showFallback(err && err.message);
    });
  } catch (err) {
    showFallback(err && err.message);
  }
})();
</script>
</body>
</html>`;
}

/**
 * Run mammoth + sanitization to produce the inner DOCX body HTML
 * (the `<article>` contents). Shared between the standalone mammoth
 * path and the CDN path's fallback embedding so both render through
 * the exact same pipeline — no diverging sanitization rules. Codex P2
 * review on PR #12934.
 */
async function renderMammothBody(buffer: Buffer): Promise<string> {
  const { convertToHtml } = await import('mammoth');
  const result = await convertToHtml({ buffer }, { styleMap: DOCX_STYLE_MAP });
  return sanitizeOfficeHtml(result.value);
}

async function wordDocToHtmlViaCdn(buffer: Buffer, mammothFallbackBody: string): Promise<string> {
  return buildDocxCdnDocument(buffer.toString('base64'), mammothFallbackBody);
}

async function wordDocToHtmlViaMammoth(buffer: Buffer): Promise<string> {
  const sanitized = await renderMammothBody(buffer);
  return wrapAsDocument(`<article class="lc-docx">${sanitized}</article>`, DOCX_EXTRA_CSS);
}

/**
 * Whether the CDN-rendered DOCX path is enabled for this process.
 * Operators on air-gapped or filtered corporate networks (where
 * `cdn.jsdelivr.net` is blocked) should set
 * `OFFICE_PREVIEW_DISABLE_CDN=true` so DOCX previews fall back to the
 * server-side mammoth renderer instead of degrading to "Preview
 * unavailable" in the iframe — Codex P2 review on PR #12934.
 *
 * Read at call time (rather than module load) so jest tests can flip
 * the env in a `beforeEach` without `jest.resetModules()`. The cost is
 * a single property access per render. Truthy values: `true`, `1`,
 * `yes` (case-insensitive). Anything else (including unset) means
 * "use the CDN path when the size dispatcher picks it."
 */
function isOfficePreviewCdnDisabled(): boolean {
  const v = process.env.OFFICE_PREVIEW_DISABLE_CDN;
  if (v == null) {
    return false;
  }
  return /^(1|true|yes)$/i.test(v.trim());
}

/**
 * Convert a `.docx` buffer to a sandboxed HTML document. Two render
 * paths, chosen by file size:
 *
 *   1. **CDN-rendered (default for files ≤ 350 KB binary)**: embeds the
 *      binary as base64 and lets `docx-preview` render it inside the
 *      Sandpack iframe. High visual fidelity — preserves cell shading,
 *      run-level colors/fonts, headers/footers, columns, and images.
 *      The mammoth-rendered HTML is *also* embedded as a hidden
 *      `<div id="lc-fallback">` block; the iframe's bootstrap script
 *      reveals it whenever `docx-preview` fails to load (corporate
 *      firewall blocking jsdelivr, offline desktop, etc.) so air-
 *      gapped deployments still get a readable preview instead of a
 *      "Preview unavailable" message — Codex P2 review on PR #12934.
 *   2. **Mammoth-only (fallback for larger files, files where the
 *      combined CDN-doc-with-fallback would blow the cache cap, OR
 *      when the CDN path is explicitly disabled via
 *      `OFFICE_PREVIEW_DISABLE_CDN=true`)**: server-side semantic HTML
 *      conversion. Lower fidelity (flat paragraphs, no shading) but
 *      produces compact output that fits the `MAX_TEXT_CACHE_BYTES`
 *      (512 KB) cap on `attachment.text` even for large documents,
 *      and works without external network.
 *
 * Both paths pre-flight through `assertSafeZipSize` so a zip-bomb DOCX
 * is rejected before either renderer touches it — mammoth's internal
 * extraction has no decompressed-size cap and would happily inflate a
 * sub-1MB compressed bomb to 200+ MB of XML. See SEC review on PR
 * #12934 for the original DoS finding.
 */
export async function wordDocToHtml(buffer: Buffer): Promise<string> {
  await assertSafeZipSize(buffer, { name: 'docx' });
  /* Opt-in LibreOffice path: highest fidelity for any DOCX feature
   * mammoth/docx-preview can't reproduce (complex tables, drawing
   * objects, charts, embedded objects). Returns null when disabled,
   * binary missing, conversion failed, or output exceeds the cache
   * cap — falls through to the existing pipeline in any of those
   * cases so a misconfiguration doesn't break previews. */
  const lo = await tryLibreOfficePreview(buffer, 'docx', OFFICE_HTML_OUTPUT_CAP);
  if (lo) {
    return lo;
  }
  if (isOfficePreviewCdnDisabled() || buffer.length > MAX_DOCX_CDN_BINARY_BYTES) {
    return wordDocToHtmlViaMammoth(buffer);
  }
  /* Render mammoth first so its sanitized output can be embedded as
   * the iframe's air-gapped fallback. If the combined size would
   * exceed the 512 KB cache cap, drop to mammoth-only — the user
   * loses high-fidelity rendering but still sees the document. The
   * size budget applies after mammoth runs because we can't know its
   * output size from the binary size alone. */
  const mammothBody = await renderMammothBody(buffer);
  const cdnDoc = await wordDocToHtmlViaCdn(buffer, mammothBody);
  if (Buffer.byteLength(cdnDoc, 'utf-8') > OFFICE_HTML_OUTPUT_CAP) {
    return wrapAsDocument(`<article class="lc-docx">${mammothBody}</article>`, DOCX_EXTRA_CSS);
  }
  return cdnDoc;
}

/* =============================================================================
 * XLSX / XLS / ODS → HTML (multi-sheet with pure-CSS tab strip)
 * ============================================================================= */

/** A workbook sheet rendered to its `<table>` HTML and metadata. */
interface RenderedSheet {
  name: string;
  html: string;
  truncated: boolean;
  totalRows: number;
}

async function renderWorkbookSheets(
  workbook: import('xlsx').WorkBook,
  XLSX: typeof import('xlsx'),
): Promise<RenderedSheet[]> {
  const sheets: RenderedSheet[] = [];
  for (const sheetName of workbook.SheetNames) {
    const ws = workbook.Sheets[sheetName];
    const ref = ws['!ref'];
    let totalRows = 0;
    let truncated = false;
    if (ref) {
      const range = XLSX.utils.decode_range(ref);
      totalRows = range.e.r - range.s.r + 1;
      if (totalRows > SPREADSHEET_MAX_ROWS_PER_SHEET) {
        const cappedEnd = range.s.r + SPREADSHEET_MAX_ROWS_PER_SHEET - 1;
        ws['!ref'] = XLSX.utils.encode_range({
          s: range.s,
          e: { r: cappedEnd, c: range.e.c },
        });
        truncated = true;
      }
    }
    const html = XLSX.utils.sheet_to_html(ws, { editable: false, header: '', footer: '' });
    sheets.push({ name: sheetName, html, truncated, totalRows });
  }
  return sheets;
}

/**
 * Build a self-contained HTML document with a pure-CSS tab strip for
 * multi-sheet workbooks. Sheet switching uses radio inputs + `:checked ~`
 * sibling selectors so no JavaScript is needed inside the iframe.
 */
function renderSpreadsheetHtml(sheets: RenderedSheet[]): string {
  if (sheets.length === 0) {
    return wrapAsDocument('<p class="lc-banner">This workbook contains no sheets.</p>');
  }

  const tabStripCss = `
.lc-sheet-tabs { display: flex; flex-wrap: wrap; gap: 2px; padding: 0 0 8px; border-bottom: 1px solid var(--border); margin-bottom: 12px; }
.lc-sheet-tab-radio { position: absolute; opacity: 0; pointer-events: none; }
.lc-sheet-tab-label {
  cursor: pointer;
  padding: 4px 12px;
  border-radius: 6px 6px 0 0;
  font-size: 0.8rem;
  color: var(--muted);
  border: 1px solid transparent;
  border-bottom: none;
  user-select: none;
}
.lc-sheet-tab-label:hover { color: var(--fg); background: var(--row-alt); }
.lc-sheet-panel { display: none; }
${sheets
  .map(
    (_, i) =>
      `#lc-sheet-tab-${i}:checked ~ .lc-sheet-tabs label[for="lc-sheet-tab-${i}"] { color: var(--fg); background: var(--tab-active-bg); border-color: var(--border); font-weight: 600; }
#lc-sheet-tab-${i}:checked ~ #lc-sheet-panel-${i} { display: block; }`,
  )
  .join('\n')}
`.trim();

  const radios = sheets
    .map(
      (_, i) =>
        `<input type="radio" name="lc-sheet" id="lc-sheet-tab-${i}" class="lc-sheet-tab-radio"${i === 0 ? ' checked' : ''}>`,
    )
    .join('\n');

  const tabs =
    sheets.length > 1
      ? `<nav class="lc-sheet-tabs">${sheets
          .map(
            (s, i) =>
              `<label class="lc-sheet-tab-label" for="lc-sheet-tab-${i}">${escapeHtml(s.name)}</label>`,
          )
          .join('')}</nav>`
      : '';

  const panels = sheets
    .map((s, i) => {
      const banner = s.truncated
        ? `<div class="lc-banner">Showing first ${SPREADSHEET_MAX_ROWS_PER_SHEET.toLocaleString()} of ${s.totalRows.toLocaleString()} rows. Download the file to see the rest.</div>`
        : '';
      return `<section class="lc-sheet-panel" id="lc-sheet-panel-${i}">${banner}<div class="lc-table-scroll">${s.html}</div></section>`;
    })
    .join('\n');

  return wrapAsDocument(`${radios}\n${tabs}\n${panels}`, tabStripCss);
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Convert a workbook buffer (`.xlsx`, `.xls`, `.ods`) to a sandboxed HTML
 * document. Each sheet is rendered as its own `<table>` and the document
 * carries a pure-CSS tab strip for sheet switching.
 *
 * Pre-flights ZIP-backed formats (`.xlsx`/`.ods`) through
 * `assertSafeZipSize` to reject zip bombs before SheetJS reaches them.
 * `.xls` is a binary CFB format, not a ZIP — it doesn't have the
 * decompression-amplification attack surface, so the safety check is
 * skipped for it (yauzl would reject it as malformed anyway).
 */
export async function excelSheetToHtml(buffer: Buffer): Promise<string> {
  /* Cheap magic-byte check so we only run the ZIP validator on actual
   * ZIP-backed inputs. `.xls` (BIFF/CFB) starts with `D0 CF 11 E0`; ZIPs
   * start with `PK\x03\x04`. Skipping the validator on a non-ZIP input
   * also avoids confusing yauzl errors leaking out as ZipBombError. */
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    await assertSafeZipSize(buffer, { name: 'spreadsheet' });
  }
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheets = await renderWorkbookSheets(workbook, XLSX);
  /* The per-sheet HTML from `sheet_to_html` is generally well-formed but we
   * still sanitize it (defense in depth). The chrome (tab strip, banners) is
   * our own code and doesn't need sanitization. */
  const sanitizedSheets = await Promise.all(
    sheets.map(async (s) => ({ ...s, html: await sanitizeOfficeHtml(s.html) })),
  );
  return renderSpreadsheetHtml(sanitizedSheets);
}

/* =============================================================================
 * CSV → HTML
 * ============================================================================= */

/** Convert a CSV buffer to a sandboxed HTML document with a single table. */
export async function csvToHtml(buffer: Buffer): Promise<string> {
  const XLSX = await import('xlsx');
  const text = buffer.toString('utf-8');
  /* `XLSX.read` with `type: 'string'` accepts CSV as well as XML/JSON
   * formats; the default sheet name for CSV is `Sheet1` which we relabel
   * below for a friendlier tab. */
  const workbook = XLSX.read(text, { type: 'string', raw: true });
  const sheets = await renderWorkbookSheets(workbook, XLSX);
  // Single sheet for CSV — relabel to "CSV" for clarity, no tab strip emitted.
  const sanitized = await Promise.all(
    sheets.map(async (s) => ({ ...s, name: 'CSV', html: await sanitizeOfficeHtml(s.html) })),
  );
  return renderSpreadsheetHtml(sanitized);
}

/* =============================================================================
 * PPTX → slide-list HTML
 * ============================================================================= */

interface PptxSlide {
  number: number;
  title: string;
  body: string[];
}

/**
 * Stream `ppt/slides/slide*.xml` out of a PPTX buffer using yauzl. Mirrors
 * the anti-zip-bomb pattern used by `extractOdtContentXml` in `crud.ts` —
 * counts real decompressed bytes mid-inflate so a falsified central-directory
 * `uncompressedSize` cannot bypass the cap. Returns slides in slide-number
 * order; ignores everything else in the archive.
 *
 * Uses `yauzl.fromBuffer` (no disk I/O) — the safety pre-flight in
 * `assertSafeZipSize` already proved the buffer is well-formed enough
 * to walk, and fromBuffer keeps the hot path memory-only.
 */
function extractPptxSlideXml(buffer: Buffer): Promise<Array<{ number: number; xml: string }>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err) {
        return reject(err);
      }
      if (!zipfile) {
        return reject(new Error('Failed to open PPTX buffer'));
      }

      let settled = false;
      const slides: Array<{ number: number; xml: string }> = [];
      const finish = (error: Error | null) => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          zipfile.close();
        } catch {
          /* zipfile.close() is best-effort — yauzl will throw if a
           * stream is mid-flight. We've already settled the outer
           * promise, so swallow this so the original error (if any)
           * isn't replaced by a close-time exception. Mirrors
           * `assertSafeZipSize`'s defensive pattern in zipSafety.ts. */
        }
        if (error) {
          reject(error);
        } else {
          slides.sort((a, b) => a.number - b.number);
          resolve(slides);
        }
      };

      zipfile.readEntry();
      zipfile.on('entry', (entry: yauzl.Entry) => {
        const slideMatch = entry.fileName.match(/^ppt\/slides\/slide(\d+)\.xml$/);
        if (!slideMatch) {
          zipfile.readEntry();
          return;
        }
        if (slides.length >= PPTX_MAX_SLIDES) {
          // Cap reached — drain remaining entries silently.
          zipfile.readEntry();
          return;
        }
        const slideNumber = Number.parseInt(slideMatch[1], 10);
        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) {
            return finish(streamErr ?? new Error('Failed to open slide stream'));
          }

          let totalBytes = 0;
          const chunks: Buffer[] = [];

          readStream.on('data', (chunk: Buffer) => {
            totalBytes += chunk.byteLength;
            if (totalBytes > PPTX_MAX_ENTRY_SIZE) {
              readStream.destroy(
                new Error(
                  `PPTX slide${slideNumber}.xml exceeds the ${PPTX_MAX_ENTRY_SIZE / megabyte}MB decompressed limit`,
                ),
              );
              return;
            }
            chunks.push(chunk);
          });

          readStream.on('end', () => {
            slides.push({ number: slideNumber, xml: Buffer.concat(chunks).toString('utf-8') });
            zipfile.readEntry();
          });
          readStream.on('error', (readErr: Error) => finish(readErr));
        });
      });

      zipfile.on('end', () => finish(null));
      zipfile.on('error', (zipErr: Error) => finish(zipErr));
    });
  });
}

/**
 * Pull the visible text out of a slide XML. PPTX text lives in `<a:t>`
 * elements, grouped by `<a:p>` (paragraph). We keep paragraph boundaries so
 * the rendered slide preserves bullet/line structure.
 *
 * Pure regex (no DOMParser available in Node by default; the markup is
 * tightly defined by the OOXML spec, so regex is robust enough for the text-
 * only preview).
 */
function extractSlideText(xml: string): { title: string; body: string[] } {
  const paragraphs: string[] = [];
  const paragraphMatches = xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g);
  for (const match of paragraphMatches) {
    const innerXml = match[1];
    const runs: string[] = [];
    const runMatches = innerXml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g);
    for (const run of runMatches) {
      runs.push(decodeXmlEntities(run[1]));
    }
    const text = runs.join('').trim();
    if (text.length > 0) {
      paragraphs.push(text);
    }
  }
  const title = paragraphs[0] ?? '';
  const body = paragraphs.slice(1);
  return { title, body };
}

const XML_ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
  '&quot;': '"',
  '&apos;': "'",
};
function decodeXmlEntities(input: string): string {
  return input.replace(/&(?:lt|gt|amp|quot|apos);/g, (m) => XML_ENTITIES[m] ?? m);
}

/* CSS for the slide-list view. Extracted to a constant so it can also
 * be inlined into the CDN doc when the slide-list is embedded as a
 * fallback there — Codex feedback / manual e2e on PR #12934 ("pptx-
 * preview created an empty wrapper for the pptxgenjs deck"). */
const PPTX_SLIDE_LIST_CSS = `
.lc-pptx-list { display: flex; flex-direction: column; gap: 16px; padding: 0; margin: 0; list-style: none; }
.lc-pptx-slide {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px 20px;
  background: var(--bg);
  position: relative;
}
.lc-pptx-slide-number {
  display: inline-block;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
  margin-bottom: 6px;
}
.lc-pptx-slide-title { font-size: 1.15rem; font-weight: 600; margin: 0 0 8px; }
.lc-pptx-slide-body { margin: 0; padding-left: 1.25em; }
.lc-pptx-slide-body li { margin: 0.2em 0; }
.lc-pptx-slide-empty { color: var(--muted); font-style: italic; margin: 0; }
`.trim();

/**
 * Build the slide-list body HTML (just the `<ol>` element, no document
 * wrapper). Used both for standalone slide-list rendering and for
 * embedding inside the CDN doc as an air-gap / parser-failure
 * fallback — same pattern as the mammoth fallback inside the DOCX CDN
 * doc. Returns an empty-state banner for zero-slide decks.
 */
function renderPptxSlidesBody(slides: PptxSlide[]): string {
  if (slides.length === 0) {
    return '<p class="lc-banner">This presentation contains no readable slides.</p>';
  }
  const items = slides
    .map((slide) => {
      const titleHtml = slide.title
        ? `<h2 class="lc-pptx-slide-title">${escapeHtml(slide.title)}</h2>`
        : '';
      let bodyHtml = '';
      if (slide.body.length > 0) {
        bodyHtml = `<ul class="lc-pptx-slide-body">${slide.body.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`;
      } else if (!slide.title) {
        bodyHtml = '<p class="lc-pptx-slide-empty">(empty slide)</p>';
      }
      return `<li class="lc-pptx-slide">
  <span class="lc-pptx-slide-number">Slide ${slide.number}</span>
  ${titleHtml}
  ${bodyHtml}
</li>`;
    })
    .join('\n');
  return `<ol class="lc-pptx-list">${items}</ol>`;
}

function renderPptxSlidesHtml(slides: PptxSlide[]): string {
  return wrapAsDocument(renderPptxSlidesBody(slides), PPTX_SLIDE_LIST_CSS);
}

/**
 * Convert a `.pptx` buffer to a slide-list HTML document — text-only
 * preview rendering each slide as a card (slide number, title, body
 * bullets). Honest about NOT preserving complex visual layouts,
 * charts, theming, or embedded media. Used as the safe fallback path
 * when the CDN renderer is disabled, the binary exceeds the embed
 * size cap, or the high-fidelity path can't be reached.
 *
 * Pre-flights through `assertSafeZipSize` so a zip-bomb PPTX can't blow
 * up the slide-XML extraction pass.
 */
export async function pptxToSlideListHtml(buffer: Buffer): Promise<string> {
  await assertSafeZipSize(buffer, { name: 'pptx' });
  const rawSlides = await extractPptxSlideXml(buffer);
  const slides: PptxSlide[] = rawSlides.map(({ number, xml }) => {
    const { title, body } = extractSlideText(xml);
    return { number, title, body };
  });
  return renderPptxSlidesHtml(slides);
}

/* =============================================================================
 * PPTX CDN renderer (high-fidelity path)
 *
 * Mirrors the DOCX CDN architecture: embeds the binary as base64 and
 * lets `pptx-preview` (loaded from a pinned jsdelivr URL with SRI) do
 * the rendering inside the Sandpack iframe. The library is ISC-licensed
 * (npm package permits commercial use) and ships a UMD bundle that
 * exposes a global `pptxPreview.init(container, options)` →
 * `previewer.preview(arrayBuffer)` API per the package README.
 *
 * Trade-offs vs the slide-list path:
 *   + Far higher visual fidelity — preserves slide layouts, theme
 *     colors, fonts, basic shape positioning, embedded images.
 *   + No server-side rendering cost; iframe sandbox isolates parser
 *     bugs from the API process.
 *   − UMD bundle is ~1.36 MB (contains echarts, tslib, lodash, uuid,
 *     jszip). Loaded once per iframe lifetime; browser-cached after.
 *   − Renderer hasn't been broadly browser-tested by us across the
 *     full spectrum of decks. See PR #12934 commit notes — fallback
 *     paths cover the cases where we hit a class of files that don't
 *     render: client-side "Preview unavailable" UX (CDN unreachable
 *     or `typeof pptxPreview === 'undefined'`) and the
 *     `OFFICE_PREVIEW_DISABLE_CDN` env-var hatch (forces the slide-
 *     list server-side).
 */
const PPTX_PREVIEW_CDN = {
  pptxPreview: {
    src: 'https://cdn.jsdelivr.net/npm/pptx-preview@1.0.7/dist/pptx-preview.umd.js',
    integrity: 'sha384-CwntHHT2FbwZXuCmbf6K93YaEB9xRVVLaqFJ7pdMykeQABb/3MA0sbt2lGbgi1Mr',
  },
} as const;

/**
 * Same 350 KB binary cap as DOCX — keeps the base64-inflated wrapped
 * HTML under `MAX_TEXT_CACHE_BYTES` (512 KB) on `attachment.text`.
 * PPTX files often exceed this once embedded media is involved; the
 * dispatcher's slide-list fallback handles the larger cases.
 */
const MAX_PPTX_CDN_BINARY_BYTES = 350 * 1024;

/**
 * Build the CDN-rendered HTML document for a PPTX. Same wrapper shape
 * and CSP as the DOCX equivalent — see `buildDocxCdnDocument` for the
 * security-relevant rationale on script-src/connect-src/base-uri/etc.
 *
 * Slides need a fixed-size container for `pptx-preview` to render into
 * — it computes per-slide layouts against the configured width/height
 * rather than against the iframe's variable size. We use 960×540
 * (16:9 standard) and let CSS scale the rendered output to fit the
 * iframe via `transform: scale(...)`. The slides scroll vertically
 * once the renderer paints them.
 */
function buildPptxCdnDocument(base64: string, slideListFallbackBody: string): string {
  /* PPTX-specific CSP relaxations vs DOCX:
   *   - `worker-src blob:` — pptx-preview's bundled echarts dep spins up
   *     Web Workers via blob: URLs for chart rendering. Without this,
   *     workers default to `default-src 'none'`, get blocked, and
   *     echarts throws an unhandled-rejection deep inside its async
   *     pipeline that we can't catch from the bootstrap script. The
   *     visible symptom is a black iframe with the renderer half-
   *     started. Allowing blob:-only workers is the minimum surface to
   *     unblock rendering without permitting arbitrary worker URLs. */
  /* `connect-src` allows fetches to:
   *   - `'self'`: the sandpack-static-server origin the iframe runs in
   *     (covers any same-origin fetches pptx-preview or its bundled
   *     echarts make at render time, plus same-origin sourcemap loads)
   *   - `https://cdn.jsdelivr.net`: where the renderer script came from
   *     (DevTools fetches `.min.js.map` from there to map minified
   *     line numbers; with `'none'` the console fills with CSP
   *     violations every time DevTools is open)
   *
   * Exfiltration risk is minimal: the iframe is cross-origin to the
   * LibreChat host so an attacker can't read application data, and
   * the only meaningful targets ('self' or jsdelivr) aren't useful
   * for exfiltrating slide content to a host the attacker controls. */
  const csp = [
    "default-src 'none'",
    "script-src https://cdn.jsdelivr.net 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'worker-src blob:',
    "img-src 'self' data: blob:",
    'font-src data:',
    "connect-src 'self' https://cdn.jsdelivr.net",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Preview</title>
<style>
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1f2937; --muted: #6b7280; }
@media (prefers-color-scheme: dark) { :root { --bg: #1a1a2e; --fg: #e5e7eb; --muted: #9ca3af; } }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
#lc-render { padding: 16px; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; gap: 16px; }
/* Each rendered slide is wrapped post-hoc by the bootstrap script in
 * an .lc-slide-wrap div with explicit width/height set inline. The
 * inner slide keeps its native pixel size and gets transformed via
 * a CSS scale so it fits the iframe width without horizontal
 * scrolling. Without this, pptx-preview emits slides at whatever
 * resolution it computed against (typically 960×540) and overflows
 * narrow panels — manual e2e feedback on PR #12934. */
.lc-slide-wrap {
  position: relative;
  margin: 0 auto;
  overflow: hidden;
  background: #ffffff;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
  border-radius: 4px;
  flex-shrink: 0;
}
.lc-slide-wrap > * {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: top left;
}
#lc-fallback { padding: 16px; font-size: 14px; line-height: 1.5; color: var(--fg); }
#lc-fallback-notice { font-size: 12px; color: var(--muted); border-bottom: 1px solid var(--border); padding-bottom: 8px; margin: 0 0 16px; }
.lc-pptx-loading { display: flex; align-items: center; justify-content: center; height: 60vh; color: var(--muted); font-size: 14px; }
/* Slide-list fallback styles. Inlined here so the fallback renders
 * with the same look as the standalone slide-list path when the CDN
 * renderer fails. CSS variable defaults match wrapAsDocument so
 * dark-mode borders/muted text resolve sensibly. */
:root { --border: rgba(128, 128, 128, 0.25); --link: #2563eb; }
@media (prefers-color-scheme: dark) { :root { --border: rgba(128, 128, 128, 0.35); --link: #60a5fa; } }
${PPTX_SLIDE_LIST_CSS}
</style>
<script src="${PPTX_PREVIEW_CDN.pptxPreview.src}" integrity="${PPTX_PREVIEW_CDN.pptxPreview.integrity}" crossorigin="anonymous"></script>
</head>
<body>
<div id="lc-render"><div class="lc-pptx-loading">Loading preview…</div></div>
<div id="lc-fallback" hidden>
  <p id="lc-fallback-notice">High-fidelity renderer unavailable or returned no slide content. Showing the simplified slide-list view below.</p>
  ${slideListFallbackBody}
  <details style="font-size: 12px; color: var(--muted); margin: 16px 0 0;">
    <summary style="cursor: pointer;">Diagnostic details</summary>
    <div id="lc-fallback-reason" style="margin-top: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-word;"></div>
  </details>
</div>
<script id="lc-doc-data" type="application/octet-stream;base64">${base64}</script>
<script>
(function () {
  var settled = false;
  function showFallback(reason) {
    if (settled) { return; }
    settled = true;
    var loading = document.querySelector('.lc-pptx-loading');
    if (loading) { loading.remove(); }
    var container = document.getElementById('lc-render');
    if (container) {
      /* Hide the render slot (which may contain pptx-previews
       * empty/black wrappers) so the slide-list fallback owns the
       * viewport. */
      container.hidden = true;
      container.innerHTML = '';
    }
    var fallback = document.getElementById('lc-fallback');
    var reasonText = reason ? String(reason).slice(0, 500) : 'no reason reported';
    if (fallback) {
      fallback.hidden = false;
      /* Title (hover tooltip) AND inline diagnostic block. The block
       * is folded behind a details element so the friendly message
       * stays the primary read but the reason is one click away —
       * no need to open DevTools to figure out why a preview failed. */
      fallback.title = reasonText;
      var reasonEl = document.getElementById('lc-fallback-reason');
      if (reasonEl) { reasonEl.textContent = reasonText; }
    }
    /* Mirror to DevTools so power users see the reason in red without
     * having to find and expand the details element. The console
     * message survives even after the iframe is detached. */
    if (typeof console !== 'undefined' && console.error) {
      console.error('[pptx-preview] fallback fired:', reasonText);
    }
  }
  function markSuccess() { settled = true; }
  function renderedSlideCount() {
    return container ? container.querySelectorAll('.pptx-preview-slide-wrapper').length : 0;
  }

  /* pptx-preview bundled deps (echarts, etc.) raise rejections deep
   * inside their async pipelines that the outer Promise from
   * previewer.preview does not always surface. Listen at the window
   * level so we do not go silent on any of them. */
  window.addEventListener('unhandledrejection', function (e) {
    if (settled) { return; }
    showFallback((e.reason && e.reason.message) || 'unhandled-rejection');
  });
  window.addEventListener('error', function (e) {
    if (settled) { return; }
    showFallback((e.error && e.error.message) || e.message || 'script-error');
  });

  if (typeof pptxPreview === 'undefined' || typeof pptxPreview.init !== 'function') {
    showFallback('renderer-not-loaded');
    return;
  }
  try {
    var b64 = document.getElementById('lc-doc-data').textContent.trim();
    var bytes = Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); });
    var container = document.getElementById('lc-render');
    var loading = document.querySelector('.lc-pptx-loading');
    if (loading) { loading.remove(); }
    /* pptx-preview renders into a fixed pixel size; we keep it at the
     * native 16:9 default so its internal layout calculations are
     * right, then post-process to scale each slide to the iframe's
     * width via CSS transform. */
    var SLIDE_W = 960, SLIDE_H = 540;
    /* Hide the container while pptx-preview renders so the user
     * doesnt see the unscaled 960px-wide flash. We reveal once
     * wrap+scale has settled. */
    container.style.visibility = 'hidden';
    var previewer = pptxPreview.init(container, { width: SLIDE_W, height: SLIDE_H });

    function availableWidth() {
      /* clientWidth includes the 16px padding on each side via
       * box-sizing:border-box; we subtract both so the wrap exactly
       * fills the content box without spilling into padding. */
      var w = (container.clientWidth || window.innerWidth) - 32;
      return w > 0 ? w : 600;
    }

    /* Width-only scale: each slide divides the panel width by its
     * actual rendered native width, so we always fill the panel
     * horizontally. No upscale cap — pptx-preview rasterizes against
     * the init canvas (960×540), text/charts are vector or canvas-
     * rendered, so they stay legible when scaled up.
     *
     * NOTE: a previous iteration tried min(width-fit, height-fit) to
     * also fill the panel vertically. That broke pptx-previews
     * rendering (slides came out as solid black rectangles). The
     * librarys internal layout interacts unpredictably with min-height
     * 100vh on the document root and viewport-derived height
     * calculations during its CSS injection step. Sticking to
     * width-only keeps rendering reliable; vertical empty space below
     * a short deck shows the bodys bg color, which inherits from
     * var(--bg) and matches the panel theme — manual e2e feedback on
     * PR #12934. */
    function scaleFor(nativeW) {
      return availableWidth() / (nativeW || SLIDE_W);
    }

    /* Wrap each rendered slide and apply the scale. Called ONCE,
     * after pptx-preview is done — wrapping during streaming would
     * move slides out from under the librarys references and break
     * its internal state. */
    function wrapSlides() {
      var children = Array.prototype.slice.call(container.children);
      for (var i = 0; i < children.length; i++) {
        var slide = children[i];
        if (!slide.classList || slide.classList.contains('lc-slide-wrap') || slide.classList.contains('lc-pptx-loading')) {
          continue;
        }
        /* Cache the slides actual rendered size BEFORE applying any
         * transform — measurements after a CSS scale no longer reflect
         * native pixels and would feed back into wrong sizing on
         * resize. */
        var nativeW = slide.offsetWidth || SLIDE_W;
        var nativeH = slide.offsetHeight || SLIDE_H;
        if (slide.dataset) {
          slide.dataset.lcNativeW = String(nativeW);
          slide.dataset.lcNativeH = String(nativeH);
        }
        var scale = scaleFor(nativeW);
        var wrap = document.createElement('div');
        wrap.className = 'lc-slide-wrap';
        wrap.style.width = (nativeW * scale) + 'px';
        wrap.style.height = (nativeH * scale) + 'px';
        slide.style.transformOrigin = 'top left';
        slide.style.transform = 'scale(' + scale + ')';
        container.insertBefore(wrap, slide);
        wrap.appendChild(slide);
      }
    }

    /* Re-fit existing wraps on iframe resize (panel drag, window
     * resize). Reads the cached native dimensions from the slides
     * dataset so we never re-measure an already-scaled box. */
    function refit() {
      var wraps = container.querySelectorAll('.lc-slide-wrap');
      for (var i = 0; i < wraps.length; i++) {
        var wrap = wraps[i];
        var inner = wrap.firstElementChild;
        if (!inner || !inner.dataset) { continue; }
        var nativeW = parseFloat(inner.dataset.lcNativeW) || SLIDE_W;
        var nativeH = parseFloat(inner.dataset.lcNativeH) || SLIDE_H;
        var scale = scaleFor(nativeW);
        wrap.style.width = (nativeW * scale) + 'px';
        wrap.style.height = (nativeH * scale) + 'px';
        inner.style.transform = 'scale(' + scale + ')';
      }
    }

    /* Detect the silent-failure case: pptx-preview resolves without
     * rendering any real slide nodes. Common with pptxgenjs-generated
     * PPTXs — the parser creates an empty host wrapper, but never
     * populates pptx-preview slide nodes with slide content.
     * Manual e2e on PR #12934. */
    function hasRenderedContent() {
      var slides = container.querySelectorAll('.pptx-preview-slide-wrapper');
      if (slides.length === 0) { return false; }
      for (var i = 0; i < slides.length; i++) {
        if (slides[i].children.length > 0 || (slides[i].textContent || '').trim().length > 0) {
          return true;
        }
      }
      return false;
    }

    function finalize() {
      wrapSlides();
      if (!hasRenderedContent()) {
        showFallback('renderer-empty-slide-list');
        return;
      }
      container.style.visibility = 'visible';
      /* Resize observer set up AFTER the wrap so it doesnt fire
       * during the wrap pass. */
      if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(refit).observe(document.body);
      } else {
        window.addEventListener('resize', refit);
      }
      markSuccess();
    }

    var result = previewer.preview(bytes.buffer);
    if (result && typeof result.then === 'function') {
      result
        .then(function (pptx) {
          if (!pptx || !pptx.slides || pptx.slides.length === 0) {
            showFallback('renderer-empty-slide-list');
            return;
          }
          finalize();
        })
        .catch(function (err) { showFallback(err && err.message); });
    }
    /* Safety net: if 8 seconds in the preview promise hasnt resolved,
     * accept whatever pptx-preview managed to render and apply the
     * wrap+scale to it. Empty container → fallback. */
    setTimeout(function () {
      if (settled) { return; }
      if (renderedSlideCount() > 0) {
        finalize();
        return;
      }
      showFallback('renderer-timeout');
    }, 8000);
  } catch (err) {
    showFallback(err && err.message);
  }
})();
</script>
</body>
</html>`;
}

/**
 * Render the slide-list body (just the `<ol>` HTML) for a buffer.
 * Used by `pptxToHtml` to embed as a fallback inside the CDN doc and
 * by `pptxToSlideListHtmlInternal` for the standalone path. */
async function renderPptxSlidesBodyForBuffer(buffer: Buffer): Promise<string> {
  const rawSlides = await extractPptxSlideXml(buffer);
  const slides: PptxSlide[] = rawSlides.map(({ number, xml }) => {
    const { title, body } = extractSlideText(xml);
    return { number, title, body };
  });
  return renderPptxSlidesBody(slides);
}

async function pptxToHtmlViaCdn(buffer: Buffer, slideListFallbackBody: string): Promise<string> {
  return buildPptxCdnDocument(buffer.toString('base64'), slideListFallbackBody);
}

/**
 * Convert a `.pptx` buffer to a sandboxed HTML document. Two render
 * paths, chosen by file size and the `OFFICE_PREVIEW_DISABLE_CDN`
 * escape hatch:
 *
 *   1. **CDN-rendered (default for files ≤ 350 KB binary)**: embeds
 *      the binary as base64 and lets `pptx-preview` render it inside
 *      the Sandpack iframe. High visual fidelity.
 *   2. **Slide-list (fallback)**: server-side text-only extraction
 *      (each slide → card with title + bullets). Lower fidelity but
 *      compact, network-independent, and proven against arbitrary
 *      decks. Triggered when the binary exceeds the embed cap, when
 *      `OFFICE_PREVIEW_DISABLE_CDN=true` is set (air-gapped /
 *      filtered networks), or when the CDN script fails to load
 *      (handled iframe-side).
 *
 * Pre-flights through `assertSafeZipSize` so a zip-bomb PPTX is
 * rejected before either renderer touches it.
 */
export async function pptxToHtml(buffer: Buffer): Promise<string> {
  await assertSafeZipSize(buffer, { name: 'pptx' });
  /* Opt-in LibreOffice path: PDF rendering of slides preserves layout,
   * fonts, charts, and embedded objects far better than the slide-list
   * fallback or even pptx-preview's canvas approach. Falls through on
   * any error per the contract in `tryLibreOfficePreview`. */
  const lo = await tryLibreOfficePreview(buffer, 'pptx', OFFICE_HTML_OUTPUT_CAP);
  if (lo) {
    return lo;
  }
  if (isOfficePreviewCdnDisabled() || buffer.length > MAX_PPTX_CDN_BINARY_BYTES) {
    return pptxToSlideListHtmlInternal(buffer);
  }
  /* Render the slide-list first so we can embed it inside the CDN doc
   * as a runtime fallback. pptx-preview is unreliable on PPTXs not
   * generated by Microsoft PowerPoint (e.g. pptxgenjs decks) — it
   * silently produces empty wrappers. The iframe bootstrap detects
   * the empty-render case and reveals this slide-list fallback so the
   * user always gets readable content. Manual e2e on PR #12934. */
  const slideListBody = await renderPptxSlidesBodyForBuffer(buffer);
  const cdnDoc = await pptxToHtmlViaCdn(buffer, slideListBody);
  /* Combined size budget: if base64 binary + slide-list fallback +
   * wrapper would exceed the cache cap, drop CDN entirely and ship
   * the slide-list standalone. Same pattern as the DOCX dispatcher's
   * size budget. */
  if (Buffer.byteLength(cdnDoc, 'utf-8') > OFFICE_HTML_OUTPUT_CAP) {
    return pptxToSlideListHtmlInternal(buffer);
  }
  return cdnDoc;
}

/**
 * Slide-list path that skips its own `assertSafeZipSize` call — used
 * by `pptxToHtml` after the dispatcher has already validated the
 * buffer. `pptxToSlideListHtml` (public, validating) stays the entry
 * point for tests and direct callers.
 */
async function pptxToSlideListHtmlInternal(buffer: Buffer): Promise<string> {
  const rawSlides = await extractPptxSlideXml(buffer);
  const slides: PptxSlide[] = rawSlides.map(({ number, xml }) => {
    const { title, body } = extractSlideText(xml);
    return { number, title, body };
  });
  return renderPptxSlidesHtml(slides);
}

/**
 * Test-only re-exports. Each path has distinct visual-fidelity and
 * size characteristics that warrant direct testing rather than
 * round-tripping through the size-based dispatcher with synthetically
 * padded fixtures. Not part of the public API — callers in production
 * code should always go through `wordDocToHtml` / `pptxToHtml`.
 */
export const _internal: {
  wordDocToHtmlViaCdn: typeof wordDocToHtmlViaCdn;
  wordDocToHtmlViaMammoth: typeof wordDocToHtmlViaMammoth;
  MAX_DOCX_CDN_BINARY_BYTES: number;
  OFFICE_HTML_OUTPUT_CAP: number;
  pptxToHtmlViaCdn: typeof pptxToHtmlViaCdn;
  MAX_PPTX_CDN_BINARY_BYTES: number;
} = {
  wordDocToHtmlViaCdn,
  wordDocToHtmlViaMammoth,
  MAX_DOCX_CDN_BINARY_BYTES,
  OFFICE_HTML_OUTPUT_CAP,
  pptxToHtmlViaCdn,
  MAX_PPTX_CDN_BINARY_BYTES,
};

/* =============================================================================
 * Dispatcher
 * ============================================================================= */

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const POTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.template';
const ODS_MIME = 'application/vnd.oasis.opendocument.spreadsheet';
const CSV_MIME_PATTERN = /^(text\/csv|application\/csv|text\/comma-separated-values)$/i;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) {
    return '';
  }
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Strip MIME parameters (`; charset=utf-8`, `; boundary=...`) and
 * lowercase the result so exact-match MIME comparisons survive servers
 * and tool sandboxes that decorate Content-Type headers. Without this,
 * an extensionless `text/csv; charset=utf-8` would slip past the bucket
 * predicate (returning null) while the client's MIME router — which
 * already strips parameters via `baseMime` — would route it to
 * SPREADSHEET expecting an HTML body that the backend never produced.
 * Mirrors `client/src/utils/artifacts.ts:baseMime`.
 */
function baseMime(mime: string): string {
  if (!mime) {
    return '';
  }
  const semi = mime.indexOf(';');
  return (semi < 0 ? mime : mime.slice(0, semi)).trim().toLowerCase();
}

/**
 * The four buckets the dispatcher can route to. Used by both
 * `bufferToOfficeHtml` (which actually renders) and `officeHtmlBucket`
 * (which the upstream gate in `extract.ts` calls to decide whether to
 * invoke the dispatcher at all). Sharing one source of truth prevents the
 * gate from going out of sync with the dispatcher — a previous version
 * had a narrower extension-only gate that missed extensionless office
 * files identified solely by MIME (e.g. a tool emitting `data` with
 * `text/csv`), which then routed to the SPREADSHEET bucket on the
 * client expecting full HTML and got raw text instead.
 */
export type OfficeHtmlBucket = 'docx' | 'spreadsheet' | 'csv' | 'presentation';

const OFFICE_EXTENSIONS: Record<string, OfficeHtmlBucket> = {
  docx: 'docx',
  csv: 'csv',
  xlsx: 'spreadsheet',
  xls: 'spreadsheet',
  ods: 'spreadsheet',
  pptx: 'presentation',
  potx: 'presentation',
};

/**
 * Classify a file by extension OR MIME into the bucket the office HTML
 * dispatcher would route it to, or `null` if no producer applies.
 *
 * **Extension always wins** over MIME for any known office extension.
 * Without this precedence, a `deck.pptx` whose `Content-Type` was
 * mislabeled `text/csv` (a known footgun when tool sandboxes ship
 * generic MIMEs) would be routed to `csvToHtml` and try to parse a
 * binary PPTX as CSV — yielding garbage at best, a parse exception at
 * worst.
 *
 * **MIME fallback fires ONLY when the extension is empty.** This
 * mirrors the client's `detectArtifactTypeFromFile` precedence: the
 * client routes any file with a known non-office extension (`.txt`,
 * `.md`, `.json`, etc.) to its non-office bucket REGARDLESS of MIME.
 * If the server produced office HTML for `.txt + DOCX MIME`, the
 * client would route by extension to PLAIN_TEXT, escape the HTML
 * through the markdown viewer, and the user would see raw `<html>...`
 * markup instead of the rendered preview. Codex P2 review on PR
 * #12934 — symmetric server/client extension precedence is the only
 * way to avoid this kind of mismatch without a shared routing table.
 *
 * Trade-off: a true DOCX renamed to `myfile.bin` + DOCX MIME no longer
 * routes through office HTML on the server (it falls to the existing
 * extract path → `textFormat: 'text'` → client renders raw bytes via
 * PLAIN_TEXT). Acceptable: extension-vs-MIME mismatch is user error,
 * and the previous behavior would have surfaced as a security-gate
 * fall-through to PLAIN_TEXT on the client anyway (no preview either
 * way; the new behavior just avoids producing HTML the client can't
 * use).
 */
export function officeHtmlBucket(name: string, mimeType: string): OfficeHtmlBucket | null {
  const ext = extensionOf(name);
  const byExtension = OFFICE_EXTENSIONS[ext];
  if (byExtension) {
    return byExtension;
  }
  if (ext !== '') {
    /* Non-empty non-office extension wins — see contract above. */
    return null;
  }
  /* MIME fallback for genuinely extensionless files (tool-emitted
   * blobs with generic names, etc.). Strip parameters first —
   * Content-Type headers routinely carry `; charset=utf-8` or
   * `; boundary=...` decorations that would otherwise fail exact-
   * match comparisons. */
  const normalized = baseMime(mimeType);
  if (normalized === DOCX_MIME) {
    return 'docx';
  }
  if (CSV_MIME_PATTERN.test(normalized)) {
    return 'csv';
  }
  if (excelMimeTypes.test(normalized) || normalized === ODS_MIME) {
    return 'spreadsheet';
  }
  if (normalized === PPTX_MIME || normalized === POTX_MIME) {
    return 'presentation';
  }
  return null;
}

/**
 * Route an office-format buffer to the matching HTML producer. Returns `null`
 * if the file isn't a recognized office type — caller should fall through to
 * its existing text/binary handling.
 */
export async function bufferToOfficeHtml(
  buffer: Buffer,
  name: string,
  mimeType: string,
): Promise<string | null> {
  const bucket = officeHtmlBucket(name, mimeType);
  switch (bucket) {
    case 'docx':
      return wordDocToHtml(buffer);
    case 'csv':
      return csvToHtml(buffer);
    case 'spreadsheet':
      return excelSheetToHtml(buffer);
    case 'presentation':
      return pptxToHtml(buffer);
    default:
      return null;
  }
}

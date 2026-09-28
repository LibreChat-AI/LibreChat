import { highContrastDarkTheme, highContrastLightTheme } from '@librechat/client';
import type { IThemeRGB } from '@librechat/client';

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/**
 * Allowlist-based URL validator for markdown artifact rendering.
 * The logic body is duplicated verbatim into the generated static HTML
 * template (`EMBEDDED_IS_SAFE_URL` constant below). Any behavioral change
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

const markdownCSS = `
/* GitHub Markdown CSS - Light theme base */
.markdown-body {
  -ms-text-size-adjust: 100%;
  -webkit-text-size-adjust: 100%;
  line-height: 1.5;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
  font-size: 16px;
  line-height: 1.5;
  word-wrap: break-word;
  color: #24292f;
  background-color: #ffffff;
}

.markdown-body h1, .markdown-body h2 {
  border-bottom: 1px solid #d0d7de;
  margin: 0.6em 0;
}

.markdown-body h1 { font-size: 2em; margin: 0.67em 0; }
.markdown-body h2 { font-size: 1.5em; }
.markdown-body h3 { font-size: 1.25em; }
.markdown-body h4 { font-size: 1em; }
.markdown-body h5 { font-size: 0.875em; }
.markdown-body h6 { font-size: 0.85em; }

.markdown-body ul, .markdown-body ol {
  list-style: revert !important;
  padding-left: 2em !important;
  margin-top: 0;
  margin-bottom: 16px;
}

.markdown-body ul { list-style-type: disc !important; }
.markdown-body ol { list-style-type: decimal !important; }
.markdown-body ul ul { list-style-type: circle !important; }
.markdown-body ul ul ul { list-style-type: square !important; }

.markdown-body li { margin-top: 0.25em; }

.markdown-body li:has(> input[type="checkbox"]) {
  list-style-type: none !important;
}

.markdown-body li > input[type="checkbox"] {
  margin-right: 0.75em;
  margin-left: -1.5em;
  vertical-align: middle;
  pointer-events: none;
  width: 16px;
  height: 16px;
}

.markdown-body .task-list-item {
  list-style-type: none !important;
}

.markdown-body .task-list-item > input[type="checkbox"] {
  margin-right: 0.75em;
  margin-left: -1.5em;
  vertical-align: middle;
  pointer-events: none;
  width: 16px;
  height: 16px;
}

.markdown-body code {
  padding: 0.2em 0.4em;
  margin: 0;
  font-size: 85%;
  border-radius: 6px;
  background-color: rgba(175, 184, 193, 0.2);
  color: #24292f;
  font-family: ui-monospace, monospace;
  white-space: pre-wrap;
}

.markdown-body pre {
  padding: 16px;
  overflow: auto;
  font-size: 85%;
  line-height: 1.45;
  border-radius: 6px;
  margin-top: 0;
  margin-bottom: 16px;
  background-color: #f6f8fa;
  color: #24292f;
}

.markdown-body pre code {
  display: inline-block;
  padding: 0;
  margin: 0;
  overflow: visible;
  line-height: inherit;
  word-wrap: normal;
  background-color: transparent;
  border: 0;
}

.markdown-body a {
  text-decoration: none;
  color: #0969da;
}

.markdown-body a:hover {
  text-decoration: underline;
}

.markdown-body table {
  border-spacing: 0;
  border-collapse: collapse;
  display: block;
  width: max-content;
  max-width: 100%;
  overflow: auto;
}

.markdown-body table thead {
  background-color: #f6f8fa;
}

.markdown-body table th, .markdown-body table td {
  padding: 6px 13px;
  border: 1px solid #d0d7de;
}

.markdown-body blockquote {
  padding: 0 1em;
  border-left: 0.25em solid #d0d7de;
  margin: 0 0 16px 0;
  color: #57606a;
}

.markdown-body hr {
  height: 0.25em;
  padding: 0;
  margin: 24px 0;
  border: 0;
  background-color: #d0d7de;
}

.markdown-body img {
  max-width: 100%;
  box-sizing: content-box;
}

/* Rendered in place of the document when the marked CDN does not load. Its own
   rule rather than an inline style so a contrast mode can reach it. */
.markdown-error {
  color: #e53e3e;
  padding: 1rem;
}

/* Dark theme */
@media (prefers-color-scheme: dark) {
  .markdown-body {
    color: #c9d1d9;
    background-color: #0d1117;
  }

  .markdown-body h1, .markdown-body h2 {
    border-bottom-color: #21262d;
  }

  .markdown-body code {
    background-color: rgba(110, 118, 129, 0.4);
    color: #c9d1d9;
  }

  .markdown-body pre {
    background-color: #161b22;
    color: #c9d1d9;
  }

  .markdown-body a {
    color: #58a6ff;
  }

  .markdown-body table thead {
    background-color: #161b22;
  }

  .markdown-body table th, .markdown-body table td {
    border-color: #30363d;
  }

  .markdown-body blockquote {
    border-left-color: #3b434b;
    color: #8b949e;
  }

  .markdown-body hr {
    background-color: #21262d;
  }
}

/* Scrollbar */
::-webkit-scrollbar { height: 0.1em; width: 0.5rem; }
::-webkit-scrollbar-thumb { background-color: rgba(0,0,0,0.1); border-radius: 9999px; }
::-webkit-scrollbar-track { background-color: transparent; border-radius: 9999px; }
@media (prefers-color-scheme: dark) {
  ::-webkit-scrollbar-thumb { background-color: hsla(0,0%,100%,0.1); }
}
* { scrollbar-width: thin; scrollbar-color: rgba(0,0,0,0.1) transparent; }
@media (prefers-color-scheme: dark) {
  * { scrollbar-color: hsla(0,0%,100%,0.1) transparent; }
}
`;

/**
 * Escapes content for safe embedding inside a JS template literal that
 * lives within an HTML `<script>` block. Prevents the content from
 * breaking out of the template literal or prematurely closing the
 * surrounding `<script>` tag (which would allow arbitrary HTML injection).
 */
function escapeForTemplateLiteral(content: string): string {
  return content
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/<\/script/gi, '<\\/script');
}

const MARKED_CDN = 'https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js';
const MARKED_SRI = 'sha384-948ahk4ZmxYVYOc+rxN1H2gM1EJ2Duhp7uHtZ4WSLkV4Vtx5MUqnV+l7u9B+jFv+';

/**
 * Embedded JS copy of `isSafeUrl`. Keep in sync with the exported
 * TypeScript version above — `markdown.test.ts` has a sync-verification
 * test that will break if the two copies diverge.
 */
export const EMBEDDED_IS_SAFE_URL = `const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const isSafeUrl = (url) => {
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('/') || trimmed.startsWith('#') || trimmed.startsWith('.')) return true;
  try { return SAFE_PROTOCOLS.has(new URL(trimmed).protocol); } catch(e) { return false; }
};`;

/**
 * The stylesheet above is a fixed GitHub palette selected by the iframe's own
 * `prefers-color-scheme`, which no app token reaches. In a contrast mode this
 * block is appended unconditionally, so it also overrides that media query and
 * an explicit contrast choice is honoured whatever the OS is set to. Every
 * colour the media query sets has to be answered here, including the `thead`
 * tint: leaving it would strand #f6f8fa or #161b22 under the new ink. Contrast
 * palettes collapse subtle fills onto the canvas, so the header reads through
 * its bold cells and its border rather than a tint of its own.
 */
function contrastMarkdownCSS(isDarkMode: boolean): string {
  const palette = isDarkMode ? highContrastDarkTheme : highContrastLightTheme;
  const hex = (token: keyof IThemeRGB, fallback: string): string => {
    const channels = palette[token]?.trim().split(/\s+/).map(Number);
    if (channels?.length !== 3 || channels.some(Number.isNaN)) {
      return fallback;
    }
    return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
  };

  const canvas = hex('rgb-surface-primary', isDarkMode ? '#000000' : '#ffffff');
  const ink = hex('rgb-text-primary', isDarkMode ? '#ffffff' : '#000000');
  const link = hex('rgb-link', isDarkMode ? '#8cc8ff' : '#0000cc');
  const border = hex('rgb-border-medium', ink);
  const codeFill = hex('rgb-surface-secondary', canvas);
  /** The renderer-failure notice is the one message this document paints itself,
   *  and it has to survive a CDN outage inside a contrast mode. */
  const destructive = hex('rgb-text-destructive', isDarkMode ? '#ff8f8f' : '#a10000');

  return `
.markdown-body { color: ${ink}; background-color: ${canvas}; }
body { background-color: ${canvas}; }
.markdown-body h1, .markdown-body h2 { border-bottom-color: ${border}; }
.markdown-body a, .markdown-body a:hover { color: ${link}; text-decoration: underline; }
.markdown-body table th, .markdown-body table td { border-color: ${border}; }
.markdown-body table thead { background-color: ${canvas}; }
.markdown-body blockquote { border-left-color: ${border}; color: ${ink}; }
.markdown-body hr { background-color: ${border}; }
.markdown-body code, .markdown-body pre { color: ${ink}; background-color: ${codeFill}; }
.markdown-body pre { border: 1px solid ${border}; }
::-webkit-scrollbar-thumb { background-color: ${ink}; }
* { scrollbar-color: ${ink} ${canvas}; }
.markdown-error { color: ${destructive}; }
`;
}

function generateMarkdownHtml(content: string, contrastCSS = ''): string {
  const normalizedContent = content.replace(/^( {2})(-|\d+\.)/gm, '    $2');
  const escapedContent = escapeForTemplateLiteral(normalizedContent);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Markdown Preview</title>
<style>${markdownCSS}${contrastCSS}</style>
</head>
<body>
<div class="markdown-body" id="content" style="padding:2rem;margin:1rem;min-height:100vh"></div>
<script src="${MARKED_CDN}" integrity="${MARKED_SRI}" crossorigin="anonymous"></script>
<script>
if (typeof marked === 'undefined') {
  document.getElementById('content').innerHTML =
    '<p class="markdown-error">Markdown renderer failed to load. Check network connectivity.</p>';
} else {
${EMBEDDED_IS_SAFE_URL}
marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    html() { return ''; },
    link(token) {
      if (!isSafeUrl(token.href || '')) return '';
      return false; // fall through to marked's default link renderer
    },
    image(token) {
      if (!isSafeUrl(token.href || '')) return '';
      return false; // fall through to marked's default image renderer
    }
  }
});
document.getElementById('content').innerHTML = marked.parse(\`${escapedContent}\`);
}
</script>
</body>
</html>`;
}

export const getMarkdownFiles = (
  content: string,
  isDarkMode = false,
  highContrast = false,
): Record<string, string> => {
  const md = content || '# No content provided';
  return {
    'content.md': md,
    'index.html': generateMarkdownHtml(md, highContrast ? contrastMarkdownCSS(isDarkMode) : ''),
  };
};

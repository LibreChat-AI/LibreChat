import { VisualBridgeMethod } from 'librechat-data-provider';
import type { VisualTheme } from './theme';

/*
 * The theme bootstrap, size reporting and document injection are adapted from T3 Code's HTML
 * renders (MIT, https://github.com/pingdotgg/t3code, `packages/shared/src/htmlRender.ts`).
 */

const STYLE_ID = 'librechat-visual-theme';

/**
 * Defaults for plain elements, so a page that uses them unstyled matches the app. Every rule but
 * the root ones sits in `:where()`, which has no specificity, so any rule the page writes wins.
 */
const BASE_CSS = [
  'html{color:var(--foreground);font-family:var(--font-sans);font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}',
  'body{margin:0}',
  ':where(*,*::before,*::after){box-sizing:border-box}',
  ':where(code,kbd,pre,samp){font-family:var(--font-mono);font-size:.9em}',
  ':where(code,kbd){padding:.1em .35em;border-radius:calc(var(--radius) * .6);background:color-mix(in srgb,var(--foreground) 8%,transparent)}',
  ':where(h1,h2,h3,h4){margin:0 0 .5em;line-height:1.25;font-weight:650;letter-spacing:-.01em}',
  ':where(h1){font-size:1.5em}:where(h2){font-size:1.25em}:where(h3,h4){font-size:1.05em}',
  ':where(p){margin:0 0 .75em}',
  ':where(a){color:var(--chart-1);text-underline-offset:.15em}',
  ':where(mark){padding:0 .2em;border-radius:.2em;color:inherit;background:color-mix(in srgb,var(--chart-4) 30%,transparent)}',
  ':where(hr){margin:1em 0;border:0;border-top:1px solid var(--border)}',
  ':where(button,input,select,textarea){font:inherit;color:inherit}',
  ':where(button){padding:.45em .95em;border:1px solid var(--border);border-radius:var(--radius);background:var(--card);font-weight:500;cursor:pointer;box-shadow:0 1px 2px color-mix(in srgb,var(--foreground) 8%,transparent)}',
  ':where(button:hover:not(:disabled)){border-color:color-mix(in srgb,var(--chart-1) 45%,var(--border));background:color-mix(in srgb,var(--chart-1) 8%,var(--card))}',
  ':where(button:disabled){opacity:.5;cursor:default}',
  ':where([aria-pressed=true],[aria-selected=true],[aria-current]:not([aria-current=false])){border-color:var(--chart-1);background:color-mix(in srgb,var(--chart-1) 14%,var(--card));color:var(--foreground)}',
  ':where(input:not([type=range],[type=checkbox],[type=radio],[type=color]),select,textarea){padding:.4em .6em;border:1px solid var(--border);border-radius:var(--radius);background:var(--background)}',
  ':where(input,progress,meter){accent-color:var(--chart-1)}',
  ':where(progress){width:100%;height:.5em;border:0;border-radius:999px;overflow:hidden;background:color-mix(in srgb,var(--foreground) 10%,transparent)}',
  ':where(progress)::-webkit-progress-bar{background:color-mix(in srgb,var(--foreground) 10%,transparent)}:where(progress)::-webkit-progress-value{border-radius:999px;background:var(--chart-1)}:where(progress)::-moz-progress-bar{border-radius:999px;background:var(--chart-1)}',
  ':where(details){padding:.6em .9em;border:1px solid var(--border);border-radius:var(--radius)}:where(summary){font-weight:600;cursor:pointer}',
  ':where(button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible){outline:2px solid var(--chart-1);outline-offset:2px}',
  ':where(table){width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}',
  ':where(th,td){padding:.55em .75em;border-bottom:1px solid var(--border);text-align:left}',
  ':where(th){color:var(--muted-foreground);font-size:.85em;font-weight:600;letter-spacing:.02em;background:color-mix(in srgb,var(--foreground) 5%,transparent)}',
  ':where(tbody tr:hover){background:color-mix(in srgb,var(--chart-1) 5%,transparent)}',
  '@media (prefers-reduced-motion:no-preference){:where(button){transition:background-color .15s,border-color .15s,transform .1s}:where(button:active:not(:disabled)){transform:translateY(1px)}}',
].join('');

const VARIABLE_NAME = /^--[a-z0-9-]+$/;

/** Values come from the app's computed style, but the rule is still written into a page. */
const sanitizeValue = (value: string) => value.replace(/[;{}<>]/g, '');

export function visualThemeCss(theme: VisualTheme): string {
  const declarations = Object.entries(theme.variables)
    .filter(([name]) => VARIABLE_NAME.test(name))
    .map(([name, value]) => `${name}:${sanitizeValue(value)};`)
    .join('');
  return `:root{color-scheme:${theme.appearance};${declarations}}${BASE_CSS}`;
}

/** The notification the host posts into a mounted visual when the app theme changes. */
export function visualThemeMessage(theme: VisualTheme) {
  return {
    jsonrpc: '2.0',
    method: VisualBridgeMethod.hostContextChanged,
    params: { css: visualThemeCss(theme) },
  } as const;
}

/**
 * Runs first in `<head>`. It swaps its own `<style>` for the CSS a theme update carries (so a
 * page's later `:root` rules still win) and fires `themechange` for canvas charts to redraw. A clicked http(s)
 * link is handed to the host instead of navigating the frame. The content height is measured the
 * way T3 does: `scrollHeight` only while the page overflows the frame, else the root's own box,
 * so the frame can shrink again.
 */
const BOOTSTRAP_SCRIPT = `(function(){var s=document.getElementById(${JSON.stringify(STYLE_ID)}),h;if(!s||window.parent===window)return;window.addEventListener("message",function(e){var d=e.data,p=d&&d.params;if(e.source!==window.parent||!d||d.jsonrpc!=="2.0"||d.method!==${JSON.stringify(VisualBridgeMethod.hostContextChanged)}||!p||typeof p.css!=="string")return;s.textContent=p.css;window.dispatchEvent(new Event("themechange"));});document.addEventListener("click",function(e){var l=e.isTrusted?e.composedPath().find(function(t){return t&&t.matches&&t.matches("a[href]");}):null,u;if(!l)return;try{u=new URL(l.getAttribute("href"),document.baseURI);}catch(x){return;}if(!/^https?:$/.test(u.protocol))return;e.preventDefault();window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(VisualBridgeMethod.openLink)},params:{url:u.href}},"*");},true);var z=function(){var r=document.documentElement,v=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(v===h)return;h=v;window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(VisualBridgeMethod.sizeChanged)},params:{height:v}},"*");},o=window.ResizeObserver?new ResizeObserver(z):null;if(o)o.observe(document.documentElement);document.addEventListener("DOMContentLoaded",function(){if(o&&document.body)o.observe(document.body);z();});window.addEventListener("load",z);})();`;

function bootstrapMarkup(theme: VisualTheme, scan: string): string {
  return [
    /<meta\s[^>]*charset/i.test(scan.slice(0, 4096)) ? '' : '<meta charset="utf-8">',
    /<meta\s[^>]*name\s*=\s*["']?viewport/i.test(scan)
      ? ''
      : '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style id="${STYLE_ID}">${visualThemeCss(theme)}</style>`,
    `<script>${BOOTSTRAP_SCRIPT}</script>`,
  ].join('');
}

/**
 * Comments, raw-text elements and template contents are blanked to the same length, so offsets
 * still line up and a `<head>` inside one of them cannot receive the bootstrap.
 */
function blankNonMarkup(html: string): string {
  const scan = html.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)|<plaintext\b[\s\S]*$/gi,
    (match) => ' '.repeat(match.length),
  );
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let at = 0;
  for (const match of scan.matchAll(/<(\/?)template(?:\s[^>]*)?\/?>/gi)) {
    if (!match[1]) {
      if (depth++ === 0) {
        start = match.index ?? 0;
      }
    } else if (depth > 0 && --depth === 0) {
      const end = (match.index ?? 0) + match[0].length;
      parts.push(scan.slice(at, start), ' '.repeat(end - start));
      at = end;
    }
  }
  if (depth > 0) {
    parts.push(scan.slice(at, start), ' '.repeat(scan.length - start));
    at = scan.length;
  }
  parts.push(scan.slice(at));
  return parts.join('');
}

/** Inserts the bootstrap at the start of the document head, ahead of the page's own styles. */
export function injectVisualBootstrap(html: string, theme: VisualTheme): string {
  const scan = blankNonMarkup(html);
  const markup = bootstrapMarkup(theme, scan);
  const headOpen = /<head(?:\s[^>]*)?>/i.exec(scan);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + markup + html.slice(at);
  }
  const htmlOpen = /<html(?:\s[^>]*)?>/i.exec(scan);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) {
    const at = doctype[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  return `<!doctype html><head>${markup}</head>${html}`;
}

/** The params of a JSON-RPC message from a visual for `method`, if `data` is one. */
export function readBridgeParams(
  data: unknown,
  method: (typeof VisualBridgeMethod)[keyof typeof VisualBridgeMethod],
): Record<string, unknown> | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }
  const message = data as { jsonrpc?: unknown; method?: unknown; params?: unknown };
  if (message.jsonrpc !== '2.0' || message.method !== method) {
    return undefined;
  }
  return typeof message.params === 'object' && message.params !== null
    ? (message.params as Record<string, unknown>)
    : {};
}

/** The height a size report carries; the host validates and clamps it. */
export function readContentHeight(data: unknown): number | undefined {
  const height = readBridgeParams(data, VisualBridgeMethod.sizeChanged)?.height;
  return typeof height === 'number' ? height : undefined;
}

export function readLinkRequest(data: unknown): string | undefined {
  const url = readBridgeParams(data, VisualBridgeMethod.openLink)?.url;
  if (typeof url !== 'string') {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

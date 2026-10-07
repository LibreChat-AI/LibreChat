/**
 * Finds colour literals in CSS. The design lint reads JSX, so a stylesheet under
 * `client/src` or `packages/client/src` is outside it; this is the gate for those files.
 * A colour belongs to a theme role (`rgb(var(--black) / 0.1)`), so only the custom properties of the theme
 * token sources and the rules `packages/client/src/theme/allowlist.md` records may hold a literal, and a
 * channel triplet (`--x: 255 0 0`) is a literal in a custom property, so it lives in those sources too.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';

export interface CssColorFinding {
  line: number;
  literal: string;
}

export const CSS_ROOTS = ['client/src', 'packages/client/src'];

/** Theme token sources (allowlist.md entry 1): their custom property declarations may hold a literal or a channel triplet. */
export const CSS_COLOR_ALLOWED_FILES = [
  'packages/client/src/theme/defaults.css',
  'packages/client/src/theme/tokens.css',
];

/** Rules that may hold a literal in an otherwise checked file: the Azure brand gradient (entry 2) and the select arrow's inline SVG (entry 9). */
export interface AllowedRule {
  selector: string;
  /** Limits the exception to one property of the rule; every other declaration is still checked. */
  property?: string;
}

export const CSS_COLOR_ALLOWED_RULES: Record<string, AllowedRule[]> = {
  'client/src/mobile.css': [{ selector: '.azure-bg-color' }],
  'client/src/style.css': [{ selector: 'select', property: 'background-image' }],
};

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'locales']);

const NAMED_COLORS =
  'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'.split(
    ' ',
  );

const HEX = /#[0-9a-fA-F]{3,8}(?![\w-])/g;
const FUNCTION =
  /(?<![\w-])(?:(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*var\(\s*--[\w-]+\s*,\s*[\d.+-]|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*(?:[\d.+-]|none\b|(?:calc|min|max|clamp|abs|sign|round|mod|rem|sin|cos|tan|asin|acos|atan2?|pow|sqrt|hypot|log|exp)\(|(?:var\([^)]*\)\s*,?\s*)+[\d.+-])|color\(\s*(?!from\b)[a-z0-9-]+\s+(?:(?:var\([^)]*\)\s*,?\s*)*[\d.+-]|none\b))/gi;
const RELATIVE_COLOR = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(\s*from\s+/gi;
const CHANNEL_KEYWORD = /(?<![\w-])(?:[rgbhslwcaxyz]|alpha)(?![\w-])/i;
const TRIPLET = /^\s*[\d.]+(?:\s*,\s*|\s+)[\d.]+(?:\s*,\s*|\s+)[\d.]+(?:\s*\/\s*[\d.]+%?)?\s*$/;
const NAMED = new RegExp(`(?<![\\w.-])(?:${NAMED_COLORS.join('|')})(?![\\w.-])`, 'gi');
/** Properties whose values are identifiers or names, where a colour keyword is not a colour. */
const NON_COLOR_PROPERTY =
  /^(?:font|animation|transition|grid|counter|content|will-change|view-transition|container|src|list-style|quotes|cursor|appearance|mask-(?:mode|type|composite|repeat|clip|origin|position|size)|clip|anchor|position-anchor|scroll-timeline|view-timeline|timeline-scope)/i;

const blank = (match: string): string => match.replace(/[^\n]/g, ' ');

const URL_FUNCTION = /url\(\s*(?:"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|[^)]*)\)/gi;
const STRING = /"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'/g;

function decodePayload(payload: string): string {
  const separator = payload.indexOf(',');
  const header = payload.slice(0, separator);
  const body = payload.slice(separator + 1);
  if (/;base64$/i.test(header)) return Buffer.from(body, 'base64').toString('utf8');
  try {
    return decodeURIComponent(body);
  } catch {
    return body;
  }
}

/** An inline image keeps its payload, decoded, because it cannot read a theme variable. */
function inlineImagePayload(url: string): string {
  const payload = url.replace(/^url\(\s*["']?/i, '').replace(/["']?\s*\)$/, '');
  if (!/^data:image\/svg\+xml/i.test(payload)) return blank(url);
  return decodePayload(payload).replace(/["';]/g, ' ');
}

/** The value with strings and external urls blanked; newlines survive so offsets keep their line. */
function colourText(value: string): string {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(URL_FUNCTION, inlineImagePayload)
    .replace(STRING, blank);
}

interface Token {
  text: string;
  end: number;
}

/** The top-level, space-separated tokens of a function body, up to its closing parenthesis or the alpha slash. */
function relativeTokens(text: string, start: number): Token[] {
  const tokens: Token[] = [];
  let depth = 0;
  let tokenStart = -1;
  const close = (end: number): void => {
    if (tokenStart >= 0) tokens.push({ text: text.slice(tokenStart, end), end });
    tokenStart = -1;
  };
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (depth === 0 && (char === ')' || char === '/')) {
      close(i);
      return tokens;
    }
    if (depth === 0 && /[\s,]/.test(char)) {
      close(i);
      continue;
    }
    if (tokenStart < 0) tokenStart = i;
    if (char === '(') depth++;
    if (char === ')') depth--;
  }
  close(text.length);
  return tokens;
}

const isFixedChannel = (channel: string): boolean =>
  /^[\d.+-]/.test(channel) ||
  /^none$/i.test(channel) ||
  (/^[\w-]+\(/.test(channel) && !/^var\(/i.test(channel) && !CHANNEL_KEYWORD.test(channel));

/**
 * A relative colour keeps its origin's channels by name (`r g b`); a number, `none` or a function
 * that names no channel replaces one with a fixed value, so the colour no longer follows the theme.
 * The alpha after the slash is not a colour channel.
 */
function relativeLiterals(text: string): Array<{ literal: string; offset: number }> {
  return Array.from(text.matchAll(RELATIVE_COLOR)).flatMap((match) => {
    const offset = match.index ?? 0;
    const bodyStart = offset + match[0].length;
    const isColorFunction = /^color\(/i.test(match[0]);
    const [, ...rest] = relativeTokens(text, bodyStart);
    const channels = rest.slice(isColorFunction ? 1 : 0, isColorFunction ? 4 : 3);
    const fixed = channels.find((channel) => isFixedChannel(channel.text));
    return fixed ? [{ literal: text.slice(offset, fixed.end), offset }] : [];
  });
}

function literalsIn(property: string, value: string): Array<{ literal: string; offset: number }> {
  const text = colourText(value);
  const patterns = NON_COLOR_PROPERTY.test(property) ? [HEX, FUNCTION] : [HEX, FUNCTION, NAMED];
  return [
    ...patterns.flatMap((pattern) =>
      Array.from(text.matchAll(pattern), (match) => ({
        literal: match[0],
        offset: match.index ?? 0,
      })),
    ),
    ...relativeLiterals(text),
  ];
}

const isAllowed = (allowedRules: AllowedRule[], selector: string, property: string): boolean =>
  allowedRules.some(
    (rule) =>
      rule.selector === selector && (rule.property === undefined || rule.property === property),
  );

/**
 * Parses the stylesheet so a declaration is read whole, whatever lines it spans or shares.
 * A token source may declare custom properties with literals and channel triplets, so
 * `tokenSource` skips those declarations and still checks every other one.
 */
export function findCssColorLiterals(
  css: string,
  allowedRules: AllowedRule[] = [],
  tokenSource = false,
): CssColorFinding[] {
  const findings: CssColorFinding[] = [];
  postcss.parse(css).walkDecls((declaration) => {
    const isCustomProperty = declaration.prop.startsWith('--');
    if (tokenSource && isCustomProperty) return;
    const parent = declaration.parent;
    const selector = parent?.type === 'rule' ? parent.selector : '';
    if (isAllowed(allowedRules, selector, declaration.prop)) return;
    const line = declaration.source?.start?.line ?? 1;
    if (isCustomProperty && TRIPLET.test(colourText(declaration.value))) {
      findings.push({ line, literal: declaration.value.trim() });
      return;
    }
    literalsIn(declaration.prop, declaration.value).forEach(({ literal, offset }) => {
      const before = colourText(declaration.value).slice(0, offset);
      findings.push({ line: line + before.split('\n').length - 1, literal });
    });
  });
  return findings;
}

function listCssFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (SKIPPED_DIRECTORIES.has(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listCssFiles(path);
    return entry.name.endsWith('.css') ? [path] : [];
  });
}

/** Every finding, as `path:line literal` lines; the token sources are read for everything but their custom properties. */
export function scanCssColors(root: string): string[] {
  return CSS_ROOTS.flatMap((directory) => listCssFiles(join(root, directory)))
    .map((path) => relative(root, path).split('\\').join('/'))
    .flatMap((path) =>
      findCssColorLiterals(
        readFileSync(join(root, path), 'utf8'),
        CSS_COLOR_ALLOWED_RULES[path],
        CSS_COLOR_ALLOWED_FILES.includes(path),
      ).map(({ line, literal }) => `${path}:${line} ${literal}`),
    );
}

/** `node scripts/css-colors.mts`: prints each finding and exits 1 when there is one. */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = scanCssColors(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  if (findings.length > 0) {
    const rules = Object.entries(CSS_COLOR_ALLOWED_RULES)
      .map(([file, allowed]) => `${allowed.map(({ selector }) => selector).join(', ')} in ${file}`)
      .join(', ');
    console.error(findings.join('\n'));
    console.error(
      'Use a theme variable, for example rgb(var(--black) / 0.1), instead of a colour literal.',
    );
    console.error(
      `Only ${CSS_COLOR_ALLOWED_FILES.join(', ')} and ${rules} may hold one; see packages/client/src/theme/allowlist.md.`,
    );
    process.exit(1);
  }
}

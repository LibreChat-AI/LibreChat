/**
 * Finds colour literals in CSS. The design lint reads JSX, so a stylesheet under
 * `client/src` or `packages/client/src` is outside it; this is the gate for those files.
 * A colour belongs to a theme role (`rgb(var(--black) / 0.1)`), so only the theme token
 * sources and the files `packages/client/src/theme/allowlist.md` records may hold a literal.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import postcss from 'postcss';

export interface CssColorFinding {
  line: number;
  literal: string;
}

export const CSS_ROOTS = ['client/src', 'packages/client/src'];

/** Theme token sources (allowlist.md entry 1). */
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
  /(?<![\w-])(?:(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*from\s+(?:var\([^)]*\)|[^\s)]+)\s+[\d.+-]|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*(?:[\d.+-]|none\b|(?:calc|min|max|clamp|abs|sign|round|mod|rem|sin|cos|tan|asin|acos|atan2?|pow|sqrt|hypot|log|exp)\(|(?:var\([^)]*\)\s*,?\s*)+[\d.+-])|color\(\s*(?!from\b)[a-z0-9-]+\s+(?:(?:var\([^)]*\)\s*,?\s*)*[\d.+-]|none\b))/gi;
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

function literalsIn(property: string, value: string): Array<{ literal: string; offset: number }> {
  const text = colourText(value);
  const patterns = NON_COLOR_PROPERTY.test(property) ? [HEX, FUNCTION] : [HEX, FUNCTION, NAMED];
  return patterns.flatMap((pattern) =>
    Array.from(text.matchAll(pattern), (match) => ({
      literal: match[0],
      offset: match.index ?? 0,
    })),
  );
}

const isAllowed = (allowedRules: AllowedRule[], selector: string, property: string): boolean =>
  allowedRules.some(
    (rule) =>
      rule.selector === selector && (rule.property === undefined || rule.property === property),
  );

/** Parses the stylesheet so a declaration is read whole, whatever lines it spans or shares. */
export function findCssColorLiterals(
  css: string,
  allowedRules: AllowedRule[] = [],
): CssColorFinding[] {
  const findings: CssColorFinding[] = [];
  postcss.parse(css).walkDecls((declaration) => {
    const parent = declaration.parent;
    const selector = parent?.type === 'rule' ? parent.selector : '';
    if (isAllowed(allowedRules, selector, declaration.prop)) return;
    const line = declaration.source?.start?.line ?? 1;
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

/** Every finding outside the allowed files, as `path:line literal` lines. */
export function scanCssColors(root: string): string[] {
  return CSS_ROOTS.flatMap((directory) => listCssFiles(join(root, directory)))
    .map((path) => relative(root, path).split('\\').join('/'))
    .filter((path) => !CSS_COLOR_ALLOWED_FILES.includes(path))
    .flatMap((path) =>
      findCssColorLiterals(
        readFileSync(join(root, path), 'utf8'),
        CSS_COLOR_ALLOWED_RULES[path],
      ).map(({ line, literal }) => `${path}:${line} ${literal}`),
    );
}

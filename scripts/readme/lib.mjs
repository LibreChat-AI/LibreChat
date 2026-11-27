import { createHash } from 'node:crypto';
import GithubSlugger from 'github-slugger';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

export const LANGUAGES = {
  zh: {
    name: 'Simplified Chinese',
    label: '中文',
    file: 'README.zh.md',
    script: /\p{Script=Han}/u,
    fullwidth: true,
  },
  ru: { name: 'Russian', label: 'Русский', file: 'README.ru.md', script: /\p{Script=Cyrillic}/u },
};

export const GLOSSARY = [
  'LibreChat',
  'Agents',
  'MCP',
  'Artifacts',
  'Skills',
  'Subagents',
  'Code Interpreter',
  'OpenAI',
  'Anthropic',
  'Docker',
  'Helm',
  'Railway',
  'Sealos',
  'API',
  'RAG',
  'URL',
  'SDK',
  'OAuth',
  'JSON',
  'YAML',
  'CLI',
  'npm',
  'GitHub',
  'Discord',
  'YouTube',
];

export const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

const GLOSSARY_PATTERN = new RegExp(
  `\\b(?:${GLOSSARY.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?:['’]s|s)?\\b`,
  'gi',
);
const MIN_WORDS_FOR_CONTENT_CHECK = 3;
const MIN_LENGTH_RATIO = 0.2;
const MAX_UNTRANSLATED_SHARE = 0.6;
const TEXT_ATTRIBUTE = /(?<![\w-])(alt|title|aria-label)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g;
const HTML_PIECE = /<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>/g;

const parse = (markdown) =>
  fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });

const unquote = (value) => value.replace(/^(["'])([\s\S]*)\1$/, '$2');

/**
 * Splits Markdown into the units that are translated and cached: each top-level block, with list
 * items taken one by one. `joiner` is the separator that precedes a unit when they are reassembled.
 */
export function splitChunks(markdown) {
  const text = markdown.replace(/\r\n/g, '\n');
  const slice = (node) => text.slice(node.position.start.offset, node.position.end.offset);
  const chunks = [];
  for (const node of parse(text).children) {
    if (node.type !== 'list') {
      chunks.push({ text: slice(node), joiner: '\n\n' });
      continue;
    }
    node.children.forEach((item, index) => {
      const joiner = index === 0 || node.spread ? '\n\n' : '\n';
      chunks.push({ text: slice(item), joiner });
    });
  }
  return chunks;
}

/**
 * Every link reference and footnote definition in a document. A chunk is validated with these
 * appended, so a reference-style link or footnote resolves the same way it does in the whole README.
 */
export function definitions(markdown) {
  const text = markdown.replace(/\r\n/g, '\n');
  const found = [];
  walk(parse(text), (node) => {
    if (node.type === 'definition' || node.type === 'footnoteDefinition') {
      found.push(text.slice(node.position.start.offset, node.position.end.offset));
    }
  });
  return found.join('\n\n');
}

const SWITCHER_ITEM = '(?:<strong>[^<]+</strong>|<a href="README(?:\\.\\w+)?\\.md">[^<]+</a>)';
const SWITCHER = new RegExp(`^<p align="center">\\s*(?:${SWITCHER_ITEM}\\s*·?\\s*)+</p>$`);

/** True for the language switcher block in any README, whichever language is current. */
export const isSwitcher = (chunk) => SWITCHER.test(chunk.trim());

/** `available` lists the language codes whose README exists or is being generated. */
export function renderSwitcher(current, available = Object.keys(LANGUAGES)) {
  const entries = [
    { code: 'en', label: 'English', file: 'README.md' },
    ...Object.entries(LANGUAGES)
      .filter(([code]) => available.includes(code))
      .map(([code, { label, file }]) => ({ code, label, file })),
  ];
  const items = entries.map((entry) =>
    entry.code === current
      ? `<strong>${entry.label}</strong>`
      : `<a href="${entry.file}">${entry.label}</a>`,
  );
  return `<p align="center">\n  ${items.join(' ·\n  ')}\n</p>`;
}

/** Change in `<code>`/`<pre>` nesting that an HTML fragment causes. */
const rawCodeDelta = (html) =>
  (html.match(/<(?:code|pre)[\s>]/gi) ?? []).length -
  (html.match(/<\/(?:code|pre)>/gi) ?? []).length;

function walk(node, visit) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

/** Nodes whose alt text or title a reader sees. */
const LABELED_NODES = new Set(['image', 'imageReference', 'link', 'definition']);

/**
 * Words a reader sees: text, image alt, and alt, title and aria-label values, minus glossary terms.
 * `context` resolves reference links without contributing words of its own.
 */
function proseWords(markdown, context = '', withAttributes = true) {
  const parts = [];
  let rawCode = 0;
  walk(parse(context ? `${markdown}\n\n${context}` : markdown), (node) => {
    if (node.position && node.position.start.offset >= markdown.length) return;
    if (node.type === 'html') rawCode = Math.max(rawCode + rawCodeDelta(node.value), 0);
    if (node.type === 'text' && rawCode === 0) parts.push(node.value);
    else if (withAttributes && LABELED_NODES.has(node.type)) {
      if (node.alt) parts.push(node.alt);
      if (node.title) parts.push(node.title);
    } else if (node.type === 'html') {
      if (withAttributes) {
        for (const match of node.value.matchAll(TEXT_ATTRIBUTE)) parts.push(unquote(match[2]));
      }
      const visible = node.value.replace(/<(code|pre)[\s>][\s\S]*?<\/\1>/gi, ' ');
      parts.push(visible.replace(HTML_PIECE, ' '));
    }
  });
  const text = parts
    .join(' ')
    .replace(/https?:\/\/\S+/g, ' ')
    // Bare domains, paths and file names such as `librechat.ai/docs` or `librechat.yaml`.
    .replace(/[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b(?:\/[\w./-]*)?/gi, ' ')
    .replace(GLOSSARY_PATTERN, ' ');
  return text.match(/\p{L}[\p{L}'’-]*/gu) ?? [];
}

/** True when a chunk holds prose worth sending to the model. */
export const needsTranslation = (markdown, context = '') =>
  proseWords(markdown, context).length > 0;

const normalizeTag = (tag) =>
  tag.startsWith('<!--')
    ? tag
    : tag
        .replace(/=\s*'([^']*)'/g, '="$1"')
        .replace(TEXT_ATTRIBUTE, (match, name, value) =>
          unquote(value).trim() === '' ? `${name}=""` : `${name}="*"`,
        )
        .replace(/("[^"]*")|\s+/g, (match, quoted) => quoted ?? ' ');

/** Tags of a raw HTML node with prose masked; text inside its `<code>`/`<pre>` stays verbatim. */
function htmlTokens(raw) {
  const tokens = [];
  let last = 0;
  let code = 0;
  const text = (value) => {
    if (value.trim()) tokens.push(code > 0 ? `rawcode:${value}` : 'T');
  };
  for (const match of raw.matchAll(HTML_PIECE)) {
    text(raw.slice(last, match.index));
    tokens.push(normalizeTag(match[0]));
    code = Math.max(code + rawCodeDelta(match[0]), 0);
    last = match.index + match[0].length;
  }
  text(raw.slice(last));
  return tokens;
}

/**
 * The structure of a chunk with prose masked: everything a translation must reproduce exactly.
 * Prose is dropped rather than masked, since word order legitimately moves it around links,
 * code and emphasis (a verb-final language puts text after a trailing link).
 */
function skeleton(markdown) {
  const tokens = [];
  const push = (token) => {
    if (token !== 'T') tokens.push(token);
  };
  let rawCode = 0;
  const visit = (node) => {
    if (node.type === 'text') {
      if (rawCode > 0) return push(`rawcode:${node.value}`);
      push('T');
      const emoji = node.value.match(/\p{Extended_Pictographic}/gu);
      return emoji && push(`emoji:${emoji.join('')}`);
    }
    if (node.type === 'inlineCode') return push(`code:${node.value}`);
    if (node.type === 'code') return push(`fence:${node.lang ?? ''}:${node.value}`);
    if (node.type === 'html') {
      rawCode = Math.max(rawCode + rawCodeDelta(node.value), 0);
      return htmlTokens(node.value).forEach(push);
    }
    if (node.type === 'image') {
      return push(`image:${node.url}:${node.title ? 'titled' : ''}:${node.alt ? 'alt' : ''}`);
    }
    if (node.type === 'imageReference') {
      return push(`imageReference:${node.identifier}:${node.alt ? 'alt' : ''}`);
    }
    const detail = [
      node.depth,
      node.url,
      node.ordered,
      node.checked,
      node.start,
      node.identifier,
      node.title ? 'titled' : undefined,
      node.align?.map((align) => align ?? 'none').join(','),
    ].filter((value) => value !== undefined && value !== null);
    const tag = [node.type, ...detail].join(':');
    if (!node.children) return push(tag);
    push(`<${tag}>`);
    node.children.forEach(visit);
    push(`</${node.type}>`);
  };
  visit(parse(markdown));
  return tokens;
}

/** Common lowercase English words; capitalized names such as language names legitimately stay. */
const commonWords = (words) => words.filter((word) => /^[a-z]{4,}$/.test(word));

/**
 * Returns a list of problems with a translation: any difference in structure, links, code or
 * attributes from its source, and output that is empty, short, or not in the target language.
 * `context` holds the document's reference definitions (see `definitions`).
 */
export function validate(source, translated, code, context = '') {
  const problems = [];
  if (translated.trim() === '') return ['output is empty'];
  const withContext = (markdown) => (context ? `${markdown}\n\n${context}` : markdown);
  const a = skeleton(withContext(source));
  const b = skeleton(withContext(translated));
  const at = a.findIndex((token, index) => token !== b[index]);
  if (at !== -1 || a.length !== b.length) {
    const near = (a[Math.max(at, 0)] ?? b[Math.max(at, 0)] ?? '').slice(0, 60);
    problems.push(`structure differs near ${near}`);
  }
  const script = LANGUAGES[code]?.script;
  const words = proseWords(source, context);
  const sameWords = (a, b) => a.length === b.length && a.every((word, index) => word === b[index]);
  if (
    script &&
    proseWords(source, context, false).length > 0 &&
    sameWords(words, proseWords(translated, context))
  ) {
    problems.push('output is unchanged');
  }
  if (
    script &&
    (proseWords(source, context, false).length > 0 ||
      words.length >= MIN_WORDS_FOR_CONTENT_CHECK) &&
    !script.test(translated)
  ) {
    problems.push(
      'output is not in the target language (add intentional English terms to GLOSSARY)',
    );
  }
  if (script && words.length >= MIN_WORDS_FOR_CONTENT_CHECK) {
    if (translated.length < source.length * MIN_LENGTH_RATIO) problems.push('output is truncated');
    const plain = commonWords(words);
    const kept = new Set(proseWords(translated, context).map((word) => word.toLowerCase()));
    const share = plain.filter((word) => kept.has(word)).length / (plain.length || 1);
    if (plain.length >= MIN_WORDS_FOR_CONTENT_CHECK && share > MAX_UNTRANSLATED_SHARE) {
      problems.push('output is mostly untranslated');
    }
  }
  return problems;
}

/** Anchor of every Markdown heading in document order, as GitHub derives it from the heading text. */
function headingSlugs(markdown) {
  const slugger = new GithubSlugger();
  const slugs = [];
  walk(parse(markdown), (node) => {
    if (node.type !== 'heading') return;
    let text = '';
    walk(node, (child) => {
      if (child.type === 'text' || child.type === 'inlineCode') text += child.value;
    });
    slugs.push(slugger.slug(text));
  });
  return slugs;
}

const HTML_FRAGMENT = /(href\s*=\s*)(["'])#([^"']*)\2/gi;

/**
 * Points `#fragment` links of a translated README at the anchors of its translated headings, which
 * GitHub derives from the heading text. Headings pair up by position: `validate` keeps them equal.
 */
export function localizeAnchors(source, translated) {
  const from = headingSlugs(source);
  const to = headingSlugs(translated);
  if (from.length !== to.length) return translated;
  const anchors = new Map(from.map((slug, index) => [slug, to[index]]));
  const edits = [];
  walk(parse(translated), (node) => {
    if (!node.position) return;
    const start = node.position.start.offset;
    const end = node.position.end.offset;
    if (node.type === 'html') {
      const value = translated.slice(start, end);
      const next = value.replace(HTML_FRAGMENT, (match, prefix, quote, fragment) =>
        anchors.has(fragment) ? `${prefix}${quote}#${anchors.get(fragment)}${quote}` : match,
      );
      if (next !== value) edits.push({ start, end, value: next });
      return;
    }
    if (node.type !== 'link' && node.type !== 'definition') return;
    const fragment = node.url?.startsWith('#') ? node.url.slice(1) : null;
    if (fragment === null || !anchors.has(fragment)) return;
    const after =
      node.type === 'link'
        ? (node.children.at(-1)?.position.end.offset ?? start)
        : translated.indexOf(']:', start);
    const at = translated.indexOf(node.url, after);
    if (at === -1 || at >= end) return;
    edits.push({ start: at, end: at + node.url.length, value: `#${anchors.get(fragment)}` });
  });
  return edits
    .sort((a, b) => b.start - a.start)
    .reduce(
      (text, edit) => text.slice(0, edit.start) + edit.value + text.slice(edit.end),
      translated,
    );
}

/** A cached translation that still passes the current `validate`, else undefined to retranslate. */
export const reusable = (cached, source, code, context = '') =>
  typeof cached === 'string' && validate(source, cached, code, context).length === 0
    ? cached
    : undefined;

const FULLWIDTH = { ',': '，', ':': '：', ';': '；', '!': '！', '?': '？' };
/**
 * ASCII punctuation touching Chinese text. A space before the mark goes too (`**标题** :`), but a
 * space after it stays: `**标签：** 正文` needs that space to render bold.
 */
const HALFWIDTH =
  /(?<=[\p{Script=Han}）」』》])[ \t]*([,:;!?])|([,:;!?])(?=[\p{Script=Han}（「『《])/gu;
/** Source between two text nodes that a reader does not see: emphasis markers and link targets. */
const INVISIBLE = /^[*_~[\]]*$/;
/**
 * One source character, or a whole character reference (`&nbsp;`, `&#32;`) or backslash escape
 * (`\!`), whose `;` or mark is syntax rather than punctuation and so must never be converted.
 */
const RAW_PIECE = /&(?:#\d+|#x[\da-f]+|[a-z][\da-z]*);|\\[!-/:-@[-`{-~]|[\s\S]/gi;

/**
 * Turns ASCII punctuation beside Chinese text into its full-width form, as Chinese prose writes it.
 * Each chunk is translated separately, so without this one section uses `，：` and the next `,:`.
 * Only Markdown text changes: URLs, code, raw HTML and attribute values are left as they are, and
 * so is text copied verbatim from `source`, such as the list of language names.
 */
export function punctuate(markdown, code, source = '') {
  if (!LANGUAGES[code]?.fullwidth) return markdown;
  // The text a reader sees, with `offsets` mapping each character back to `markdown`. Text nodes
  // separated only by markup are joined, so `**[标签](url)**:` sees the colon follow `签`.
  let visible = '';
  const offsets = [];
  let last = null;
  let autolink = -1;
  walk(parse(markdown), (node) => {
    if (!node.position) return;
    const { start, end } = node.position;
    // A bare or `<...>` URL is a link whose text is the address itself.
    if (node.type === 'link' && markdown[start.offset] !== '[') autolink = end.offset;
    if (node.type !== 'text') return;
    // Only prose counts as copied: a lone `:` after `**label**` is in the English source too.
    const copied =
      end.offset <= autolink || (/\p{L}/u.test(node.value) && source.includes(node.value));
    const gap = last === null ? '\n' : markdown.slice(last, start.offset);
    if (!INVISIBLE.test(gap.replace(/\]\([^\s)]*\)/g, ']'))) {
      visible += '\n';
      offsets.push(-1);
    }
    for (const piece of markdown.slice(start.offset, end.offset).matchAll(RAW_PIECE)) {
      const at = start.offset + piece.index;
      if (piece[0].length > 1) {
        visible += '￼';
        offsets.push(-1);
        continue;
      }
      visible += piece[0];
      offsets.push(copied ? -1 : at);
    }
    last = end.offset;
  });
  const edits = [];
  for (const match of visible.matchAll(HALFWIDTH)) {
    const mark = match[1] ?? match[2];
    const from = offsets[match.index];
    const to = offsets[match.index + match[0].length - 1] + 1;
    if (from >= 0 && to - from === match[0].length) edits.push({ from, to, mark: FULLWIDTH[mark] });
  }
  return edits.reduceRight(
    (text, { from, to, mark }) => text.slice(0, from) + mark + text.slice(to),
    markdown,
  );
}

/**
 * The pull request description for a sync run. `runs` lists each regenerated language with how
 * many sections went to the model and how many came from the cache.
 */
export function describe(runs, force = false) {
  const lines = runs.map(({ code, translated, cached }) => {
    const { name, file } = LANGUAGES[code];
    return `- ${name} (\`${file}\`): ${translated} section(s) translated, ${cached} reused from the cache`;
  });
  const cache = force
    ? 'This run ignored the cache in `.github/readme-i18n.json` and retranslated every section.'
    : 'Sections whose English text is unchanged come from the cache in `.github/readme-i18n.json`.';
  return [
    '## Summary',
    '',
    'These READMEs were regenerated from `README.md` on `dev`:',
    '',
    ...lines,
    '',
    `${cache} Each section is checked against its source for identical links, image paths, HTML tags and list structure before it is accepted.`,
    '',
    '## Type of change',
    '',
    '* [x] Translation',
    '',
    '## Testing',
    '',
    '* `node --test scripts/readme/lib.test.mjs` passed in the workflow run.',
    '* Every regenerated section kept its source links, image paths, HTML tags and list structure.',
    '',
    '## Risk / compatibility',
    '',
    'None. Only README files and the translation cache change.',
    '',
    '## Checklist',
    '',
    '* [x] The change does not introduce new warnings or errors',
    '',
  ].join('\n');
}

/** Drops a code fence the model sometimes wraps around its answer. */
export function cleanOutput(text) {
  const wrapped = /^\s*```(?:markdown|md|html)?\n([\s\S]*)\n```\s*$/.exec(text);
  return (wrapped ? wrapped[1] : text).replace(/^(?:[ \t]*\n)+/, '').trimEnd();
}

export function buildMessages(language, chunk) {
  const system = [
    `You translate fragments of the LibreChat README from English into ${language}.`,
    'Reply with the translated fragment only: no commentary, and no code fence around it.',
    'Keep Markdown and HTML structure, tags, attribute names, URLs, file paths, inline code, badges and emoji exactly as given.',
    'Translate human-readable prose, headings, link text, and alt, title and aria-label values.',
    `Keep these terms in English: ${GLOSSARY.join(', ')}, plus product and brand names.`,
    'Keep the same number of lines and list items as the input, and keep links in the same order.',
    'Write a reference link such as [Label] or [Label][] as [translated label][Label] so it still resolves.',
    'Leave a space between bold or italic markers and neighbouring words so the Markdown still renders.',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: chunk },
  ];
}

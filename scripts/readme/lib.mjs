import { createHash } from 'node:crypto';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

export const LANGUAGES = {
  zh: {
    name: 'Simplified Chinese',
    label: '中文',
    file: 'README.zh.md',
    script: /\p{Script=Han}/u,
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
  'Zeabur',
  'Sealos',
  'API',
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

export const isSwitcher = (chunk) => /^<p align="center">\s*<strong>English<\/strong>/.test(chunk);

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

function walk(node, visit) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

/** Words a reader sees: text, image alt, and alt, title and aria-label values, minus glossary terms. */
function proseWords(markdown, withAttributes = true) {
  const parts = [];
  walk(parse(markdown), (node) => {
    if (node.type === 'text') parts.push(node.value);
    else if (withAttributes && (node.type === 'image' || node.type === 'link')) {
      if (node.alt) parts.push(node.alt);
      if (node.title) parts.push(node.title);
    } else if (node.type === 'html') {
      if (withAttributes) {
        for (const match of node.value.matchAll(TEXT_ATTRIBUTE)) parts.push(unquote(match[2]));
      }
      parts.push(node.value.replace(HTML_PIECE, ' '));
    }
  });
  const text = parts
    .join(' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(GLOSSARY_PATTERN, ' ');
  return text.match(/\p{L}[\p{L}'’-]*/gu) ?? [];
}

/** True when a chunk holds prose worth sending to the model. */
export const needsTranslation = (markdown) => proseWords(markdown).length > 0;

const normalizeTag = (tag) =>
  tag.startsWith('<!--')
    ? '<!---->'
    : tag
        .replace(/=\s*'([^']*)'/g, '="$1"')
        .replace(TEXT_ATTRIBUTE, '$1=""')
        .replace(/("[^"]*")|\s+/g, (match, quoted) => quoted ?? ' ');

function htmlTokens(raw) {
  const tokens = [];
  let last = 0;
  for (const match of raw.matchAll(HTML_PIECE)) {
    if (raw.slice(last, match.index).trim()) tokens.push('T');
    tokens.push(normalizeTag(match[0]));
    last = match.index + match[0].length;
  }
  if (raw.slice(last).trim()) tokens.push('T');
  return tokens;
}

/** The structure of a chunk with prose masked: everything a translation must reproduce exactly. */
function skeleton(markdown) {
  const tokens = [];
  const push = (token) => {
    if (token !== 'T' || tokens.at(-1) !== 'T') tokens.push(token);
  };
  const visit = (node) => {
    if (node.type === 'text') return push('T');
    if (node.type === 'inlineCode') return push(`code:${node.value}`);
    if (node.type === 'code') return push(`fence:${node.lang ?? ''}:${node.value}`);
    if (node.type === 'html') return htmlTokens(node.value).forEach(push);
    if (node.type === 'image') return push(`image:${node.url}:${node.title ? 'titled' : ''}`);
    const detail = [
      node.depth,
      node.url,
      node.ordered,
      node.checked,
      node.start,
      node.identifier,
      node.referenceType,
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

const lowerWords = (words) => words.filter((word) => /^[a-z]{4,}$/.test(word));

/**
 * Returns a list of problems with a translation: any difference in structure, links, code or
 * attributes from its source, and output that is empty, short, or not in the target language.
 */
export function validate(source, translated, code) {
  const problems = [];
  if (translated.trim() === '') return ['output is empty'];
  const a = skeleton(source);
  const b = skeleton(translated);
  const at = a.findIndex((token, index) => token !== b[index]);
  if (at !== -1 || a.length !== b.length) {
    const near = (a[Math.max(at, 0)] ?? b[Math.max(at, 0)] ?? '').slice(0, 60);
    problems.push(`structure differs near ${near}`);
  }
  const script = LANGUAGES[code]?.script;
  const words = proseWords(source);
  if (
    script &&
    (proseWords(source, false).length > 0 || words.length >= MIN_WORDS_FOR_CONTENT_CHECK) &&
    !script.test(translated)
  ) {
    problems.push(
      'output is not in the target language (add intentional English terms to GLOSSARY)',
    );
  }
  if (script && words.length >= MIN_WORDS_FOR_CONTENT_CHECK) {
    if (translated.length < source.length * MIN_LENGTH_RATIO) problems.push('output is truncated');
    const plain = lowerWords(words.map((word) => word.toLowerCase()));
    const kept = new Set(proseWords(translated).map((word) => word.toLowerCase()));
    const share = plain.filter((word) => kept.has(word)).length / (plain.length || 1);
    if (plain.length >= MIN_WORDS_FOR_CONTENT_CHECK && share > MAX_UNTRANSLATED_SHARE) {
      problems.push('output is mostly untranslated');
    }
  }
  return problems;
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
    'Leave a space between bold or italic markers and neighbouring words so the Markdown still renders.',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: chunk },
  ];
}

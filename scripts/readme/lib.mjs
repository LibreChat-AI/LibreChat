import { createHash } from 'node:crypto';

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
];

export const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

const FENCE = /^\s*(```|~~~)/;

/** Splits Markdown on blank lines, keeping fenced code blocks whole. */
export function splitChunks(markdown) {
  const chunks = [];
  let current = [];
  let inFence = false;
  const flush = () => {
    if (current.length > 0) chunks.push(current.join('\n'));
    current = [];
  };
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;
    if (!inFence && line.trim() === '') {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return chunks;
}

export const isSwitcher = (chunk) => /^<p align="center">\s*<strong>English<\/strong>/.test(chunk);

export function renderSwitcher(current) {
  const entries = [
    { code: 'en', label: 'English', file: 'README.md' },
    ...Object.entries(LANGUAGES).map(([code, { label, file }]) => ({ code, label, file })),
  ];
  const items = entries.map((entry) =>
    entry.code === current
      ? `<strong>${entry.label}</strong>`
      : `<a href="${entry.file}">${entry.label}</a>`,
  );
  return `<p align="center">\n  ${items.join(' ·\n  ')}\n</p>`;
}

const GLOSSARY_PATTERN = new RegExp(
  GLOSSARY.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'gi',
);
const MIN_WORDS_FOR_CONTENT_CHECK = 3;
const MIN_LENGTH_RATIO = 0.2;

/** Words a reader sees: text and alt, title and aria-label values, minus markup, URLs and glossary terms. */
function proseWords(chunk) {
  const attributes = [...chunk.matchAll(/\b(?:alt|title|aria-label)="([^"]*)"/g)].map(
    (match) => match[1],
  );
  const text = chunk.replace(/<[^>]*>/g, ' ').replace(/https?:\/\/\S+/g, ' ');
  return (
    [...attributes, text]
      .join(' ')
      .replace(GLOSSARY_PATTERN, ' ')
      .match(/\p{L}[\p{L}'’-]*/gu) ?? []
  );
}

/** True when a chunk holds prose worth sending to the model. */
export function needsTranslation(chunk) {
  if (FENCE.test(chunk)) return false;
  return proseWords(chunk).length > 0;
}

function facts(chunk) {
  const targets = [
    ...chunk.matchAll(/https?:\/\/[^\s)"'<>\]]+/g),
    ...chunk.matchAll(/(?:href|src)="([^"]+)"/g),
    ...chunk.matchAll(/\]\(([^)\s]+)/g),
  ].map((match) => match[1] ?? match[0]);
  return {
    targets: [...new Set(targets)].sort(),
    tags: [...chunk.matchAll(/<\/?([a-zA-Z][\w-]*)/g)].map((match) => match[1].toLowerCase()),
    fences: chunk.split('\n').filter((line) => FENCE.test(line)).length,
    heading: /^(#{1,6})\s/.exec(chunk)?.[1] ?? '',
    bullets: chunk.split('\n').filter((line) => /^\s*[-*]\s/.test(line)).length,
  };
}

/**
 * Returns a list of problems with a translation: structural differences from its source, and
 * output that is not in the target language or is far shorter than the source.
 */
export function validate(source, translated, code) {
  const a = facts(source);
  const b = facts(translated);
  const problems = [];
  if (a.targets.join('\n') !== b.targets.join('\n')) problems.push('links or paths differ');
  if (a.tags.join(',') !== b.tags.join(',')) problems.push('HTML tags differ');
  if (a.fences !== b.fences) problems.push('code fence count differs');
  if (a.heading !== b.heading) problems.push('heading level differs');
  if (a.bullets !== b.bullets) problems.push('list item count differs');
  const script = LANGUAGES[code]?.script;
  if (script && proseWords(source).length >= MIN_WORDS_FOR_CONTENT_CHECK) {
    if (!script.test(translated)) problems.push('output is not in the target language');
    if (translated.length < source.length * MIN_LENGTH_RATIO) problems.push('output is truncated');
  }
  return problems;
}

/** Drops a code fence the model sometimes wraps around its answer. */
export function cleanOutput(text) {
  const trimmed = text.trim();
  const wrapped = /^```(?:markdown|md|html)?\n([\s\S]*)\n```$/.exec(trimmed);
  return wrapped ? wrapped[1] : trimmed;
}

export function buildMessages(language, chunk) {
  const system = [
    `You translate fragments of the LibreChat README from English into ${language}.`,
    'Reply with the translated fragment only: no commentary, and no code fence around it.',
    'Keep Markdown and HTML structure, tags, attribute names, URLs, file paths, badges and emoji exactly as given.',
    'Translate human-readable prose, headings, link text, and alt, title and aria-label values.',
    `Keep these terms in English: ${GLOSSARY.join(', ')}, plus product and brand names.`,
    'Keep the same number of lines and list items as the input.',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: chunk },
  ];
}

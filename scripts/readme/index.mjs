#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import {
  LANGUAGES,
  buildMessages,
  cleanOutput,
  hash,
  isSwitcher,
  needsTranslation,
  renderSwitcher,
  splitChunks,
  validate,
} from './lib.mjs';

const SOURCE = 'README.md';
const CACHE = '.github/readme-i18n.json';
const ATTEMPTS = 3;
const CONCURRENCY = 4;

const args = process.argv.slice(2);
const force = args.includes('--force');
const langsArg = args.find((arg) => arg.startsWith('--langs='))?.slice('--langs='.length);
const langs = (langsArg || Object.keys(LANGUAGES).join(','))
  .split(',')
  .map((code) => code.trim())
  .filter(Boolean);

const baseUrl = process.env.README_TRANSLATE_BASE_URL?.replace(/\/+$/, '');
const apiKey = process.env.README_TRANSLATE_API_KEY;
const model = process.env.README_TRANSLATE_MODEL;
const missing = Object.entries({
  README_TRANSLATE_BASE_URL: baseUrl,
  README_TRANSLATE_API_KEY: apiKey,
  README_TRANSLATE_MODEL: model,
})
  .filter(([, value]) => !value)
  .map(([key]) => key);
if (missing.length > 0) {
  console.error(`Missing environment variables: ${missing.join(', ')}`);
  process.exit(2);
}
for (const code of langs) {
  if (!LANGUAGES[code]) {
    console.error(`Unsupported language: ${code}`);
    process.exit(2);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function complete(code, chunk) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: buildMessages(LANGUAGES[code].name, chunk) }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') throw new Error('empty completion');
  return cleanOutput(content);
}

async function translate(code, chunk) {
  let reason = '';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const output = await complete(code, chunk);
      const problems = validate(chunk, output, code);
      if (problems.length === 0) return output;
      reason = problems.join('; ');
    } catch (error) {
      reason = error instanceof Error ? error.message : 'request failed';
    }
    if (attempt < ATTEMPTS) await sleep(1000 * 2 ** (attempt - 1));
  }
  const preview = chunk.slice(0, 80).replace(/\s+/g, ' ');
  throw new Error(`${code} translation failed (${reason}) for: ${preview}`);
}

async function pool(items, worker) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length > 0) await worker(queue.shift());
    }),
  );
}

const readIfExists = async (file) => readFile(file, 'utf8').catch(() => null);

const source = await readFile(SOURCE, 'utf8');
const chunks = splitChunks(source);
const stored = JSON.parse((await readIfExists(CACHE)) ?? '{}');
const cache = { version: 1 };
const outputs = {};

for (const code of langs) {
  const { file } = LANGUAGES[code];
  const previous = force ? {} : (stored[code] ?? {});
  const next = {};
  const pending = [];
  for (const chunk of chunks) {
    if (isSwitcher(chunk) || !needsTranslation(chunk)) continue;
    const key = hash(chunk);
    if (previous[key] !== undefined) next[key] = previous[key];
    else pending.push({ key, chunk });
  }
  console.log(
    `${code}: ${pending.length} chunk(s) to translate, ${Object.keys(next).length} cached`,
  );
  await pool(pending, async ({ key, chunk }) => {
    next[key] = await translate(code, chunk);
  });
  const body = chunks
    .map((chunk) => {
      if (isSwitcher(chunk)) return renderSwitcher(code);
      return needsTranslation(chunk) ? next[hash(chunk)] : chunk;
    })
    .join('\n\n');
  const notice =
    '<!-- Generated from README.md by .github/workflows/readme-translate.yml. Do not edit by hand. -->';
  outputs[file] = `${notice}\n\n${body}\n`;
  cache[code] = Object.fromEntries(
    chunks
      .filter((chunk) => !isSwitcher(chunk) && needsTranslation(chunk))
      .map((chunk) => [hash(chunk), next[hash(chunk)]]),
  );
}

for (const code of Object.keys(LANGUAGES)) {
  if (!langs.includes(code) && stored[code]) cache[code] = stored[code];
}

const switcher = chunks.find(isSwitcher);
if (switcher && switcher !== renderSwitcher('en')) {
  outputs[SOURCE] = source.replace(switcher, () => renderSwitcher('en'));
}

for (const [file, content] of Object.entries(outputs)) await writeFile(file, content);
await writeFile(CACHE, `${JSON.stringify(cache, null, 2)}\n`);

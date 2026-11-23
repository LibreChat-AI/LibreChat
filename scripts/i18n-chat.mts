/**
 * Writes the strings `@librechat/chat` shows, one file per language, into the package's build:
 * `packages/chat/dist/locales/<language>.json`, published as `@librechat/chat/locales/*`.
 *
 * The copy stays where it is translated, in `client/src/locales`. This takes from each language
 * the keys the chat UI can name: those in the package's own source, in `@librechat/client`, whose
 * components it draws with, and in `librechat-data-provider`, whose option labels it shows. So an
 * app that renders the package loads this instead of LibreChat's whole bundle, and nothing is
 * edited twice. A reference is read the way the unused-key check reads one (`scripts/i18n.mts`).
 *
 * It fails, and writes nothing, when the package names a key that English has no copy for.
 *
 *   node scripts/i18n-chat.mts [--out <directory>]
 */

import { fileURLToPath } from 'node:url';
import { join, resolve, dirname } from 'node:path';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

import type { Dirent } from 'node:fs';
import { hasTranslation, referencedTranslations } from './i18n.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = resolve(ROOT, 'client/src/locales');
const PACKAGE = 'packages/chat/src';
const SOURCES = [PACKAGE, 'packages/client/src', 'packages/data-provider/src'];
const EXTENSIONS = /\.(?:[jt]sx?)$/;
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'locales', '__tests__', '__fixtures__']);
const TEST_FILE = /\.(?:spec|test)\.[jt]sx?$/;
const TOKEN = /[A-Za-z0-9_]+/g;
/** A key written out whole, which is how the package names every one of its own. */
const LITERAL_KEY = /(['"`])(com_[a-z0-9]+(?:_[a-z0-9]+)+)\1/g;

type Translations = Record<string, string>;

async function* sourceFiles(directory: string): AsyncGenerator<string> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) yield* sourceFiles(path);
    } else if (EXTENSIONS.test(entry.name) && !TEST_FILE.test(entry.name)) {
      yield path;
    }
  }
}

async function readSources(): Promise<{ tokens: Set<string>; named: Set<string> }> {
  const tokens = new Set<string>();
  const named = new Set<string>();
  for (const source of SOURCES) {
    for await (const file of sourceFiles(resolve(ROOT, source))) {
      const content = await readFile(file, 'utf8');
      for (const token of content.match(TOKEN) ?? []) tokens.add(token);
      if (source !== PACKAGE) continue;
      for (const [, , key] of content.matchAll(LITERAL_KEY)) named.add(key);
    }
  }
  return { tokens, named };
}

async function readLanguage(language: string): Promise<Translations | null> {
  try {
    return JSON.parse(await readFile(join(LOCALES, language, 'translation.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const flag = process.argv.indexOf('--out');
  const out = resolve(
    flag === -1 ? join(ROOT, 'packages/chat/dist/locales') : process.argv[flag + 1],
  );

  const { tokens, named } = await readSources();
  const english = await readLanguage('en');
  if (english == null) {
    throw new Error(`No English translations under ${LOCALES}`);
  }
  const missing = [...named].filter((key) => !hasTranslation(key, english)).sort();
  if (missing.length > 0) {
    throw new Error(
      `@librechat/chat names ${missing.length} key(s) that client/src/locales/en/translation.json ` +
        `has no copy for:\n${missing.map((key) => `  ${key}`).join('\n')}`,
    );
  }

  const entries = await readdir(LOCALES, { withFileTypes: true });
  const languages: string[] = [];
  await mkdir(out, { recursive: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const translations = entry.name === 'en' ? english : await readLanguage(entry.name);
    if (translations == null) continue;
    const picked = referencedTranslations(translations, tokens);
    await writeFile(join(out, `${entry.name}.json`), `${JSON.stringify(picked, null, 2)}\n`);
    languages.push(entry.name);
  }
  await writeFile(join(out, 'index.json'), `${JSON.stringify(languages, null, 2)}\n`);

  const count = Object.keys(referencedTranslations(english, tokens)).length;
  console.log(`@librechat/chat: ${count} strings in ${languages.length} languages -> ${out}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

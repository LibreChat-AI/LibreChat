import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cleanOutput,
  isSwitcher,
  needsTranslation,
  renderSwitcher,
  splitChunks,
  validate,
} from './lib.mjs';

const texts = (markdown) => splitChunks(markdown).map((chunk) => chunk.text);

test('splitChunks keeps fenced code whole, including a different fence marker inside', () => {
  assert.deepEqual(texts('# Title\n\nText\n\n```text\n~~~\nb\n\nc\n```\n\n\nEnd\n'), [
    '# Title',
    'Text',
    '```text\n~~~\nb\n\nc\n```',
    'End',
  ]);
});

test('splitChunks separates prose from an adjacent fenced block', () => {
  assert.deepEqual(texts('Intro\n```sh\nnpm install\n```\nOutro'), [
    'Intro',
    '```sh\nnpm install\n```',
    'Outro',
  ]);
});

test('splitChunks takes list items one by one and remembers tight and loose lists', () => {
  const tight = splitChunks('- a\n- b\n  - c\n');
  assert.deepEqual(
    tight.map((chunk) => chunk.text),
    ['- a', '- b\n  - c'],
  );
  assert.deepEqual(
    tight.map((chunk) => chunk.joiner),
    ['\n\n', '\n'],
  );
  assert.equal(splitChunks('- a\n\n- b\n')[1].joiner, '\n\n');
});

test('renderSwitcher bolds the current language and links the rest', () => {
  const en = renderSwitcher('en');
  assert.ok(isSwitcher(en));
  assert.match(en, /<a href="README\.zh\.md">/);
  assert.match(en, /<a href="README\.ru\.md">/);
  const ru = renderSwitcher('ru');
  assert.match(ru, /<strong>Русский<\/strong>/);
  assert.match(ru, /<a href="README\.md">English<\/a>/);
});

test('renderSwitcher links only available languages', () => {
  const en = renderSwitcher('en', ['zh']);
  assert.match(en, /README\.zh\.md/);
  assert.doesNotMatch(en, /README\.ru\.md/);
});

test('needsTranslation keeps alt text in either quote style and skips code and glossary terms', () => {
  assert.equal(
    needsTranslation('<a aria-label="Sponsors" href="https://x.y"><img src="a.svg"></a>'),
    true,
  );
  assert.equal(needsTranslation("<img alt='Build status' src='x.svg'>"), true);
  assert.equal(needsTranslation('<img src="logo.svg" height="256">'), false);
  assert.equal(needsTranslation('```sh\nnpm run build\n```'), false);
  assert.equal(needsTranslation('    npm run build\n    npm test'), false);
  assert.equal(needsTranslation('# LibreChat'), false);
  assert.equal(needsTranslation('- **Agents:** build [docs](https://x.y)'), true);
});

test('validate accepts a faithful translation', () => {
  const source = '- **Agents:** see [docs](https://librechat.ai/docs) and `npm run build`';
  const out = '- **Agents:** см. [документацию](https://librechat.ai/docs) и `npm run build`';
  assert.deepEqual(validate(source, out, 'ru'), []);
});

test('validate flags structural changes', () => {
  const html = '<a href="https://a.b"><img src="x.svg"></a>';
  assert.ok(validate(html, '<a href="https://a.b"></a>', 'ru').length > 0);
  assert.ok(validate(html, '<a href="https://a.c"><img src="x.svg"></a>', 'ru').length > 0);
  assert.ok(validate('- a\n- b', '- a', 'ru').length > 0);
  assert.ok(validate('1. One\n2. Two', '1. Один', 'ru').length > 0);
  assert.ok(validate('## A\n\n## B', '## А\n\n### Б', 'ru').length > 0);
  assert.ok(validate('**Bold** text', 'Жирный текст', 'ru').length > 0);
});

test('validate protects inline code, link order and non-text HTML attributes', () => {
  const code = 'Run `npm install` now to begin.';
  assert.ok(validate(code, 'Запустите `npm установка` сейчас.', 'ru').length > 0);
  assert.ok(
    validate('Use `npm` before `node`.', 'Используйте `node` перед `npm`.', 'ru').length > 0,
  );
  const links = '[API](api.md) then [Setup](setup.md)';
  assert.ok(validate(links, '[API](setup.md) затем [Setup](api.md)', 'ru').length > 0);
  assert.deepEqual(validate(links, '[API](api.md) затем [Setup](setup.md)', 'ru'), []);
  const img = '<img src="logo.svg" width="400" alt="Logo">';
  assert.ok(validate(img, '<img src="logo.svg" width="200" alt="Логотип">', 'ru').length > 0);
  assert.deepEqual(validate(img, "<img src='logo.svg' width='400' alt='Логотип'>", 'ru'), []);
});

test('validate keeps reference identifiers and link title presence', () => {
  const ref = '[Docs][setup]\n\n[setup]: https://x.y';
  assert.ok(validate(ref, '[Документы][документация]\n\n[setup]: https://x.y', 'ru').length > 0);
  assert.deepEqual(validate(ref, '[Документы][setup]\n\n[setup]: https://x.y', 'ru'), []);
  const titled = '[Docs](https://x.y "Read the docs")';
  assert.ok(validate(titled, '[Документы](https://x.y)', 'ru').length > 0);
  assert.deepEqual(validate(titled, '[Документы](https://x.y "Читать документацию")', 'ru'), []);
});

test('validate rejects echoed, mixed, refused, truncated and empty output', () => {
  const source = 'This sentence should become Russian for sure, thanks.';
  assert.ok(validate(source, source, 'ru').length > 0);
  assert.ok(validate(source, 'This sentence should become Russian for sure, но.', 'ru').length > 0);
  assert.ok(validate(source, 'Sorry, I cannot translate that.', 'ru').length > 0);
  assert.ok(validate(source, 'Это', 'ru').includes('output is truncated'));
  assert.deepEqual(validate('Continue', '', 'ru'), ['output is empty']);
  assert.deepEqual(
    validate(source, 'Это предложение обязательно станет русским, спасибо.', 'ru'),
    [],
  );
  assert.ok(validate('# Features', '# Features', 'ru').length > 0);
  assert.deepEqual(validate('# Features', '# Возможности', 'ru'), []);
  assert.deepEqual(
    validate('<img alt="Trendshift" src="x.svg">', '<img alt="Trendshift" src="x.svg">', 'ru'),
    [],
  );
});

test('cleanOutput unwraps a fenced answer and keeps indentation', () => {
  assert.equal(cleanOutput('```markdown\n# Hi\n```'), '# Hi');
  assert.equal(cleanOutput('\n  plain  \n'), '  plain');
  assert.equal(cleanOutput('  - Child\n  - Two'), '  - Child\n  - Two');
});

test('validate and needsTranslation handle brand suffixes, titles, tables and data attributes', () => {
  assert.equal(needsTranslation("LibreChat's MCPs"), false);
  assert.equal(needsTranslation('# API'), false);
  assert.equal(needsTranslation('[`x`](https://x.y "Read the docs")'), true);
  assert.ok(validate('![Logo](img.svg "Read the docs")', '![Логотип](img.svg)', 'ru').length > 0);
  const table = '| A | B |\n| :-- | --: |\n| 1 | 2 |';
  assert.ok(validate(table, '| А | Б |\n| --: | :-- |\n| 1 | 2 |', 'ru').length > 0);
  const div = '<div data-title="build-id  7">Text</div>';
  assert.ok(validate(div, '<div data-title="build-id 7">Текст</div>', 'ru').length > 0);
  assert.ok(
    validate(
      '<img alt="Translation Progress now live" src="x.svg">',
      '<img alt="Translation Progress now live" src="x.svg">',
      'ru',
    ).length > 0,
  );
});

test('validate keeps emoji, image alt presence and raw HTML code content', () => {
  assert.ok(validate('## 🚀 Whats New today', '## Что нового сегодня', 'ru').length > 0);
  assert.deepEqual(validate('## 🚀 Whats New today', '## 🚀 Что нового сегодня', 'ru'), []);
  assert.ok(validate('![](logo.svg)', '![Логотип](logo.svg)', 'ru').length > 0);
  const code = 'Run <code>npm install package</code> first.';
  assert.ok(validate(code, 'Сначала <code>npm установить пакет</code>.', 'ru').length > 0);
  assert.deepEqual(validate(code, 'Сначала запустите <code>npm install package</code>.', 'ru'), []);
});

test('validate accepts a translated label that keeps language names and rejects the unchanged chunk', () => {
  const source = '- **Multilingual UI**:\n  - English, 中文 (简体), Deutsch, Español, Русский';
  const out = '- **Многоязычный интерфейс**:\n  - English, 中文 (简体), Deutsch, Español, Русский';
  assert.deepEqual(validate(source, out, 'ru'), []);
  assert.ok(validate(source, source, 'ru').includes('output is unchanged'));
});

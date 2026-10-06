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

test('splitChunks keeps fenced code whole and drops blank separators', () => {
  const chunks = splitChunks('# Title\n\nText\n\n```sh\na\n\nb\n```\n\n\nEnd\n');
  assert.deepEqual(chunks, ['# Title', 'Text', '```sh\na\n\nb\n```', 'End']);
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

test('needsTranslation skips markup-only and code chunks', () => {
  assert.equal(needsTranslation('<img src="logo.svg" height="256">'), false);
  assert.equal(needsTranslation('```sh\nnpm run build\n```'), false);
  assert.equal(needsTranslation('- **Agents:** build [docs](https://x.y)'), true);
});

test('validate accepts a faithful translation', () => {
  const source = '- **Agents:** see [docs](https://librechat.ai/docs)';
  assert.deepEqual(
    validate(source, '- **Agents:** см. [документацию](https://librechat.ai/docs)'),
    [],
  );
});

test('validate flags dropped links, tags and list items', () => {
  const source = '<a href="https://a.b"><img src="x.svg"></a>';
  assert.ok(validate(source, '<a href="https://a.b"></a>').length > 0);
  assert.ok(validate(source, '<a href="https://a.c"><img src="x.svg"></a>').length > 0);
  assert.ok(validate('- a\n- b', '- a').length > 0);
});

test('cleanOutput unwraps a fenced answer', () => {
  assert.equal(cleanOutput('```markdown\n# Hi\n```'), '# Hi');
  assert.equal(cleanOutput('  plain  '), 'plain');
});

test('needsTranslation keeps alt and aria-label values and ignores glossary-only text', () => {
  assert.equal(
    needsTranslation('<a aria-label="Sponsors" href="https://x.y"><img src="a.svg"></a>'),
    true,
  );
  assert.equal(needsTranslation('<img alt="Translation Progress" src="a.svg">'), true);
  assert.equal(needsTranslation('# LibreChat'), false);
});

test('validate rejects echoed, refused and truncated output for a target language', () => {
  const source = 'This sentence should become Russian for sure.';
  assert.ok(validate(source, source, 'ru').includes('output is not in the target language'));
  assert.ok(validate(source, 'Sorry, I cannot translate that.', 'ru').length > 0);
  assert.deepEqual(validate(source, 'Это предложение обязательно станет русским.', 'ru'), []);
  assert.ok(validate(source, 'Это', 'ru').includes('output is truncated'));
  assert.deepEqual(validate('Features', 'Features', 'ru'), []);
});

test('renderSwitcher links only available languages', () => {
  const en = renderSwitcher('en', ['zh']);
  assert.match(en, /README\.zh\.md/);
  assert.doesNotMatch(en, /README\.ru\.md/);
});

test('validate checks ordered lists and repeated links, and skips indented code', () => {
  assert.ok(validate('1. One\n2. Two', '1. Один', 'ru').length > 0);
  const twice = '[a](https://x.y) and [b](https://x.y)';
  assert.ok(validate(twice, '[а](https://x.y)', 'ru').length > 0);
  assert.equal(needsTranslation('    npm run build\n    npm test'), false);
});

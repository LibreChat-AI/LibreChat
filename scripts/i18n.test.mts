import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { isTranslationReferenced } from './i18n.mts';

test('recognizes direct references and count-selected plural forms', () => {
  const references = new Set(['com_chat_count', 'com_direct_one']);
  const isReferenced = (key: string) => references.has(key);
  assert.equal(isTranslationReferenced('com_chat_count', isReferenced), true);
  assert.equal(isTranslationReferenced('com_direct_one', isReferenced), true);
  for (const suffix of ['zero', 'one', 'two', 'few', 'many', 'other']) {
    assert.equal(isTranslationReferenced(`com_chat_count_${suffix}`, isReferenced), true);
    assert.equal(isTranslationReferenced(`com_chat_count_ordinal_${suffix}`, isReferenced), true);
  }
});

test('does not exempt unused plural families or unrelated suffixes', () => {
  const isReferenced = (key: string) => key === 'com_chat_count';
  for (const key of [
    'com_unused',
    'com_unused_one',
    'com_unused_ordinal_other',
    'com_chat_count_single',
  ]) {
    assert.equal(isTranslationReferenced(key, isReferenced), false);
  }
});

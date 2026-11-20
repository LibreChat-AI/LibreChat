import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  hasTranslation,
  isTranslationReferenced,
  referenceIn,
  referencedTranslations,
} from './i18n.mts';

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

test('reads a reference from a token that is the key or holds it', () => {
  const isReferenced = referenceIn(new Set(['com_ui_copy', 'wrap_com_ui_stop_here', 'localize']));
  assert.equal(isReferenced('com_ui_copy'), true);
  assert.equal(isReferenced('com_ui_stop'), true);
  assert.equal(isReferenced('com_ui_send'), false);
});

test('picks the translations a source refers to, with every plural form of a counted key', () => {
  const translations = {
    com_ui_copy: 'Copy',
    com_ui_files_one: '{{count}} file',
    com_ui_files_other: '{{count}} files',
    com_ui_rank_ordinal_two: '{{count}}nd',
    com_nav_settings: 'Settings',
    com_ui_files_dropped: 'Dropped',
  };
  const picked = referencedTranslations(
    translations,
    new Set(['com_ui_copy', 'com_ui_files', 'com_ui_rank']),
  );
  assert.deepEqual(picked, {
    com_ui_copy: 'Copy',
    com_ui_files_one: '{{count}} file',
    com_ui_files_other: '{{count}} files',
    com_ui_rank_ordinal_two: '{{count}}nd',
  });
});

test('finds copy for a key under its own name or its plural forms, and nowhere else', () => {
  const translations = { com_ui_copy: 'Copy', com_ui_files_one: '1', com_ui_files_other: 'n' };
  assert.equal(hasTranslation('com_ui_copy', translations), true);
  assert.equal(hasTranslation('com_ui_files', translations), true);
  assert.equal(hasTranslation('com_ui', translations), false);
  assert.equal(hasTranslation('com_ui_send', translations), false);
});

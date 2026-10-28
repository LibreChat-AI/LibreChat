import test from 'node:test';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { initializeBrowser } from './browser.mjs';
import { resolveComposerKeyDown } from '../../client/src/utils/shortcuts.ts';

const enter = { key: 'Enter', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
const context = {
  isComposing: false,
  isSubmitting: false,
  allowSubmitWhileGenerating: false,
  hasDuringRunModifier: false,
  shortcutsEnabled: true,
  submitOverride: undefined,
  yieldedChords: new Set(),
};

test('native acceptance opts into Enter submission before navigation and after reload', () => {
  const values = new Map();
  const localStorage = { setItem: (key, value) => values.set(key, value) };
  const action = () =>
    resolveComposerKeyDown(enter, {
      ...context,
      enterToSend: JSON.parse(values.get('enterToSend') ?? 'false'),
    });

  assert.equal(action(), 'newline');
  for (let navigation = 0; navigation < 2; navigation++) {
    runInNewContext(`(${initializeBrowser.toString()})()`, { localStorage });
    assert.equal(values.get('enterToSend'), 'true');
    assert.equal(action(), 'submit');
  }
});

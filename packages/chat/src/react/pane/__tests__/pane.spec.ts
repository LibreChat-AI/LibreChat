import { createStore } from 'jotai';
import type { TPreset } from 'librechat-data-provider';
import type { ExtendedFile } from '../../../core/files';
import { presetFamily, filesFamily, optionSettingsFamily } from '../index';

describe('pane families', () => {
  it('start empty for every pane', () => {
    const store = createStore();
    expect(store.get(presetFamily(0))).toBeNull();
    expect(store.get(optionSettingsFamily(0))).toEqual({});
    expect(store.get(filesFamily(0)).size).toBe(0);
  });

  it('keep each pane independent', () => {
    const store = createStore();
    store.set(presetFamily(0), { title: 'first' } as TPreset);
    store.set(optionSettingsFamily(0), { showExamples: true });
    store.set(filesFamily(0), new Map([['file-1', { file_id: 'file-1' } as ExtendedFile]]));

    expect(store.get(presetFamily(1))).toBeNull();
    expect(store.get(optionSettingsFamily(1))).toEqual({});
    expect(store.get(filesFamily(1)).size).toBe(0);
    expect(store.get(presetFamily(0))?.title).toBe('first');
    expect(store.get(optionSettingsFamily(0)).showExamples).toBe(true);
    expect([...store.get(filesFamily(0)).keys()]).toEqual(['file-1']);
  });
});

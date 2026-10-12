import type { TImageSpec } from 'librechat-data-provider';
import { imageOptionChips } from '../imageOptionChips';

const localize = (key: string) => key;
const hd: TImageSpec = {
  name: 'gpt-image-2-hd',
  label: 'HD',
  model: 'gpt-image-2-h',
  protocol: 'openai',
  options: { sizes: ['1024x1024', '1536x1024'] },
};
const gemini: TImageSpec = {
  name: 'gemini',
  label: 'Gemini',
  model: 'gemini-3-pro-image',
  protocol: 'gemini',
  options: { aspectRatios: ['1:1', '16:9'], imageSizes: ['1K', '4K'] },
};

describe('imageOptionChips', () => {
  it('makes one chip per honoured parameter, ratio before resolution', () => {
    const chips = imageOptionChips({ spec: gemini, choice: undefined, pick: jest.fn(), localize });
    expect(chips.map((chip) => chip.label)).toEqual(['com_ui_aspect_ratio', 'com_ui_resolution']);
    expect(chips.every((chip) => chip.active && !chip.pinned && chip.favoritable === false)).toBe(
      true,
    );
    expect(
      imageOptionChips({
        spec: { ...gemini, options: {} },
        choice: undefined,
        pick: jest.fn(),
        localize,
      }),
    ).toEqual([]);
  });

  it('labels sizes by shape and marks the pinned value', () => {
    const [size] = imageOptionChips({
      spec: hd,
      choice: { size: '1536x1024' },
      pick: jest.fn(),
      localize,
    });
    expect(size.label).toBe('com_ui_image_size');
    expect(size.chipModes?.map((mode) => mode.label)).toEqual([
      'com_ui_auto',
      '1:1 · 1024×1024',
      '3:2 · 1536×1024',
    ]);
    expect(size.chipModes?.find((mode) => mode.active)?.id).toBe('1536x1024');
    expect(size.chipRemovable).toBe(true);
  });

  it('treats a pinned value the model no longer lists as Auto', () => {
    const [size] = imageOptionChips({
      spec: hd,
      choice: { size: '3840x2160' },
      pick: jest.fn(),
      localize,
    });
    expect(size.chipModes?.find((mode) => mode.active)?.id).toBe('auto');
    expect(size.chipRemovable).toBe(false);
  });

  it('picks a value from the menu, and Auto or ✕ clears it', () => {
    const pick = jest.fn();
    const [ratio] = imageOptionChips({
      spec: gemini,
      choice: { aspectRatio: '16:9' },
      pick,
      localize,
    });
    ratio.chipModes?.find((mode) => mode.id === '1:1')?.onSelect();
    ratio.chipModes?.find((mode) => mode.id === 'auto')?.onSelect();
    ratio.onSelect();
    expect(pick.mock.calls).toEqual([
      ['aspectRatio', '1:1'],
      ['aspectRatio', undefined],
      ['aspectRatio', undefined],
    ]);
  });
});

import type { TImageSpec } from 'librechat-data-provider';
import { IMAGE_CHOICES_KEY, activeImageSpec, sizeLabel, withImageChoice } from '../imageOptions';

const list: TImageSpec[] = [
  { name: 'gpt-image', label: 'GPT Image', model: 'gpt-image-2', protocol: 'openai', options: {} },
  {
    name: 'hd',
    label: 'HD',
    model: 'gpt-image-2-h',
    protocol: 'openai',
    default: true,
    options: { sizes: ['1024x1024', '1536x1024'] },
  },
  {
    name: 'gemini',
    label: 'Gemini',
    model: 'gemini-3-pro-image',
    protocol: 'gemini',
    options: { aspectRatios: ['16:9'], imageSizes: ['2K'] },
  },
];

describe('imageOptions', () => {
  beforeEach(() => localStorage.clear());

  it('resolves the active entry the way the server does', () => {
    expect(activeImageSpec(true, list)?.name).toBe('hd');
    expect(activeImageSpec('gemini', list)?.name).toBe('gemini');
    expect(activeImageSpec('retired', list)?.name).toBe('hd');
    expect(activeImageSpec(false, list)).toBeUndefined();
  });

  it('labels a size by the shape it makes', () => {
    expect(sizeLabel('1536x1024')).toBe('3:2 · 1536×1024');
    expect(sizeLabel('3840x2160')).toBe('16:9 · 3840×2160');
    expect(sizeLabel('auto')).toBe('auto');
  });

  it("sends the active model's pinned choice and nothing it does not offer", () => {
    localStorage.setItem(
      IMAGE_CHOICES_KEY,
      JSON.stringify({
        hd: { size: '1536x1024', aspectRatio: '16:9' },
        gemini: { imageSize: '2K' },
      }),
    );
    expect(withImageChoice({ image_gen: true }, list)).toEqual({
      image_gen: true,
      image_options: { size: '1536x1024' },
    });
    expect(withImageChoice({ image_gen: 'gemini' }, list)).toEqual({
      image_gen: 'gemini',
      image_options: { imageSize: '2K' },
    });
  });

  it("never ships another model's choice, and leaves an agent without Image Gen alone", () => {
    localStorage.setItem(IMAGE_CHOICES_KEY, JSON.stringify({ hd: { size: '1536x1024' } }));
    expect(
      withImageChoice({ image_gen: 'gpt-image', image_options: { size: '1536x1024' } }, list),
    ).toEqual({
      image_gen: 'gpt-image',
    });
    const plain = { web_search: true };
    expect(withImageChoice(plain, list)).toBe(plain);
    expect(withImageChoice(undefined, list)).toBeUndefined();
  });

  it('survives unreadable storage', () => {
    localStorage.setItem(IMAGE_CHOICES_KEY, '{not json');
    expect(withImageChoice({ image_gen: true }, list)).toEqual({ image_gen: true });
  });
});

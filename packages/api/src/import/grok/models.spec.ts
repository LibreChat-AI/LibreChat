import { resolveGrokModel } from './models';

const FALLBACK = 'gpt-4o-mini';

describe('resolveGrokModel', () => {
  /** Every model slug present in a real 771-response export. */
  const REAL_SLUGS: [string, string][] = [
    ['grok-3', 'Grok 3'],
    ['grok-4', 'Grok 4'],
    ['grok-420', 'Grok 420'],
    ['grok-4-auto', 'Grok 4 Auto'],
    ['grok-4-1-thinking-1129', 'Grok 4.1 Thinking'],
    ['grok-4-1-thinking-1108b', 'Grok 4.1 Thinking'],
    ['grok-4-1-non-thinking-w-tool', 'Grok 4.1'],
    ['grok-4-mini-thinking-tahoe', 'Grok 4 mini Thinking'],
    ['grok-4p3-0430-v2-s320-memory', 'Grok 4.3'],
  ];

  it.each(REAL_SLUGS)('keeps %s and displays it as %s', (slug, sender) => {
    expect(resolveGrokModel(slug, FALLBACK)).toEqual({ model: slug, sender });
  });

  it('falls back to the endpoint default and the plain provider name for a blank model', () => {
    expect(resolveGrokModel('', FALLBACK)).toEqual({ model: FALLBACK, sender: 'Grok' });
    expect(resolveGrokModel(null, FALLBACK)).toEqual({ model: FALLBACK, sender: 'Grok' });
    expect(resolveGrokModel(undefined, FALLBACK)).toEqual({ model: FALLBACK, sender: 'Grok' });
  });

  it('never emits an empty model', () => {
    for (const [slug] of REAL_SLUGS) {
      expect(resolveGrokModel(slug, FALLBACK).model.length).toBeGreaterThan(0);
    }
    expect(resolveGrokModel('', FALLBACK).model.length).toBeGreaterThan(0);
  });

  it('titles a bare provider slug and passes any other slug through unchanged', () => {
    expect(resolveGrokModel('grok', FALLBACK)).toEqual({ model: 'grok', sender: 'Grok' });
    expect(resolveGrokModel('GROK', FALLBACK)).toEqual({ model: 'GROK', sender: 'Grok' });
    expect(resolveGrokModel('gpt-5', FALLBACK)).toEqual({ model: 'gpt-5', sender: 'gpt-5' });
  });

  it('labels the suffixes a future slug may add and drops build noise', () => {
    expect(resolveGrokModel('grok-5-fast-reasoning-0901', FALLBACK).sender).toBe(
      'Grok 5 Fast Reasoning',
    );
    expect(resolveGrokModel('grok-5-1-heavy', FALLBACK).sender).toBe('Grok 5.1 Heavy');
    expect(resolveGrokModel('grok-6', FALLBACK).sender).toBe('Grok 6');
  });
});

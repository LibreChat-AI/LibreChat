import type { HostEditWorkLimits } from './matching';
import { applyTextEdits } from './matching';

const limits: HostEditWorkLimits = {
  maxEdits: 100,
  maxWorkBytes: 64 * 1024 * 1024,
  maxOccurrences: 100000,
  maxOutputBytes: 10 * 1024 * 1024,
};

describe('cumulative host edit accounting', () => {
  it('charges input, matching, and reconstruction once for a full-context exact edit', () => {
    const edits = [{ old_text: 'ax', new_text: 'bx' }];
    expect(applyTextEdits('ax', edits, { ...limits, maxWorkBytes: 12 })).toEqual({
      content: 'bx',
      strategies: ['exact'],
    });
    expect(() => applyTextEdits('ax', edits, { ...limits, maxWorkBytes: 11 })).toThrow(
      'budget exceeded',
    );
  });

  it('charges contraction as well as growth across a batch', () => {
    const edits = [
      { old_text: 'a', new_text: 'b', replace_all: true },
      { old_text: 'b', new_text: 'a', replace_all: true },
      { old_text: 'a', new_text: '', replace_all: true },
    ];
    expect(applyTextEdits('a', edits, { ...limits, maxWorkBytes: 16 })).toEqual({
      content: '',
      strategies: ['exact', 'exact', 'exact'],
    });
    expect(() => applyTextEdits('a', edits, { ...limits, maxWorkBytes: 15 })).toThrow(
      'budget exceeded',
    );
  });

  it('remeasures UTF-8 sizes after each replacement and rejects oversized intermediates', () => {
    const edits = [
      { old_text: 'a', new_text: 'é', replace_all: true },
      { old_text: 'é', new_text: '😀', replace_all: true },
      { old_text: '😀', new_text: '', replace_all: true },
    ];
    expect(() => applyTextEdits('aa', edits, { ...limits, maxOutputBytes: 7 })).toThrow(
      'larger than',
    );
    expect(applyTextEdits('aa', edits, { ...limits, maxOutputBytes: 8 }).content).toBe('');
  });

  it('keeps exact offsets and output size after a tolerant replacement', () => {
    const edits = [
      { old_text: 'two words', new_text: 'é' },
      { old_text: 'é', new_text: '😀' },
    ];
    expect(applyTextEdits('two  words', edits, { ...limits, maxOutputBytes: 10 })).toEqual({
      content: '😀',
      strategies: ['whitespace-normalized', 'exact'],
    });
  });
});

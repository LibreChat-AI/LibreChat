import { normalizeEditArgs } from './edits';

describe('normalizeEditArgs', () => {
  test.each(
    [
      [],
      '[]',
      null,
      undefined,
      {},
      { old_text: 'original', new_text: 'replacement' },
      'not json',
      'null',
      1,
      true,
      [null],
      [[]],
      [{ old_text: 'original' }],
      [{ old_text: '', new_text: 'replacement' }],
      [{ old_text: 'original', new_text: 'replacement', replace_all: 'yes' }],
    ].map((edits) => [edits]),
  )('rejects supplied invalid edits %# instead of using top-level replacements', (edits) => {
    expect(typeof normalizeEditArgs({ edits, old_text: 'original', new_text: 'replacement' })).toBe(
      'string',
    );
  });

  test('normalizes a single replacement without changing the input', () => {
    const args = { old_text: 'original', new_text: '', replace_all: 'true' };
    expect(normalizeEditArgs(args)).toEqual([
      { old_text: 'original', new_text: '', replace_all: true },
    ]);
    expect(args.replace_all).toBe('true');
  });

  test.each(
    [
      [{ old_text: 'batch', new_text: 'replacement', replace_all: 'false' }],
      JSON.stringify([{ old_text: 'batch', new_text: 'replacement', replace_all: 'false' }]),
      [JSON.stringify({ old_text: 'batch', new_text: 'replacement', replace_all: 'false' })],
    ].map((edits) => [edits]),
  )('normalizes valid batches %# and never selects ignored top-level fields', (edits) => {
    const normalized = normalizeEditArgs({
      edits,
      old_text: 'ignored',
      new_text: 'ignored',
      replace_all: true,
    });
    expect(normalized).toEqual([{ old_text: 'batch', new_text: 'replacement' }]);
    expect(normalizeEditArgs({ edits: normalized })).toEqual(normalized);
  });
});

import { admitCurrentFileBudget } from './budget';

it('rejects an overlapping current file before priming can reuse its admission', () => {
  const file = { file_id: 'retained-project', bytes: 2 * 1024 * 1024 };
  expect(admitCurrentFileBudget([file], 1024 * 1024)).toEqual([]);
});

it('charges duplicate current files only once under a shared total', () => {
  const first = { file_id: 'current', bytes: 512 };
  const other = { file_id: 'other', bytes: 512 };
  expect(admitCurrentFileBudget([first, first, other], 1024)).toEqual([first, other]);
});

it('keeps later files that fit after rejecting an over-budget candidate', () => {
  const files = [
    { file_id: 'first', bytes: 512 },
    { file_id: 'oversized', bytes: 2048 },
    { file_id: 'last', bytes: 512 },
  ];
  expect(admitCurrentFileBudget(files, 1024)).toEqual([files[0], files[2]]);
});

it.each([undefined, 0, -1])('retains unique inputs without a positive limit: %s', (limit) => {
  const file = { file_id: 'first', bytes: 2048 };
  expect(admitCurrentFileBudget([file, file], limit)).toEqual([file]);
});

it('does not collapse files without identities or mutate the original snapshots', () => {
  const first = Object.freeze({ bytes: 512 });
  const other = Object.freeze({ bytes: 512 });
  const files = [first, other];
  const result = admitCurrentFileBudget(files, 1024);
  expect(result).toEqual(files);
  expect(result).not.toBe(files);
  expect(result[0]).toBe(first);
});

it('tolerates absent byte counts on an otherwise admitted snapshot', () => {
  const file = { file_id: 'legacy' };
  expect(admitCurrentFileBudget([file], 1)).toEqual([file]);
});

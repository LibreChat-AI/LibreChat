import { LocalStorageKeys } from 'librechat-data-provider';
import { captureFilesToDelete } from '../useSetFilesToDelete';

const key = LocalStorageKeys.FILES_TO_DELETE;
const original = { file_id: 'file-original', progress: 1 };
const write = (files: Record<string, unknown>) => localStorage.setItem(key, JSON.stringify(files));
const read = () => JSON.parse(localStorage.getItem(key) ?? '{}');
afterEach(() => {
  jest.restoreAllMocks();
  localStorage.clear();
});

it('removes captured markers while keeping another pane and a newly added upload', () => {
  write({ owned: original, other: { file_id: 'other-pane' } });
  const commit = captureFilesToDelete(['owned']);
  write({ owned: original, other: { file_id: 'other-pane' }, added: { file_id: 'new-upload' } });
  commit();
  expect(read()).toEqual({ other: { file_id: 'other-pane' }, added: { file_id: 'new-upload' } });
});

it.each([
  { ...original, progress: 0.5 },
  { file_id: 'replacement', progress: 1 },
])('preserves a newer same-key marker: %j', (replacement) => {
  write({ owned: original });
  const commit = captureFilesToDelete(['owned']);
  write({ owned: replacement });
  commit();
  expect(read()).toEqual({ owned: replacement });
});

it('returns a no-op capture when reading storage is denied', () => {
  write({ owned: original });
  jest.spyOn(Storage.prototype, 'getItem').mockImplementationOnce(() => {
    throw new Error('denied');
  });
  const set = jest.spyOn(Storage.prototype, 'setItem');
  const commit = captureFilesToDelete(['owned']);
  expect(() => commit()).not.toThrow();
  expect(set).not.toHaveBeenCalled();
  expect(read()).toEqual({ owned: original });
});

it('does not interrupt accepted ownership when cleanup storage becomes unavailable', () => {
  write({ owned: original });
  const commit = captureFilesToDelete(['owned']);
  jest.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
    throw new Error('denied');
  });
  expect(() => commit()).not.toThrow();
});

it.each(['[1]', 'null', '{bad'])('leaves unsupported legacy storage alone: %s', (raw) => {
  localStorage.setItem(key, raw);
  const set = jest.spyOn(Storage.prototype, 'setItem');
  captureFilesToDelete(['owned'])();
  expect(set).not.toHaveBeenCalled();
});

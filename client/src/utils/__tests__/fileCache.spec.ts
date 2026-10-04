import { QueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { TFile } from 'librechat-data-provider';
import { addFileToCache, addFilesToCache } from '../files';

const file: TFile = {
  file_id: 'one',
  user: 'owner',
  filename: 'one.png',
  filepath: '/images/one.png',
  type: 'image/png',
  bytes: 10,
  object: 'file',
  usage: 0,
  embedded: false,
};

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient();
});
afterEach(() => client.clear());

test('stores a streamed file before the files query has loaded', () => {
  addFileToCache(client, file);
  expect(client.getQueryData([QueryKeys.files])).toEqual([file]);
});

test('still loads the full list after a file was cached before the first load', async () => {
  addFileToCache(client, file);
  const listed = { ...file, file_id: 'listed' };
  const getFiles = jest.fn(async () => [file, listed]);
  const observer = new QueryObserver(client, {
    queryKey: [QueryKeys.files],
    queryFn: getFiles,
    refetchOnMount: false,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  unsubscribe();
  expect(getFiles).toHaveBeenCalledTimes(1);
  expect(client.getQueryData([QueryKeys.files])).toEqual([file, listed]);
});

test('does not refetch a loaded list when a file is added, but refreshes the recent files', () => {
  client.setQueryData([QueryKeys.files], [file]);
  client.setQueryData([QueryKeys.files, 'recent'], [file]);
  addFileToCache(client, { ...file, file_id: 'two' });
  expect(client.getQueryState([QueryKeys.files])?.isInvalidated).toBe(false);
  expect(client.getQueryState([QueryKeys.files, 'recent'])?.isInvalidated).toBe(true);
});

test('keeps new files first and preserves each distinct streamed file', () => {
  client.setQueryData([QueryKeys.files], [file]);
  addFileToCache(client, { ...file, file_id: 'two' });
  addFileToCache(client, { ...file, file_id: 'three' });
  expect(client.getQueryData<TFile[]>([QueryKeys.files])?.map((item) => item.file_id)).toEqual([
    'three',
    'two',
    'one',
  ]);
});

test('merges refreshed metadata into the same file without duplicates or moving it', () => {
  client.setQueryData(
    [QueryKeys.files],
    [
      { ...file, file_id: 'newer' },
      { ...file, metadata: { fileIdentifier: 'original' } },
    ],
  );
  addFileToCache(client, { ...file, filename: 'updated.png', bytes: 20 });
  expect(client.getQueryData([QueryKeys.files])).toEqual([
    expect.objectContaining({ file_id: 'newer' }),
    expect.objectContaining({
      file_id: 'one',
      filename: 'updated.png',
      bytes: 20,
      embedded: false,
      metadata: { fileIdentifier: 'original' },
    }),
  ]);
});

test('prepends a bulk upload in input order and merges repeated IDs once', () => {
  client.setQueryData(
    [QueryKeys.files],
    [
      { ...file, file_id: 'newer' },
      { ...file, metadata: { fileIdentifier: 'original' } },
    ],
  );
  addFilesToCache(client, [
    { ...file, file_id: 'upload-a' },
    { ...file, filename: 'updated.png' },
    { ...file, file_id: 'upload-b' },
    { ...file, file_id: 'upload-a', bytes: 20 },
  ]);
  expect(client.getQueryData([QueryKeys.files])).toEqual([
    expect.objectContaining({ file_id: 'upload-a', bytes: 20 }),
    expect.objectContaining({ file_id: 'upload-b' }),
    expect.objectContaining({ file_id: 'newer' }),
    expect.objectContaining({
      file_id: 'one',
      filename: 'updated.png',
      metadata: { fileIdentifier: 'original' },
    }),
  ]);
});

import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { dataService, QueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MediaAsset, TFile } from 'librechat-data-provider';
import { cacheMediaAssets } from '../files';
import { useMediaUpload } from '../uploads';

jest.mock('librechat-data-provider', () => {
  const actual =
    jest.requireActual<typeof import('librechat-data-provider')>('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService } };
});

const asset: MediaAsset = {
  file_id: 'image',
  filename: 'image.png',
  filepath: '/api/media/files/image',
  type: 'image/png',
  bytes: 100,
};

test('media ingress initializes Files cache and preserves richer existing attachment metadata', () => {
  const client = new QueryClient();
  cacheMediaAssets(client, 'owner', [asset]);
  expect(client.getQueryData<TFile[]>([QueryKeys.files])).toEqual([
    expect.objectContaining({ file_id: 'image', user: 'owner', bytes: 100 }),
  ]);
  client.setQueryData<TFile[]>([QueryKeys.files], (files = []) =>
    files.map((file) => ({
      ...file,
      embedded: true,
      usage: 5,
      metadata: { fileIdentifier: 'existing' },
    })),
  );
  cacheMediaAssets(client, 'owner', [{ ...asset, filename: 'updated.png', width: 640 }, asset]);
  expect(client.getQueryData<TFile[]>([QueryKeys.files])).toHaveLength(1);
  expect(client.getQueryData<TFile[]>([QueryKeys.files])![0]).toMatchObject({
    embedded: true,
    usage: 5,
    width: 640,
    metadata: { fileIdentifier: 'existing' },
  });
  client.clear();
});

test('uploads populate the cache only while their authenticated editor still owns them', async () => {
  let resolve!: (value: { file: MediaAsset }) => void;
  const upload = jest.spyOn(dataService, 'uploadMedia').mockImplementation(
    () =>
      new Promise((accept) => {
        resolve = accept;
      }),
  );
  const client = new QueryClient();
  let active = true;
  const host = { userId: 'owner', isCurrentSession: () => active };
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(({ owner }) => useMediaUpload(host, owner), {
    wrapper,
    initialProps: { owner: 'draft-1' },
  });
  let first!: Promise<{ file: MediaAsset } | undefined>;
  await act(async () => {
    first = hook.result.current.uploadFile(new FormData());
  });
  await act(async () => {
    resolve({ file: asset });
    await first;
  });
  expect(client.getQueryData<TFile[]>([QueryKeys.files])![0].file_id).toBe('image');
  let late!: Promise<{ file: MediaAsset } | undefined>;
  await act(async () => {
    late = hook.result.current.uploadFile(new FormData());
  });
  active = false;
  client.removeQueries([QueryKeys.files]);
  await act(async () => {
    resolve({ file: { ...asset, file_id: 'late' } });
    await late;
  });
  expect(client.getQueryData([QueryKeys.files])).toBeUndefined();
  upload.mockRestore();
  hook.unmount();
  client.clear();
});

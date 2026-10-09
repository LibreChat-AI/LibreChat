import React from 'react';
import { QueryKeys, FileSources } from 'librechat-data-provider';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TFile, TFileUpload } from 'librechat-data-provider';

const mockUploadFile = jest.fn();

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      uploadFile: (...args: unknown[]) => mockUploadFile(...args),
      uploadImage: (...args: unknown[]) => mockUploadFile(...args),
    },
  };
});

jest.mock('../../Endpoints', () => ({
  useGetStartupConfig: () => ({ data: undefined }),
}));

import { useUploadFileMutation } from '../mutations';

const REQUEST_FILE_ID = 'client-request-id';

const uploadResponse = {
  file_id: 'server-file-id',
  temp_file_id: 'an-id-the-client-never-sent',
  filename: 'notes.txt',
  filepath: '/files/notes.txt',
  type: 'text/plain',
  bytes: 12,
  object: 'file',
  usage: 0,
  user: 'user-1',
  embedded: false,
  source: FileSources.local,
} as unknown as TFileUpload;

const body = () => {
  const formData = new FormData();
  formData.append('file_id', REQUEST_FILE_ID);
  formData.append('message_file', 'true');
  return formData;
};

/**
 * The composer keys its file map, and the draft it saves, by the `file_id` the
 * request was sent with; `temp_file_id` is only the server's echo of that id.
 * A cached record carrying an echo that disagrees cannot be correlated back to
 * the draft, so `useAutoSave` cannot restore the attachment after a conversation
 * switch or a reload.
 */
describe('useUploadFileMutation — temporary id normalization', () => {
  let queryClient: QueryClient;

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    mockUploadFile.mockReset();
    mockUploadFile.mockResolvedValue(uploadResponse);
  });

  test('caches the uploaded record under the id the request was sent with', async () => {
    const { result } = renderHook(() => useUploadFileMutation(), { wrapper });

    act(() => {
      result.current.mutate(body());
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [cached] = queryClient.getQueryData<TFile[]>([QueryKeys.files]) ?? [];
    expect(cached).toMatchObject({
      file_id: 'server-file-id',
      temp_file_id: REQUEST_FILE_ID,
    });
  });

  test('hands the normalized record to the caller', async () => {
    const onSuccess = jest.fn();
    const { result } = renderHook(() => useUploadFileMutation({ onSuccess }), { wrapper });

    act(() => {
      result.current.mutate(body());
    });

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());

    expect(onSuccess.mock.calls[0][0]).toMatchObject({ temp_file_id: REQUEST_FILE_ID });
  });

  test('leaves an agreeing response untouched', async () => {
    mockUploadFile.mockResolvedValue({ ...uploadResponse, temp_file_id: REQUEST_FILE_ID });
    const onSuccess = jest.fn();
    const { result } = renderHook(() => useUploadFileMutation({ onSuccess }), { wrapper });

    act(() => {
      result.current.mutate(body());
    });

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());

    const [cached] = queryClient.getQueryData<TFile[]>([QueryKeys.files]) ?? [];
    expect(cached).toBe(onSuccess.mock.calls[0][0]);
  });
});

import React from 'react';
import { QueryKeys } from 'librechat-data-provider';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TSkill, TSkillListResponse } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import {
  useCreateSkillMutation,
  useDeleteSkillMutation,
  useImportSkillMutation,
  useUploadSkillFileMutation,
} from '../mutations';
import { useSkillsInfiniteQuery, useListSkillFilesQuery } from '../queries';

const mockCreateSkill = jest.fn();
const mockDeleteSkill = jest.fn();
const mockImportSkill = jest.fn();
const mockListSkills = jest.fn();
const mockUploadSkillFile = jest.fn();
const mockListSkillFiles = jest.fn();

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      createSkill: (...args: unknown[]) => mockCreateSkill(...args),
      deleteSkill: (...args: unknown[]) => mockDeleteSkill(...args),
      importSkill: (...args: unknown[]) => mockImportSkill(...args),
      listSkills: (...args: unknown[]) => mockListSkills(...args),
      uploadSkillFile: (...args: unknown[]) => mockUploadSkillFile(...args),
      listSkillFiles: (...args: unknown[]) => mockListSkillFiles(...args),
    },
  };
});

function makeSkill(id: string, name: string): TSkill {
  return {
    _id: id,
    name,
    description: `${name} description`,
    body: `# ${name}`,
    author: 'user-1',
    authorName: 'E2E User',
    version: 1,
    source: 'inline',
    fileCount: 0,
    createdAt: '2026-07-24T00:00:00.000Z',
    updatedAt: '2026-07-24T00:00:00.000Z',
  } as TSkill;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('skill creation cache updates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps a created skill when a stale next-page request finishes afterward', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const firstSkill = makeSkill('first-id', 'first-skill');
    const createdSkill = makeSkill('created-id', 'created-skill');
    const stalePage = deferred<TSkillListResponse>();
    const firstPage: TSkillListResponse = {
      skills: [firstSkill],
      has_more: true,
      after: 'cursor-1',
    };
    const freshPage: TSkillListResponse = {
      skills: [createdSkill, firstSkill],
      has_more: false,
      after: null,
    };
    const queryKey = [QueryKeys.skills, 'infinite', '', '', 100];
    queryClient.setQueryData(queryKey, {
      pages: [firstPage],
      pageParams: [undefined],
    });
    mockCreateSkill.mockResolvedValue(createdSkill);
    mockListSkills.mockImplementation(({ cursor }: { cursor?: string }) =>
      cursor === 'cursor-1' ? stalePage.promise : Promise.resolve(freshPage),
    );
    const cancelQueries = jest.spyOn(queryClient, 'cancelQueries');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(
      () => ({
        list: useSkillsInfiniteQuery({ limit: 100 }),
        create: useCreateSkillMutation(),
      }),
      { wrapper },
    );

    let staleRequest: Promise<unknown>;
    act(() => {
      staleRequest = result.current.list.fetchNextPage();
    });
    await waitFor(() =>
      expect(mockListSkills).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: 'cursor-1', limit: 100 }),
      ),
    );

    await act(async () => {
      await result.current.create.mutateAsync({
        name: createdSkill.name,
        description: createdSkill.description,
        body: createdSkill.body,
      });
    });

    expect(cancelQueries).toHaveBeenCalledWith([QueryKeys.skills]);
    await waitFor(() =>
      expect(
        queryClient
          .getQueryData<{ pages: TSkillListResponse[] }>(queryKey)
          ?.pages.flatMap((page) => page.skills)
          .map((skill) => skill._id),
      ).toContain(createdSkill._id),
    );

    stalePage.resolve({
      skills: [makeSkill('second-id', 'second-skill')],
      has_more: false,
      after: null,
    });
    await act(async () => {
      await Promise.allSettled([staleRequest]);
    });

    expect(
      queryClient
        .getQueryData<{ pages: TSkillListResponse[] }>(queryKey)
        ?.pages.flatMap((page) => page.skills)
        .map((skill) => skill._id),
    ).toContain(createdSkill._id);

    queryClient.clear();
  });

  it.each([
    'skill_import_incomplete',
    'skill_import_rollback_failed',
    'skill_import_cleanup_incomplete',
  ])('invalidates skill lists after %s', async (errorCode) => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const invalidateQueries = jest.spyOn(queryClient, 'invalidateQueries');
    const staleListKey = [QueryKeys.skills, 'infinite', '', '', 100];
    queryClient.setQueryData(staleListKey, {
      pages: [{ skills: [makeSkill('leftover-skill', 'leftover')], has_more: false, after: null }],
      pageParams: [undefined],
    });
    mockImportSkill.mockRejectedValue({
      response: {
        data: {
          error: errorCode,
          skillId: 'leftover-skill',
          failedFiles: [{ path: 'queries.sql', reason: 'persistence_failed' }],
        },
      },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useImportSkillMutation(), { wrapper });

    await act(async () => {
      await expect(result.current.mutateAsync(new FormData())).rejects.toBeDefined();
    });

    expect(invalidateQueries).toHaveBeenCalledWith([QueryKeys.skills]);
    expect(queryClient.getQueryData(staleListKey)).toBeUndefined();
    queryClient.clear();
  });

  it('evicts a deleted skill when dependent server cleanup is incomplete', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const skill = makeSkill('deleted-id', 'deleted-skill');
    const queryKey = [QueryKeys.skills, 'infinite', '', '', 100];
    queryClient.setQueryData([QueryKeys.skill, skill._id], skill);
    queryClient.setQueryData(queryKey, {
      pages: [{ skills: [skill], has_more: false, after: null }],
      pageParams: [undefined],
    });
    mockDeleteSkill.mockResolvedValue({
      id: skill._id,
      deleted: true,
      cleanupComplete: false,
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useDeleteSkillMutation(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ id: skill._id });
    });

    expect(queryClient.getQueryData([QueryKeys.skill, skill._id])).toBeUndefined();
    expect(
      queryClient
        .getQueryData<{ pages: TSkillListResponse[] }>(queryKey)
        ?.pages.flatMap((page) => page.skills),
    ).toEqual([]);
    queryClient.clear();
  });
});

describe('skill file replacement cache', () => {
  it('fetches the complete list when a direct-file save had no list cache', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const saved = { relativePath: 'references/edited.md' };
    const sibling = { relativePath: 'scripts/run.sh' };
    mockUploadSkillFile.mockResolvedValue(saved);
    mockListSkillFiles.mockResolvedValue({ files: [saved, sibling] });
    const { result, rerender } = renderHook(
      ({ enabled }) => ({
        upload: useUploadSkillFileMutation(),
        files: useListSkillFilesQuery('skill-id', { enabled }),
      }),
      { wrapper, initialProps: { enabled: false } },
    );
    await act(async () => {
      await result.current.upload.mutateAsync({ skillId: 'skill-id', formData: new FormData() });
    });
    expect(queryClient.getQueryData([QueryKeys.skillFiles, 'skill-id'])).toBeUndefined();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.files.data?.files).toEqual([saved, sibling]));
    queryClient.clear();
  });

  it('cancels stale in-flight list reads and refreshes a complete list after replacement', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const key = [QueryKeys.skillFiles, 'skill-id'];
    const original = { relativePath: 'references/edited.md', file_id: 'old' };
    const saved = { ...original, file_id: 'saved' };
    const sibling = { relativePath: 'scripts/run.sh' };
    queryClient.setQueryData(key, { files: [original, sibling] });
    const stale = deferred<{ files: (typeof original)[] }>();
    mockListSkillFiles
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue({ files: [saved, sibling] });
    mockUploadSkillFile.mockResolvedValue(saved);
    const { result } = renderHook(
      () => ({
        upload: useUploadSkillFileMutation(),
        files: useListSkillFilesQuery('skill-id'),
      }),
      { wrapper },
    );
    act(() => {
      void result.current.files.refetch();
    });
    await act(async () => {
      await result.current.upload.mutateAsync({ skillId: 'skill-id', formData: new FormData() });
    });
    await waitFor(() => expect(result.current.files.data?.files).toEqual([saved, sibling]));
    await act(async () => {
      stale.resolve({ files: [original] });
    });
    expect(result.current.files.data?.files).toEqual([saved, sibling]);
    queryClient.clear();
  });
});

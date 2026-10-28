import React from 'react';
import axios from 'axios';
import { QueryKeys } from 'librechat-data-provider';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TSkill } from 'librechat-data-provider';
import type { AxiosResponse } from 'axios';
import SkillFileViewer from '../SkillFileViewer';

const mockShowToast = jest.fn();
let mockCanEdit = true;

jest.mock('~/data-provider', () => ({
  useGetSkillFileContentQuery: jest.requireActual('~/data-provider/Skills/queries')
    .useGetSkillFileContentQuery,
  useUploadSkillFileMutation: jest.requireActual('~/data-provider/Skills/mutations')
    .useUploadSkillFileMutation,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<number, string>) =>
    key === 'com_ui_edited_file' ? `Edited ${values?.[0]}` : key,
  useSkillPermissions: () => ({ isLoading: false, canEdit: mockCanEdit }),
}));

jest.mock('@librechat/client', () => ({
  Button: ({
    children,
    variant: _variant,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => (
    <button {...props}>{children}</button>
  ),
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
  Spinner: () => <span data-testid="spinner" />,
  MorphIcon: () => <span />,
  TooltipAnchor: ({ render: content }: { render: React.ReactNode }) => content,
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('../SkillMarkdownRenderer', () => ({
  __esModule: true,
  default: ({ content }: { content: string }) => <pre>{content}</pre>,
}));

jest.mock('../ViewToggle', () => ({
  __esModule: true,
  default: () => <span />,
}));

const skill = { _id: 'skill-id', name: 'example', author: 'user-id', source: 'inline' } as TSkill;
const filePath = 'references/queries.md';

function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function renderViewer(
  path = filePath,
  selectedSkill = skill,
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  }),
) {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/skills/skill-id']}>
        <SkillFileViewer skill={selectedSkill} skillId={skill._id} relativePath={path} />
        <Location />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

describe('skill file editing', () => {
  beforeEach(() => {
    mockCanEdit = true;
    mockShowToast.mockClear();
  });

  it('round-trips a nested text file via the existing read and multipart replacement endpoints', async () => {
    let persisted = 'original text';
    const get = jest.spyOn(axios, 'get').mockImplementation(async (url) => {
      expect(url).toBe(`/api/skills/skill-id/files/${encodeURIComponent(filePath)}`);
      return {
        data: {
          content: persisted,
          fileId: 'revision-1',
          file_id: 'revision-2',
          filename: 'queries.md',
          relativePath: filePath,
          mimeType: 'text/markdown',
          isBinary: false,
          bytes: persisted.length,
        },
      } as AxiosResponse;
    });
    const post = jest.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      expect(url).toBe(`/api/skills/skill-id/files/${encodeURIComponent(filePath)}`);
      expect(body).toBeInstanceOf(FormData);
      const formData = body as FormData;
      expect(formData.get('relativePath')).toBe(filePath);
      expect(formData.get('expectedFileId')).toBe('revision-1');
      const file = formData.get('file');
      expect(file).toBeInstanceOf(File);
      if (!(file instanceof File)) {
        throw new Error('Expected an uploaded file');
      }
      expect(file.name).toBe('queries.md');
      expect(file.type).toBe('text/markdown');
      persisted = await readFile(file);
      return {
        data: {
          relativePath: filePath,
          fileId: 'revision-1',
          file_id: 'revision-2',
          filename: file.name,
          mimeType: file.type,
        },
      } as AxiosResponse;
    });
    const first = renderViewer();

    await screen.findByText('original text');
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_edit' }));
    const textarea = screen.getByRole('textbox', { name: 'com_ui_edit queries.md' });
    expect(textarea).toHaveValue('original text');
    fireEvent.change(textarea, { target: { value: 'persisted text' } });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));

    await waitFor(() => expect(persisted).toBe('persisted text'));
    await screen.findByText('persisted text');
    expect(mockShowToast).toHaveBeenCalledWith({ status: 'success', message: 'Edited queries.md' });
    first.unmount();
    first.queryClient.clear();

    const readsBeforeReload = get.mock.calls.length;
    const second = renderViewer();
    await screen.findByText('persisted text');
    expect(get).toHaveBeenCalledTimes(readsBeforeReload + 1);
    expect(post).toHaveBeenCalledTimes(1);
    second.queryClient.clear();
  });

  it('keeps the draft and shows an error when upload fails, then allows retry and cancel', async () => {
    let persisted = 'before';
    jest.spyOn(axios, 'get').mockImplementation(
      async () =>
        ({
          data: {
            content: persisted,
            fileId: 'revision-1',
            file_id: 'revision-2',
            filename: 'queries.md',
            relativePath: filePath,
            mimeType: 'text/markdown',
            isBinary: false,
            bytes: persisted.length,
          },
        }) as AxiosResponse,
    );
    const post = jest
      .spyOn(axios, 'post')
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockImplementationOnce(async (_url, body) => {
        const file = (body as FormData).get('file');
        if (!(file instanceof File)) {
          throw new Error('Expected an uploaded file');
        }
        persisted = await readFile(file);
        return {
          data: {
            relativePath: filePath,
            fileId: 'revision-1',
            file_id: 'revision-2',
            filename: file.name,
            mimeType: file.type,
          },
        } as AxiosResponse;
      });
    const view = renderViewer();
    await screen.findByText('before');
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_edit' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'after' } });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_skill_file_save_error');
    expect(screen.getByRole('textbox')).toHaveValue('after');
    expect(screen.getByRole('button', { name: 'com_ui_save' })).toBeEnabled();
    expect(persisted).toBe('before');
    expect(mockShowToast).toHaveBeenCalledWith({
      status: 'error',
      message: 'com_ui_skill_file_save_error',
    });

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));
    await waitFor(() => expect(persisted).toBe('after'));
    await screen.findByText('after');
    expect(post).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_edit' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unsaved' } });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_cancel' }));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(persisted).toBe('after');
    expect(post).toHaveBeenCalledTimes(2);
    view.queryClient.clear();
  });

  it.each([
    ['read-only permissions', false, 'text/markdown', false, 'visible'],
    ['binary content', true, 'image/png', true, undefined],
    ['oversized text without JSON content', true, 'text/plain', false, undefined],
  ])('hides editing for %s', async (_case, allowed, mimeType, isBinary, content) => {
    mockCanEdit = allowed;
    jest.spyOn(axios, 'get').mockResolvedValue({
      data: {
        content,
        fileId: 'revision-1',
        file_id: 'revision-2',
        filename: 'queries.md',
        relativePath: filePath,
        mimeType,
        isBinary,
        bytes: 12,
      },
    });
    const view = renderViewer();
    await screen.findByText('queries.md');
    await waitFor(() => expect(screen.queryByTestId('spinner')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'com_ui_edit' })).not.toBeInTheDocument();
    view.queryClient.clear();
  });

  it('can edit an empty text file using the keyboard shortcut', async () => {
    jest.spyOn(axios, 'get').mockResolvedValue({
      data: {
        content: '',
        fileId: 'revision-1',
        file_id: 'revision-2',
        filename: 'empty.sh',
        relativePath: 'scripts/empty.sh',
        mimeType: 'text/plain',
        isBinary: false,
        bytes: 0,
      },
    });
    const post = jest.spyOn(axios, 'post').mockResolvedValue({
      data: {
        relativePath: 'scripts/empty.sh',
        fileId: 'revision-1',
        file_id: 'revision-2',
        filename: 'empty.sh',
        mimeType: 'text/plain',
      },
    });
    const view = renderViewer('scripts/empty.sh');
    fireEvent.click(await screen.findByRole('button', { name: 'com_ui_edit' }));
    const textarea = screen.getByRole('textbox', { name: 'com_ui_edit empty.sh' });
    expect(textarea).toHaveValue('');
    fireEvent.change(textarea, { target: { value: 'echo ready' } });
    fireEvent.keyDown(textarea, { key: 's', ctrlKey: true });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect((post.mock.calls[0][1] as FormData).get('relativePath')).toBe('scripts/empty.sh');
    view.queryClient.clear();
  });

  it('keeps an in-progress draft but disables Save when edit access is lost', async () => {
    jest.spyOn(axios, 'get').mockResolvedValue({
      data: {
        content: 'old content',
        fileId: 'revision-1',
        file_id: 'revision-2',
        filename: 'queries.md',
        relativePath: filePath,
        mimeType: 'text/markdown',
        isBinary: false,
        bytes: 11,
      },
    });
    const post = jest.spyOn(axios, 'post');
    const view = renderViewer();
    await screen.findByText('old content');
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_edit' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unsaved draft' } });
    mockCanEdit = false;
    view.queryClient.setQueryData([QueryKeys.skillFileContent, skill._id, filePath], {
      content: 'remote revision',
      fileId: 'revision-1',
      file_id: 'revision-2',
      filename: 'queries.md',
      relativePath: filePath,
      mimeType: 'text/markdown',
      isBinary: false,
      bytes: 15,
    });

    await screen.findByRole('note');
    expect(screen.getByRole('textbox')).toHaveValue('unsaved draft');
    expect(screen.getByRole('button', { name: 'com_ui_save' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 's', ctrlKey: true });
    expect(post).not.toHaveBeenCalled();
    view.queryClient.clear();
  });

  it.each([undefined, 500, 503])(
    'keeps confirmed content visible if verification fails transiently (%s)',
    async (status) => {
      jest
        .spyOn(axios, 'get')
        .mockResolvedValueOnce({
          data: {
            fileId: 'revision-1',
            content: 'original',
            filename: 'queries.md',
            relativePath: filePath,
            mimeType: 'text/markdown',
            isBinary: false,
            bytes: 8,
          },
        })
        .mockRejectedValue(status ? { response: { status } } : new Error('verification offline'));
      jest.spyOn(axios, 'post').mockResolvedValue({
        data: {
          file_id: 'revision-2',
          filename: 'queries.md',
          relativePath: filePath,
          mimeType: 'text/markdown',
        },
      });
      const view = renderViewer();
      fireEvent.click(await screen.findByRole('button', { name: 'com_ui_edit' }));
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'confirmed save' } });
      fireEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));
      await waitFor(() =>
        expect(
          view.queryClient.getQueryState([QueryKeys.skillFileContent, skill._id, filePath])?.status,
        ).toBe('error'),
      );
      expect(screen.getByText('confirmed save')).toBeVisible();
      expect(screen.queryByText('com_ui_skill_file_load_error')).not.toBeInTheDocument();
      view.queryClient.clear();
    },
  );

  it('publishes a confirmed save even if an earlier reread cleared the cached content while saving', async () => {
    jest
      .spyOn(axios, 'get')
      .mockResolvedValueOnce({
        data: {
          fileId: 'revision-1',
          content: 'before',
          filename: 'queries.md',
          relativePath: filePath,
          mimeType: 'text/markdown',
          isBinary: false,
          bytes: 6,
        },
      })
      .mockRejectedValue({ response: { status: 503 } });
    let acknowledge!: (response: AxiosResponse) => void;
    const post = jest.spyOn(axios, 'post').mockImplementation(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    const view = renderViewer();
    fireEvent.click(await screen.findByRole('button', { name: 'com_ui_edit' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'confirmed content' } });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    act(() => {
      view.queryClient.setQueryData([QueryKeys.skillFileContent, skill._id, filePath], null);
    });
    await act(async () => {
      acknowledge({
        data: {
          file_id: 'revision-2',
          filename: 'queries.md',
          mimeType: 'text/markdown',
          relativePath: filePath,
        },
      } as AxiosResponse);
    });
    await screen.findByText('confirmed content');
    await waitFor(() =>
      expect(
        view.queryClient.getQueryState([QueryKeys.skillFileContent, skill._id, filePath])?.status,
      ).toBe('error'),
    );
    expect(
      view.queryClient.getQueryData([QueryKeys.skillFileContent, skill._id, filePath]),
    ).toMatchObject({ fileId: 'revision-2', content: 'confirmed content' });
    view.unmount();
    view.queryClient.clear();
  });

  it('ignores a delayed terminal reread that began before a confirmed save', async () => {
    let rejectOldRead!: (error: unknown) => void;
    const get = jest
      .spyOn(axios, 'get')
      .mockResolvedValueOnce({
        data: {
          fileId: 'revision-1',
          content: 'before',
          filename: 'queries.md',
          relativePath: filePath,
          mimeType: 'text/markdown',
          isBinary: false,
          bytes: 6,
        },
      })
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectOldRead = reject;
          }),
      )
      .mockRejectedValue({ response: { status: 503 } });
    jest.spyOn(axios, 'post').mockResolvedValue({
      data: {
        file_id: 'revision-2',
        filename: 'queries.md',
        mimeType: 'text/markdown',
        relativePath: filePath,
      },
    });
    const view = renderViewer();
    fireEvent.click(await screen.findByRole('button', { name: 'com_ui_edit' }));
    act(() => {
      void view.queryClient.invalidateQueries([QueryKeys.skillFileContent, skill._id, filePath]);
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'confirmed content' } });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));
    await screen.findByText('confirmed content');
    await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
    await act(async () => {
      rejectOldRead({ response: { status: 404 } });
    });
    expect(screen.getByText('confirmed content')).toBeVisible();
    expect(
      view.queryClient.getQueryData([QueryKeys.skillFileContent, skill._id, filePath]),
    ).toMatchObject({ fileId: 'revision-2', content: 'confirmed content' });
    view.unmount();
    view.queryClient.clear();
  });

  it('preserves a conflicting draft and does not allow a blind retry', async () => {
    jest.spyOn(axios, 'get').mockResolvedValue({
      data: {
        fileId: 'revision-1',
        content: 'before',
        filename: 'queries.md',
        relativePath: filePath,
        mimeType: 'text/markdown',
        isBinary: false,
        bytes: 6,
      },
    });
    const post = jest.spyOn(axios, 'post').mockRejectedValue({ response: { status: 409 } });
    const view = renderViewer();
    fireEvent.click(await screen.findByRole('button', { name: 'com_ui_edit' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'stale draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_skill_file_conflict');
    expect(screen.getByRole('textbox')).toHaveValue('stale draft');
    expect(screen.getByRole('button', { name: 'com_ui_save' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 's', ctrlKey: true });
    expect(post).toHaveBeenCalledTimes(1);
    view.queryClient.clear();
  });

  it.each([404, 410, 403])(
    'discards cached content after a conflict reread returns %s without losing the draft',
    async (status) => {
      const get = jest
        .spyOn(axios, 'get')
        .mockResolvedValueOnce({
          data: {
            fileId: 'revision-1',
            content: 'deleted content',
            filename: 'queries.md',
            relativePath: filePath,
            mimeType: 'text/markdown',
            isBinary: false,
            bytes: 15,
          },
        })
        .mockRejectedValue({ response: { status } });
      const post = jest.spyOn(axios, 'post').mockRejectedValue({ response: { status: 409 } });
      const view = renderViewer();
      fireEvent.click(await screen.findByRole('button', { name: 'com_ui_edit' }));
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'keep this draft' } });
      fireEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_skill_file_conflict');
      await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
      expect(screen.getByRole('textbox')).toHaveValue('keep this draft');
      expect(screen.getByRole('button', { name: 'com_ui_save' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'com_ui_cancel' }));

      expect(screen.queryByText('deleted content')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'com_ui_edit' })).not.toBeInTheDocument();
      expect(screen.getByText('com_ui_skill_file_load_error')).toBeVisible();
      expect(
        view.queryClient.getQueryData([QueryKeys.skillFileContent, skill._id, filePath]),
      ).toBeNull();
      view.unmount();
      const reopened = renderViewer(filePath, skill, view.queryClient);
      await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
      await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
      expect(screen.queryByText('deleted content')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'com_ui_edit' })).not.toBeInTheDocument();
      expect(post).toHaveBeenCalledTimes(1);
      reopened.unmount();

      get.mockResolvedValue({
        data: {
          fileId: 'restored-revision',
          content: 'restored content',
          filename: 'queries.md',
          relativePath: filePath,
          mimeType: 'text/markdown',
          isBinary: false,
          bytes: 16,
        },
      });
      const restored = renderViewer(filePath, skill, view.queryClient);
      expect(await screen.findByText('restored content')).toBeVisible();
      expect(screen.getByRole('button', { name: 'com_ui_edit' })).toBeEnabled();
      expect(get).toHaveBeenCalledTimes(4);
      restored.unmount();
      view.queryClient.clear();
    },
  );

  it.each([403, 404, 410])(
    'refetches a previously unavailable file on revisit after %s',
    async (status) => {
      const get = jest
        .spyOn(axios, 'get')
        .mockRejectedValueOnce({ response: { status } })
        .mockResolvedValue({
          data: {
            fileId: 'restored-revision',
            content: 'restored after revisit',
            filename: 'queries.md',
            relativePath: filePath,
            mimeType: 'text/markdown',
            isBinary: false,
            bytes: 22,
          },
        });
      const first = renderViewer();
      expect(await screen.findByText('com_ui_skill_file_load_error')).toBeVisible();
      expect(get).toHaveBeenCalledTimes(1);
      first.unmount();

      const second = renderViewer(filePath, skill, first.queryClient);
      expect(await screen.findByText('restored after revisit')).toBeVisible();
      expect(screen.getByRole('button', { name: 'com_ui_edit' })).toBeEnabled();
      expect(get).toHaveBeenCalledTimes(2);
      second.unmount();
      first.queryClient.clear();
    },
  );

  it('can retry a temporarily unavailable file without leaving the viewer', async () => {
    const get = jest
      .spyOn(axios, 'get')
      .mockRejectedValueOnce({ response: { status: 403 } })
      .mockRejectedValueOnce({ response: { status: 403 } })
      .mockResolvedValue({
        data: {
          fileId: 'restored-revision',
          content: 'access restored in place',
          filename: 'queries.md',
          relativePath: filePath,
          mimeType: 'text/markdown',
          isBinary: false,
          bytes: 24,
        },
      });
    const view = renderViewer();
    expect(await screen.findByText('com_ui_skill_file_load_error')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'com_ui_retry' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(await screen.findByText('access restored in place')).toBeVisible();
    expect(get).toHaveBeenCalledTimes(3);
    view.unmount();
    view.queryClient.clear();
  });

  it('keeps confirmed file content fresh across revisits', async () => {
    const get = jest.spyOn(axios, 'get').mockResolvedValue({
      data: {
        fileId: 'revision-1',
        content: 'confirmed text',
        filename: 'queries.md',
        relativePath: filePath,
        mimeType: 'text/markdown',
        isBinary: false,
        bytes: 14,
      },
    });
    const first = renderViewer();
    expect(await screen.findByText('confirmed text')).toBeVisible();
    first.unmount();
    const second = renderViewer(filePath, skill, first.queryClient);
    expect(screen.getByText('confirmed text')).toBeVisible();
    expect(get).toHaveBeenCalledTimes(1);
    second.unmount();
    first.queryClient.clear();
  });

  it.each(['github', 'notion'] as const)(
    'keeps %s-managed skill files read-only even with edit permission',
    async (source) => {
      jest.spyOn(axios, 'get').mockResolvedValue({
        data: {
          fileId: 'revision-1',
          content: 'upstream text',
          filename: 'queries.md',
          relativePath: filePath,
          mimeType: 'text/markdown',
          isBinary: false,
          bytes: 13,
        },
      });
      const view = renderViewer(filePath, { ...skill, source });
      await screen.findByText('upstream text');
      expect(screen.queryByRole('button', { name: 'com_ui_edit' })).not.toBeInTheDocument();
      view.queryClient.clear();
    },
  );

  it('does not offer unprotected edits for an older server response without a revision', async () => {
    jest.spyOn(axios, 'get').mockResolvedValue({
      data: {
        content: 'legacy text',
        filename: 'queries.md',
        relativePath: filePath,
        mimeType: 'text/markdown',
        isBinary: false,
        bytes: 11,
      },
    });
    const view = renderViewer();
    await screen.findByText('legacy text');
    expect(screen.queryByRole('button', { name: 'com_ui_edit' })).not.toBeInTheDocument();
    view.queryClient.clear();
  });

  it('does not offer editing when loading a file fails', async () => {
    jest.spyOn(axios, 'get').mockRejectedValue(new Error('file read failed'));
    const view = renderViewer();
    await screen.findByText('com_ui_skill_file_load_error');
    expect(screen.queryByRole('button', { name: 'com_ui_edit' })).not.toBeInTheDocument();
    view.queryClient.clear();
  });

  it('routes SKILL.md edits to the existing skill form, never the multipart file endpoint', async () => {
    jest.spyOn(axios, 'get').mockResolvedValue({
      data: {
        content: '# Skill',
        fileId: 'revision-1',
        file_id: 'revision-2',
        filename: 'SKILL.md',
        relativePath: 'SKILL.md',
        mimeType: 'text/markdown',
        isBinary: false,
        bytes: 7,
      },
    });
    const post = jest.spyOn(axios, 'post');
    const view = renderViewer('SKILL.md');
    await screen.findByText('# Skill');
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_edit' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/skills/skill-id/edit');
    expect(post).not.toHaveBeenCalled();
    view.queryClient.clear();
  });
});

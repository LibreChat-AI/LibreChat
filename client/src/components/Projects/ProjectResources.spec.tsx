import userEvent from '@testing-library/user-event';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TChatProjectFile, TFile, TFileUpload } from 'librechat-data-provider';
import type * as ClientModule from '@librechat/client';
import type * as ReactModule from 'react';
import type { ReactNode } from 'react';
import ProjectResources from './ProjectResources';

const mockUploadMutateAsync = jest.fn();
const mockCanUseFileSearch = jest.fn(() => true);
const mockAddMutateAsync = jest.fn();
const mockRemoveMutateAsync = jest.fn();
const mockRefetch = jest.fn();
const mockShowToast = jest.fn();

let projectFilesState: TChatProjectFile[] = [];
let mockProjectQueryState = {
  data: projectFilesState as TChatProjectFile[] | undefined,
  isLoading: false,
  isError: false,
  refetch: mockRefetch,
};
let mockAvailableFilesState = {
  data: { pages: [{ files: [] as TFile[], nextCursor: null }] },
  isLoading: false,
  isFetchingNextPage: false,
  hasNextPage: false,
  fetchNextPage: jest.fn(),
  isError: false,
  refetch: mockRefetch,
};

jest.mock('@librechat/client', () => {
  const React = jest.requireActual<typeof ReactModule>('react');
  const actual = jest.requireActual<typeof ClientModule>('@librechat/client');
  return {
    Spinner: () => React.createElement('span', { 'aria-hidden': true }),
    Alert: ({ children, role }: React.HTMLAttributes<HTMLDivElement>) =>
      React.createElement('div', { role }, children),
    Button: actual.Button,
    DropdownPopup: actual.DropdownPopup,
    EmptyState: actual.EmptyState,
    Input: actual.Input,
    FileUpload: React.forwardRef<
      HTMLInputElement,
      { children: ReactNode; handleFileChange: React.ChangeEventHandler<HTMLInputElement> }
    >(({ children, handleFileChange }, ref) =>
      React.createElement(
        React.Fragment,
        null,
        children,
        React.createElement('input', {
          ref,
          type: 'file',
          'data-testid': 'project-upload-input',
          onChange: handleFileChange,
        }),
      ),
    ),
    OGDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? React.createElement(React.Fragment, null, children) : null,
    OGDialogContent: ({ children }: { children: ReactNode }) =>
      React.createElement('div', null, children),
    OGDialogHeader: ({ children }: { children: ReactNode }) =>
      React.createElement('div', null, children),
    OGDialogTitle: ({ children }: { children: ReactNode }) =>
      React.createElement('h2', null, children),
    TooltipAnchor: ({ render }: { render: ReactNode }) => render,
    useToastContext: () => ({ showToast: mockShowToast }),
  };
});

jest.mock('~/data-provider', () => ({
  useProjectFilesQuery: () => mockProjectQueryState,
  useProjectAvailableFilesInfiniteQuery: () => mockAvailableFilesState,
  useUploadFileMutation: () => ({ mutateAsync: mockUploadMutateAsync, isLoading: false }),
  useAddProjectFileMutation: () => ({ mutateAsync: mockAddMutateAsync, isLoading: false }),
  useRemoveProjectFileMutation: () => ({ mutateAsync: mockRemoveMutateAsync, isLoading: false }),
  useGetStartupConfig: () => ({ data: undefined }),
}));

jest.mock('~/hooks', () => ({
  useAgentCapabilities: () => ({ fileSearchEnabled: true }),
  useGetAgentsConfig: () => ({ agentsConfig: { capabilities: ['file_search'] } }),
  useHasAccess: () => mockCanUseFileSearch(),
  useLocalize: () => (key: string, options?: { count?: number; name?: string }) => {
    const translations: Record<string, string> = {
      com_error_files_upload: 'An error occurred while uploading the file.',
      com_error_files_upload_canceled: 'The file upload was canceled.',
      com_ui_project_add_files: 'Add files',
      com_ui_project_files: 'Reference files',
      com_ui_project_files_help: 'Files are searched',
      com_ui_project_files_retrieval_only: 'Retrieval only',
      com_ui_project_upload_file: 'Upload file',
      com_ui_project_choose_file: 'Choose an existing file',
      com_ui_search_files: 'Search files',
      com_ui_project_file_processing: 'Processing',
      com_ui_project_file_failed: 'Upload failed',
      com_ui_project_file_ready: 'Ready',
      com_ui_project_file_unavailable: 'Unavailable',
      com_ui_project_file_attach_error: 'Could not add this file',
      com_ui_project_file_remove_error: 'Could not remove this file',
      com_ui_project_file_excess: `Could not add ${options?.count ?? ''} selected file(s)`,
      com_ui_project_files_error: 'Could not load project files',
      com_ui_project_no_files: 'No reference files yet',
      com_ui_project_no_eligible_files: 'No eligible indexed files',
      com_ui_project_remove_file: `Remove ${options?.name ?? ''} from project`,
      com_ui_project_dismiss_upload: `Dismiss ${options?.name ?? ''} upload`,
      com_ui_retry: 'Retry',
      com_ui_loading: 'Loading',
      com_ui_load_more: 'Load more',
      com_ui_no_search_results: 'No results match your search',
    };
    return (translations[key] ?? key).replace('{{count}}', String(options?.count ?? ''));
  },
}));

const project = { _id: 'project-1', fileCount: 0 };
const uploadedFile = {
  file_id: 'canonical-file-id',
  temp_file_id: 'different-temporary-id',
  filename: 'reference.txt',
  bytes: 10,
  embedded: true,
  context: 'message_attachment',
  type: 'text/plain',
} as unknown as TFileUpload;

function renderResources() {
  return render(<ProjectResources project={project} />);
}

describe('ProjectResources', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    projectFilesState = [];
    mockProjectQueryState = {
      data: projectFilesState,
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
    };
    mockAvailableFilesState = {
      data: { pages: [{ files: [], nextCursor: null }] },
      isLoading: false,
      isFetchingNextPage: false,
      hasNextPage: false,
      fetchNextPage: jest.fn(),
      isError: false,
      refetch: mockRefetch,
    };
    mockCanUseFileSearch.mockReturnValue(true);
    mockAddMutateAsync.mockResolvedValue({});
    mockRemoveMutateAsync.mockResolvedValue({});
  });

  it('renders loading, error, and empty states with recovery controls', () => {
    mockProjectQueryState = { ...mockProjectQueryState, isLoading: true };
    renderResources();
    expect(screen.getByRole('status')).toBeInTheDocument();
    cleanup();

    mockProjectQueryState = { ...mockProjectQueryState, isLoading: false, isError: true };
    renderResources();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load project files');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mockRefetch).toHaveBeenCalled();
    cleanup();

    mockProjectQueryState = { ...mockProjectQueryState, isError: false };
    renderResources();
    expect(screen.getByText('No reference files yet')).toBeInTheDocument();
  });

  it('uses the canonical upload identity and exposes pending and failed attempts', async () => {
    let resolveUpload: (file: TFileUpload) => void = () => undefined;
    mockUploadMutateAsync.mockImplementation(
      () => new Promise<TFileUpload>((resolve) => (resolveUpload = resolve)),
    );
    renderResources();
    const input = screen.getByTestId('project-upload-input');
    fireEvent.change(input, { target: { files: [new File(['x'], 'reference.txt')] } });
    expect(screen.getByText('Processing')).toBeInTheDocument();

    resolveUpload(uploadedFile);
    await waitFor(() =>
      expect(mockAddMutateAsync).toHaveBeenCalledWith({
        projectId: 'project-1',
        file_id: 'canonical-file-id',
      }),
    );
    await waitFor(() => expect(screen.queryByText('Processing')).not.toBeInTheDocument());

    mockUploadMutateAsync.mockRejectedValueOnce({
      message: 'unsafe internal upload detail',
      response: { data: { message: 'Images are not supported for File Search.' } },
    });
    fireEvent.change(input, { target: { files: [new File(['y'], 'failed.txt')] } });
    await waitFor(() =>
      expect(screen.getByText('Images are not supported for File Search.')).toBeInTheDocument(),
    );
    expect(screen.queryByText('unsafe internal upload detail')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss failed.txt upload' })).toBeInTheDocument();
  });
  it('reserves remaining capacity across overlapping multi-file selections', async () => {
    let finishFirstUpload!: (file: TFileUpload) => void;
    mockProjectQueryState = { ...mockProjectQueryState, data: undefined, isLoading: true };
    mockUploadMutateAsync
      .mockImplementationOnce(
        () => new Promise<TFileUpload>((resolve) => (finishFirstUpload = resolve)),
      )
      .mockResolvedValueOnce({ ...uploadedFile, file_id: 'second-canonical-id' });
    render(<ProjectResources project={{ ...project, fileCount: 48 }} />);
    const input = screen.getByTestId('project-upload-input');
    fireEvent.change(input, {
      target: {
        files: [
          new File(['a'], 'first.txt'),
          new File(['b'], 'second.txt'),
          new File(['c'], 'excess.txt'),
        ],
      },
    });
    fireEvent.change(input, { target: { files: [new File(['d'], 'another-excess.txt')] } });
    expect(mockUploadMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockShowToast).toHaveBeenCalledTimes(2);
    expect(mockShowToast).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: 'Could not add 1 selected file(s)' }),
    );
    finishFirstUpload(uploadedFile);
    await waitFor(() => expect(mockAddMutateAsync).toHaveBeenCalledTimes(2));
    expect(mockUploadMutateAsync).toHaveBeenCalledTimes(2);
    expect(mockAddMutateAsync.mock.calls.map(([payload]) => payload.file_id)).toEqual([
      uploadedFile.file_id,
      'second-canonical-id',
    ]);
  });

  it('retries a failed association without uploading another binary', async () => {
    mockUploadMutateAsync.mockResolvedValue(uploadedFile);
    mockAddMutateAsync.mockRejectedValueOnce({
      message: 'unsafe association detail',
      response: { data: { error: 'Project file limit reached' } },
    });
    renderResources();
    fireEvent.change(screen.getByTestId('project-upload-input'), {
      target: { files: [new File(['x'], 'reference.txt')] },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Project file limit reached');
    expect(screen.queryByText('unsafe association detail')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText('Upload failed')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText('Processing')).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mockUploadMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockAddMutateAsync).toHaveBeenLastCalledWith({
      projectId: 'project-1',
      file_id: 'canonical-file-id',
    });
  });

  it('lists server-filtered files and preserves unit-bearing file sizes', async () => {
    mockProjectQueryState = {
      ...mockProjectQueryState,
      data: [
        { file_id: 'attached-id', filename: 'attached.txt', availability: 'ready' },
        { file_id: 'gone-id', availability: 'unavailable' },
      ],
    };
    mockAvailableFilesState = {
      ...mockAvailableFilesState,
      data: {
        pages: [
          {
            files: [
              { ...uploadedFile, file_id: 'ready-id', filename: 'ready.txt', bytes: 12800 },
            ] as TFile[],
            nextCursor: null,
          },
        ],
      },
    };
    renderResources();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add files' }));
    await user.click(screen.getByRole('menuitem', { name: 'Choose an existing file' }));
    expect(await screen.findByRole('button', { name: /ready.txt/ })).toHaveTextContent('12.5 KB');
  });

  it('separates an empty file history from a search that matches nothing', async () => {
    renderResources();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add files' }));
    await user.click(screen.getByRole('menuitem', { name: 'Choose an existing file' }));
    expect(await screen.findByText('No eligible indexed files')).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Search files' }), 'invoice');
    expect(await screen.findByText('No results match your search')).toBeInTheDocument();
    expect(screen.queryByText('No eligible indexed files')).not.toBeInTheDocument();
  });

  it('keeps eligible existing files available when device upload is denied', async () => {
    mockCanUseFileSearch.mockReturnValue(false);
    mockAvailableFilesState = {
      ...mockAvailableFilesState,
      data: {
        pages: [
          {
            files: [{ ...uploadedFile, file_id: 'ready-id', filename: 'ready.txt' }] as TFile[],
            nextCursor: null,
          },
        ],
      },
    };
    renderResources();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add files' }));
    expect(screen.queryByRole('menuitem', { name: 'Upload file' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Choose an existing file' }));
    await user.click(await screen.findByRole('button', { name: /ready.txt/ }));
    expect(mockAddMutateAsync).toHaveBeenCalledWith({
      projectId: 'project-1',
      file_id: 'ready-id',
    });
  });
});

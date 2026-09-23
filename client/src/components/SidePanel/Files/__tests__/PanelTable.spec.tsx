import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  FileSources,
  FileContext,
  EToolResources,
  AgentCapabilities,
} from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import { columns } from '../PanelColumns';
import DataTable from '../PanelTable';

const mockShowToast = jest.fn();
const mockAddFile = jest.fn();
const mockSetEphemeralAgent = jest.fn();

let mockFileMap: Record<string, TFile> = {};
let mockFiles: Map<string, ExtendedFile> = new Map();
let mockConversation: Record<string, unknown> | null = { endpoint: 'openAI' };
let mockAgentsConfig: { capabilities?: string[] } | null = {
  capabilities: [AgentCapabilities.file_search],
};
let mockRawFileConfig: Record<string, unknown> | null = {
  endpoints: {
    openAI: { fileLimit: 10, supportedMimeTypes: ['application/pdf', 'text/plain'] },
  },
};

jest.mock('@librechat/client', () => ({
  Table: ({ children, ...props }: { children: React.ReactNode }) => (
    <table {...props}>{children}</table>
  ),
  Button: ({
    children,
    ...props
  }: { children: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  TableRow: ({ children, ...props }: { children: React.ReactNode }) => (
    <tr {...props}>{children}</tr>
  ),
  TableHead: ({ children, ...props }: { children: React.ReactNode }) => (
    <th {...props}>{children}</th>
  ),
  TableBody: ({ children, ...props }: { children: React.ReactNode }) => (
    <tbody {...props}>{children}</tbody>
  ),
  TableCell: ({
    children,
    ...props
  }: { children: React.ReactNode } & React.TdHTMLAttributes<HTMLTableCellElement>) => (
    <td {...props}>{children}</td>
  ),
  FilterInput: () => <input data-testid="filter" />,
  TableHeader: ({ children, ...props }: { children: React.ReactNode }) => (
    <thead {...props}>{children}</thead>
  ),
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/Providers', () => ({
  useFileMapContext: () => mockFileMap,
  useChatContext: () => ({
    files: mockFiles,
    setFiles: jest.fn(),
    conversation: mockConversation,
  }),
}));

jest.mock('recoil', () => ({
  useSetRecoilState: () => mockSetEphemeralAgent,
}));

jest.mock('~/store', () => ({
  ephemeralAgentByConvoId: (conversationId: string) => ({ key: conversationId }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useUpdateFiles: () => ({ addFile: mockAddFile }),
  useGetAgentsConfig: () => ({ agentsConfig: mockAgentsConfig }),
  useAgentCapabilities: (capabilities?: string[]) => ({
    fileSearchEnabled: capabilities?.includes('file_search') ?? false,
  }),
}));

/* The attach logic moved into `useAttachExisting`, which reaches its
   dependencies by their own paths rather than through the `~/hooks` barrel. */
jest.mock('~/hooks/useLocalize', () => ({
  __esModule: true,
  default: () => (key: string) => key,
}));

jest.mock('~/hooks/Files/useUpdateFiles', () => ({
  __esModule: true,
  default: () => ({ addFile: mockAddFile }),
}));

jest.mock('~/data-provider', () => ({
  useGetFileConfig: ({ select }: { select?: (d: unknown) => unknown }) => ({
    data: select != null ? select(mockRawFileConfig) : mockRawFileConfig,
  }),
}));

jest.mock('~/components/Chat/Input/Files/MyFilesModal', () => ({
  MyFilesModal: () => null,
}));

jest.mock('../PanelFileCell', () => ({ row }: { row: { original: TFile } }) => (
  <span>{row.original?.filename}</span>
));

function makeFile(overrides: Partial<TFile> = {}): TFile {
  return {
    user: 'user-1',
    file_id: 'file-1',
    bytes: 1024,
    embedded: false,
    filename: 'test.pdf',
    filepath: '/files/test.pdf',
    object: 'file',
    type: 'application/pdf',
    usage: 0,
    source: FileSources.local,
    ...overrides,
  };
}

function makeExtendedFile(overrides: Partial<ExtendedFile> = {}): ExtendedFile {
  return {
    file_id: 'ext-1',
    size: 1024,
    progress: 1,
    source: FileSources.local,
    ...overrides,
  };
}

function renderTable(data: TFile[]) {
  return render(<DataTable columns={columns} data={data} />);
}

function clickFilenameCell() {
  const cells = screen.getAllByRole('button');
  const filenameCell = cells.find(
    (cell) => cell.tagName === 'TD' && cell.textContent && !cell.textContent.includes('com_ui_'),
  );
  if (!filenameCell) {
    throw new Error('Could not find filename cell with role="button" — check mock setup');
  }
  fireEvent.click(filenameCell);
  return filenameCell;
}

describe('PanelTable handleFileClick', () => {
  beforeEach(() => {
    mockShowToast.mockClear();
    mockAddFile.mockClear();
    mockSetEphemeralAgent.mockClear();
    mockAgentsConfig = { capabilities: [AgentCapabilities.file_search] };
    mockFiles = new Map();
    mockConversation = { endpoint: 'openAI' };
    mockRawFileConfig = {
      endpoints: {
        openAI: {
          fileLimit: 5,
          totalSizeLimit: 10,
          supportedMimeTypes: ['application/pdf', 'text/plain'],
        },
      },
    };
  });

  it('calls addFile when within file limits', () => {
    const file = makeFile();
    mockFileMap = { [file.file_id]: file };

    renderTable([file]);
    clickFilenameCell();

    expect(mockAddFile).toHaveBeenCalledTimes(1);
    expect(mockAddFile).toHaveBeenCalledWith(
      expect.objectContaining({
        file_id: file.file_id,
        attached: true,
        progress: 1,
      }),
    );
    expect(mockShowToast).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
  });

  it('reattaches a persisted published file with its durable identity and provenance', () => {
    const runFile = {
      runId: 'run-1',
      executionId: 'child-execution',
      parentExecutionId: 'parent-execution',
      agentId: 'child-agent',
      sourceFileId: 'private-file',
      publishedAt: '2026-09-11T16:00:00.000Z',
      inputFileIds: ['input-pdf'],
    };
    const file = makeFile({
      file_id: 'published-report',
      filename: 'report.pdf',
      context: FileContext.run_artifact,
      metadata: { runFile },
      llmDeliveryPath: 'text',
    });
    mockFileMap = { [file.file_id]: file };

    renderTable([file]);
    clickFilenameCell();

    expect(mockAddFile).toHaveBeenCalledWith(
      expect.objectContaining({
        file_id: 'published-report',
        filename: 'report.pdf',
        filepath: file.filepath,
        metadata: { runFile },
        llmDeliveryPath: 'text',
        attached: true,
        progress: 1,
      }),
    );
  });

  it('blocks attachment when fileLimit is reached', () => {
    const file = makeFile({ file_id: 'new-file', filename: 'new.pdf' });
    mockFileMap = { [file.file_id]: file };

    mockFiles = new Map(
      Array.from({ length: 5 }, (_, i) => [
        `existing-${i}`,
        makeExtendedFile({ file_id: `existing-${i}` }),
      ]),
    );

    renderTable([file]);
    clickFilenameCell();

    expect(mockAddFile).not.toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('com_ui_attach_error_file_limit'),
        status: 'error',
      }),
    );
  });

  it('blocks attachment when totalSizeLimit would be exceeded', () => {
    const MB = 1024 * 1024;
    const largeFile = makeFile({ file_id: 'large-file', bytes: 6 * MB });
    mockFileMap = { [largeFile.file_id]: largeFile };

    mockFiles = new Map([
      ['existing-1', makeExtendedFile({ file_id: 'existing-1', size: 5 * MB })],
    ]);

    renderTable([largeFile]);
    clickFilenameCell();

    expect(mockAddFile).not.toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('com_ui_attach_error_total_size'),
        status: 'error',
      }),
    );
  });

  it('does not double-count size of already-attached file', () => {
    const MB = 1024 * 1024;
    const file = makeFile({ file_id: 'reattach', bytes: 5 * MB });
    mockFileMap = { [file.file_id]: file };

    mockFiles = new Map([
      ['reattach', makeExtendedFile({ file_id: 'reattach', size: 5 * MB })],
      ['other', makeExtendedFile({ file_id: 'other', size: 4 * MB })],
    ]);

    renderTable([file]);
    clickFilenameCell();

    expect(mockAddFile).toHaveBeenCalledTimes(1);
    expect(mockShowToast).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('com_ui_attach_error_total_size'),
      }),
    );
  });

  it('allows attachment when just under fileLimit', () => {
    const file = makeFile({ file_id: 'under-limit' });
    mockFileMap = { [file.file_id]: file };

    mockFiles = new Map(
      Array.from({ length: 4 }, (_, i) => [
        `existing-${i}`,
        makeExtendedFile({ file_id: `existing-${i}` }),
      ]),
    );

    renderTable([file]);
    clickFilenameCell();

    expect(mockAddFile).toHaveBeenCalledTimes(1);
  });

  it('turns on file search when attaching an embedded file', () => {
    const file = makeFile({ file_id: 'embedded-file', embedded: true });
    mockFileMap = { [file.file_id]: file };

    renderTable([file]);
    clickFilenameCell();

    expect(mockAddFile).toHaveBeenCalledTimes(1);
    expect(mockSetEphemeralAgent).toHaveBeenCalledTimes(1);

    const updater = mockSetEphemeralAgent.mock.calls[0][0];
    expect(updater({ web_search: true })).toEqual({
      web_search: true,
      [EToolResources.file_search]: true,
    });
  });

  it('leaves file search alone for a file that was never embedded', () => {
    const file = makeFile({ file_id: 'plain-file', embedded: false });
    mockFileMap = { [file.file_id]: file };

    renderTable([file]);
    clickFilenameCell();

    expect(mockAddFile).toHaveBeenCalledTimes(1);
    expect(mockSetEphemeralAgent).not.toHaveBeenCalled();
  });

  it('leaves file search alone when the capability is disabled', () => {
    mockAgentsConfig = { capabilities: [] };
    const file = makeFile({ file_id: 'embedded-file', embedded: true });
    mockFileMap = { [file.file_id]: file };

    renderTable([file]);
    clickFilenameCell();

    expect(mockAddFile).toHaveBeenCalledTimes(1);
    expect(mockSetEphemeralAgent).not.toHaveBeenCalled();
  });

  it('leaves file search alone when a saved agent owns the conversation', () => {
    mockConversation = { endpoint: 'openAI', agent_id: 'agent_abc123' };
    const file = makeFile({ file_id: 'embedded-file', embedded: true });
    mockFileMap = { [file.file_id]: file };

    renderTable([file]);
    clickFilenameCell();

    expect(mockAddFile).toHaveBeenCalledTimes(1);
    expect(mockSetEphemeralAgent).not.toHaveBeenCalled();
  });

  it('leaves file search alone when the attachment itself is rejected', () => {
    const file = makeFile({ file_id: 'embedded-file', embedded: true });
    mockFileMap = { [file.file_id]: file };

    mockFiles = new Map(
      Array.from({ length: 5 }, (_, i) => [
        `existing-${i}`,
        makeExtendedFile({ file_id: `existing-${i}` }),
      ]),
    );

    renderTable([file]);
    clickFilenameCell();

    expect(mockAddFile).not.toHaveBeenCalled();
    expect(mockSetEphemeralAgent).not.toHaveBeenCalled();
  });
});

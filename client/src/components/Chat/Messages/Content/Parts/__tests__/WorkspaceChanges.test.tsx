import React from 'react';
import { FileSources } from 'librechat-data-provider';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TAttachment } from 'librechat-data-provider';
import WorkspaceChanges, { partitionWorkspaceChanges } from '../WorkspaceChanges';

const mockHandleDownload = jest.fn();

jest.mock('../LogLink', () => ({
  useAttachmentLink: () => ({ handleDownload: mockHandleDownload }),
}));

jest.mock('~/hooks', () => ({
  useExpandCollapse: () => ({ style: {}, ref: { current: null } }),
  useLocalize: () => (key: string, values?: Record<number, string>) => {
    const translations: Record<string, string> = {
      com_ui_download: 'Download',
      com_ui_n_files_changed: `${values?.[0]} files changed`,
      com_ui_one_file_changed: '1 file changed',
      com_ui_workspace_changes: 'Workspace changes',
    };
    return translations[key] ?? key;
  },
}));

jest.mock('~/utils', () => ({
  cn: (...classes: Array<string | false | undefined>) => classes.filter(Boolean).join(' '),
}));

function makeAttachment({
  fileId,
  path,
  profile = 'stateful',
  filepath,
}: {
  fileId: string;
  path: string;
  profile?: 'stateful' | 'default';
  filepath?: string;
}): TAttachment {
  return {
    file_id: fileId,
    filename: path,
    filepath: filepath ?? `/uploads/${fileId}`,
    source: FileSources.local,
    user: 'user-1',
    conversationId: 'conversation-1',
    messageId: 'message-1',
    toolCallId: `tool-${fileId}`,
    workspaceChange: {
      profile,
      operation: 'updated',
      path,
    },
  } as TAttachment;
}

describe('WorkspaceChanges', () => {
  beforeEach(() => {
    mockHandleDownload.mockReset();
  });

  it('partitions only downloadable stateful changes and keeps the latest file entry', () => {
    const first = makeAttachment({ fileId: 'shared', path: 'reports/result.csv' });
    const latest = {
      ...makeAttachment({ fileId: 'shared', path: 'reports/result.csv' }),
      filepath: '/uploads/latest',
    } as TAttachment;
    const stateless = makeAttachment({
      fileId: 'default',
      path: 'default.txt',
      profile: 'default',
    });
    const unavailable = makeAttachment({ fileId: 'missing', path: 'missing.txt' });
    unavailable.filepath = '';

    const result = partitionWorkspaceChanges([first, stateless, unavailable, latest]);

    expect(result.inlineAttachments).toEqual([stateless, unavailable]);
    expect(result.workspaceChanges).toEqual([latest]);
  });

  it('renders one collapsed row and downloads through the existing attachment handler', () => {
    const changes = partitionWorkspaceChanges([
      makeAttachment({ fileId: 'one', path: 'reports/summary.csv' }),
      makeAttachment({ fileId: 'two', path: 'notes.txt' }),
    ]).workspaceChanges;

    render(<WorkspaceChanges attachments={changes} />);

    const toggle = screen.getByRole('button', {
      name: 'Workspace changes: 2 files changed',
    });
    const panel = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(panel).toHaveAttribute('inert');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(panel).not.toHaveAttribute('inert');
    expect(screen.getByText('summary.csv')).toBeInTheDocument();
    expect(screen.getByText('reports/summary.csv')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Download summary.csv' }));
    expect(mockHandleDownload).toHaveBeenCalledTimes(1);
  });
});

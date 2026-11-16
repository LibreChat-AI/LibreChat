/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import type { TAttachment } from 'librechat-data-provider';
import type { ReactElement } from 'react';
import type { FilesHost, AttachmentDownloadTarget } from '../../../react/files';
import { createMessagePartsHost } from '../../../__fixtures__/partsHost';
import { MessagePartsHostProvider } from '../../../react/host';
import Attachment, { AttachmentGroup } from '../Attachment';
import { FilesHostProvider } from '../../../react/files';

const TRANSLATIONS: Record<string, string> = {
  com_ui_download: 'Download',
  com_ui_n_files: '{{0}} files',
  com_ui_show_n_files: 'Show {{0}} files',
  com_ui_hide_n_files: 'Hide {{0}} files',
};

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLocalize: () => (key: string, values?: Record<string, string>) =>
    Object.entries(values ?? {}).reduce(
      (text, [name, value]) => text.replace(`{{${name}}}`, value),
      TRANSLATIONS[key] ?? key,
    ),
}));

const baseHost: FilesHost = {
  renderEndpointIcon: () => null,
  useDeleteFile: () => () => undefined,
  getPreviewUrl: () => undefined,
};

function file(overrides: Record<string, unknown> = {}): TAttachment {
  return {
    file_id: 'file-1',
    filename: 'results.zip',
    filepath: '/files/results.zip',
    type: 'execute_code',
    source: 'local',
    user: 'user-1',
    bytes: 2048,
    messageId: 'message-1',
    toolCallId: 'tool-1',
    ...overrides,
  } as TAttachment;
}

function renderRow(ui: ReactElement, host?: Partial<FilesHost>) {
  const tree = (
    <MessagePartsHostProvider host={createMessagePartsHost()}>{ui}</MessagePartsHostProvider>
  );
  if (host == null) {
    return render(tree);
  }
  return render(<FilesHostProvider host={{ ...baseHost, ...host }}>{tree}</FilesHostProvider>);
}

describe('Attachment', () => {
  it('draws a file row that a click leaves alone when no files host is mounted', () => {
    renderRow(<Attachment attachment={file()} />);

    const row = screen.getByRole('button', { name: 'results.zip' });
    fireEvent.click(row);

    expect(row).toBeInTheDocument();
  });

  it('hands the file to the host download hook and calls what it returns', () => {
    const download = jest.fn();
    const targets: AttachmentDownloadTarget[] = [];
    renderRow(<Attachment attachment={file()} />, {
      useAttachmentDownload: (target) => {
        targets.push(target);
        return download;
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'results.zip' }));

    expect(download).toHaveBeenCalledTimes(1);
    expect(targets[targets.length - 1]).toEqual({
      href: '/files/results.zip',
      filename: 'results.zip',
      fileId: 'file-1',
      user: 'user-1',
      source: 'local',
    });
  });

  it('draws the viewer the host names for a tool artifact', () => {
    renderRow(<Attachment attachment={file({ filename: 'report.html' })} />, {
      classifyAttachment: () => ({ kind: 'panel', artifactType: 'html' }),
      renderAttachmentArtifact: ({ artifact }) => (
        <div data-testid="viewer">{artifact.kind === 'panel' ? artifact.artifactType : ''}</div>
      ),
    });

    expect(screen.getByTestId('viewer')).toHaveTextContent('html');
    expect(screen.queryByRole('button', { name: 'report.html' })).not.toBeInTheDocument();
  });

  it('falls back to the file row when the host names no viewer', () => {
    renderRow(<Attachment attachment={file({ filename: 'report.html' })} />, {
      classifyAttachment: () => null,
    });

    expect(screen.getByRole('button', { name: 'report.html' })).toBeInTheDocument();
  });

  it('shows the download placeholder while the host reports a pending preview', () => {
    const { container } = renderRow(<Attachment attachment={file()} />, {
      useAttachmentPreview: () => ({ status: 'pending' }),
    });

    expect(screen.getByRole('button', { name: 'Download results.zip' })).toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('draws nothing for a file with no stored path', () => {
    const { container } = renderRow(<Attachment attachment={file({ filepath: '' })} />);

    expect(container).toBeEmptyDOMElement();
  });
});

describe('AttachmentGroup', () => {
  it('collapses several files behind one toggle that names them', () => {
    renderRow(
      <AttachmentGroup
        attachments={[file(), file({ file_id: 'file-2', filename: 'raw-data.zip' })]}
      />,
    );

    const toggle = screen.getByRole('button', { name: 'Show 2 files' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText(/results\.zip, raw-data\.zip/)).toBeInTheDocument();

    fireEvent.click(toggle);

    expect(screen.getByRole('button', { name: 'Hide 2 files' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('takes the collapsed files out of the tab order and the accessibility tree', () => {
    renderRow(
      <AttachmentGroup
        attachments={[file(), file({ file_id: 'file-2', filename: 'raw-data.zip' })]}
      />,
    );

    const toggle = screen.getByRole('button', { name: 'Show 2 files' });
    const folded = document.getElementById(
      toggle.getAttribute('aria-controls') ?? '',
    )?.firstElementChild;
    expect(folded).toHaveAttribute('aria-hidden', 'true');
    expect(folded).toHaveAttribute('inert');

    fireEvent.click(toggle);

    expect(folded).toHaveAttribute('aria-hidden', 'false');
    expect(folded).not.toHaveAttribute('inert');
  });

  it('draws one file without a toggle', () => {
    renderRow(<AttachmentGroup attachments={[file()]} />);

    expect(screen.queryByRole('button', { name: /files$/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'results.zip' })).toBeInTheDocument();
  });
});

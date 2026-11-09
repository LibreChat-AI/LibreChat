/**
 * @jest-environment jsdom
 */
import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { EToolResources, FileSources } from 'librechat-data-provider';
import type { ExtendedFile } from '../../../../core/files';
import type { FilesHost } from '../../../../react/files';
import { FilesHostProvider } from '../../../../react/files';
import { initEnglish } from '../../../../__fixtures__/i18n';
import FileRow from '../FileRow';

/** The row against its real image thumbnail and file card: only the host is a fake. */

beforeAll(initEnglish);

describe('FileRow host behavior', () => {
  const setFiles = jest.fn();
  const deleteFile = jest.fn();
  const useDeleteFile = jest.fn((): typeof deleteFile => deleteFile);
  const getPreviewUrl = jest.fn((): string | undefined => undefined);
  const host: FilesHost = { renderEndpointIcon: () => null, useDeleteFile, getPreviewUrl };

  beforeEach(() => {
    jest.clearAllMocks();
    getPreviewUrl.mockReturnValue(undefined);
  });

  const image = (overrides: Partial<ExtendedFile> = {}): ExtendedFile => ({
    file_id: 'image-1',
    type: 'image/png',
    preview: 'blob:http://localhost:3080/preview',
    filename: 'photo.png',
    progress: 1,
    size: 1024,
    source: FileSources.local,
    ...overrides,
  });

  const document = (overrides: Partial<ExtendedFile> = {}): ExtendedFile => ({
    file_id: 'doc-1',
    type: 'application/pdf',
    filename: 'report.pdf',
    progress: 1,
    size: 2048,
    source: FileSources.local,
    ...overrides,
  });

  const renderRow = (ui: React.ReactElement) =>
    render(<FilesHostProvider host={host}>{ui}</FilesHostProvider>);

  it('asks the host to delete within the row scope', () => {
    const file = image();
    renderRow(
      <FileRow
        files={new Map([[file.file_id, file]])}
        setFiles={setFiles}
        agent_id="agent-1"
        assistant_id="asst-1"
        tool_resource={EToolResources.file_search}
        index={2}
      />,
    );

    expect(useDeleteFile).toHaveBeenCalledWith({
      agent_id: 'agent-1',
      assistant_id: 'asst-1',
      tool_resource: EToolResources.file_search,
      index: 2,
    });
  });

  it('hands the file and the setter to the host when an image is removed', async () => {
    const file = image();
    renderRow(<FileRow files={new Map([[file.file_id, file]])} setFiles={setFiles} />);

    await userEvent.click(screen.getByRole('button', { name: 'Remove file' }));

    expect(deleteFile).toHaveBeenCalledWith({ file, setFiles });
  });

  it('hands the file and the setter to the host when a file card is removed', async () => {
    const file = document();
    renderRow(<FileRow files={new Map([[file.file_id, file]])} setFiles={setFiles} />);

    await userEvent.click(screen.getByRole('button', { name: 'Remove file' }));

    expect(deleteFile).toHaveBeenCalledWith({ file, setFiles });
  });

  it('aborts an in-flight upload before asking the host to delete it', async () => {
    const abortUpload = jest.fn();
    const file = document({ progress: 0.4 });
    renderRow(
      <FileRow
        files={new Map([[file.file_id, file]])}
        setFiles={setFiles}
        abortUpload={abortUpload}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Remove file' }));

    expect(abortUpload).toHaveBeenCalledWith(file.file_id);
    expect(deleteFile).toHaveBeenCalledWith({ file, setFiles });
  });

  it('draws the host preview in place of the file preview', () => {
    getPreviewUrl.mockReturnValue('blob:http://localhost:3080/host-preview');
    const file = image();
    const { container } = renderRow(
      <FileRow files={new Map([[file.file_id, file]])} setFiles={setFiles} />,
    );

    expect(getPreviewUrl).toHaveBeenCalledWith(file.file_id);
    expect(
      container.querySelector('img[src="blob:http://localhost:3080/host-preview"]'),
    ).toBeInTheDocument();
    expect(
      container.querySelector('img[src="blob:http://localhost:3080/preview"]'),
    ).not.toBeInTheDocument();
  });
});

describe('FileRow pasted-text preview', () => {
  const pastedFile = (overrides: Partial<ExtendedFile> = {}): ExtendedFile => ({
    file_id: 'paste-1',
    type: 'text/plain',
    filename: 'pasted-text.txt',
    progress: 0.3,
    size: 100,
    pastedText: 'The original clipboard content\nincluding the next line',
    text: 'A transformed server copy',
    ...overrides,
  });

  it('shows the original snippet and keeps edit, move, and remove independently actionable', async () => {
    const file = pastedFile();
    const setFiles = jest.fn();
    const abortUpload = jest.fn();
    const onEditPastedText = jest.fn();
    const onMovePastedTextInline = jest.fn();
    const { container } = render(
      <FileRow
        files={new Map([[file.file_id, file]])}
        setFiles={setFiles}
        abortUpload={abortUpload}
        isPastedTextFile={() => true}
        onEditPastedText={onEditPastedText}
        onMovePastedTextInline={onMovePastedTextInline}
      />,
    );

    expect(screen.getByTitle(/The original clipboard content/).textContent).toBe(file.pastedText);
    expect(screen.queryByText(file.text ?? '')).not.toBeInTheDocument();
    expect(container.querySelector('button button')).toBeNull();
    const editor = screen.getByRole('button', { name: 'Edit pasted text, pasted-text.txt' });
    expect(editor).toHaveAccessibleDescription(
      'The original clipboard content\nincluding the next line',
    );
    await userEvent.click(editor);
    expect(onEditPastedText).toHaveBeenCalledWith(file);

    await userEvent.click(screen.getByRole('button', { name: 'Move back into message' }));
    expect(onMovePastedTextInline).toHaveBeenCalledWith(file);
    expect(onEditPastedText).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: 'Remove file' }));
    expect(abortUpload).toHaveBeenCalledWith(file.file_id);
    expect(setFiles).toHaveBeenCalledTimes(1);
  });

  it('keeps the snippet visible while a paste action is pending', () => {
    const file = pastedFile();
    render(
      <FileRow
        files={new Map([[file.file_id, file]])}
        setFiles={jest.fn()}
        isPastedTextFile={() => true}
        isPasteActionPending={() => true}
        onEditPastedText={jest.fn()}
        onMovePastedTextInline={jest.fn()}
      />,
    );

    expect(screen.getByTitle(/The original clipboard content/).textContent).toBe(file.pastedText);
    expect(screen.queryByRole('button', { name: /Edit pasted text/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Move back into message' }),
    ).not.toBeInTheDocument();
  });

  it('leaves a deliberately uploaded pasted-text filename on the ordinary file card', () => {
    const file = pastedFile({ pastedText: undefined, progress: 1 });
    render(
      <FileRow
        files={new Map([[file.file_id, file]])}
        setFiles={jest.fn()}
        isPastedTextFile={() => false}
        onEditPastedText={jest.fn()}
      />,
    );

    expect(screen.getByText('pasted-text.txt')).toBeInTheDocument();
    expect(screen.queryByText(file.text ?? '')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit pasted text/ })).not.toBeInTheDocument();
  });
});

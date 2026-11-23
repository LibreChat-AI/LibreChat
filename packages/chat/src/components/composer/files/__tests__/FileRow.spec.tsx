/**
 * @jest-environment jsdom
 */
import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { FileSources } from 'librechat-data-provider';
import type { ExtendedFile } from '../../../../core/files';
import type { FilesHost } from '../../../../react/files';
import { FilesHostProvider } from '../../../../react/files';
import { initEnglish } from '../../../../__fixtures__/i18n';
import FileRow from '../FileRow';

jest.mock('../Image', () => ({
  __esModule: true,
  default: function MockImage({
    url,
    progress,
    source,
    onDelete,
  }: {
    onDelete?: () => void;
    url?: string;
    progress: number;
    source?: string;
  }) {
    return (
      <div data-testid="mock-image">
        <span data-testid="image-url">{url}</span>
        <span data-testid="image-progress">{progress}</span>
        <span data-testid="image-source">{source}</span>
        <div data-testid="mock-delete" role="presentation" onClick={onDelete} />
      </div>
    );
  },
}));

jest.mock('../FileContainer', () => ({
  __esModule: true,
  default: function MockFileContainer({
    file,
    onClick,
    onDelete,
    ariaLabel,
    textPreview,
    subtitleAction,
  }: {
    onDelete?: () => void;
    file: ExtendedFile;
    onClick?: () => void;
    ariaLabel?: string;
    textPreview?: string | null;
    subtitleAction?: { label: string; onClick: () => void };
  }) {
    return (
      <div data-testid="mock-file-container">
        <span data-testid="file-name">{file.filename}</span>
        <span data-testid="text-preview">{textPreview}</span>
        <div data-testid="mock-delete" role="presentation" onClick={onDelete} />
        {onClick != null && (
          <button type="button" aria-label={ariaLabel} onClick={onClick}>
            {file.filename}
          </button>
        )}
        {subtitleAction != null && (
          <button type="button" aria-label={subtitleAction.label} onClick={subtitleAction.onClick}>
            {subtitleAction.label}
          </button>
        )}
      </div>
    );
  },
}));

beforeAll(initEnglish);

describe('FileRow', () => {
  const mockSetFiles = jest.fn();
  const mockSetFilesLoading = jest.fn();
  const mockDeleteFile = jest.fn();
  const mockUseDeleteFile = jest.fn((): typeof mockDeleteFile => mockDeleteFile);
  const mockGetPreviewUrl = jest.fn((): string | undefined => undefined);

  const host: FilesHost = {
    renderEndpointIcon: () => null,
    useDeleteFile: mockUseDeleteFile,
    getPreviewUrl: mockGetPreviewUrl,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPreviewUrl.mockReset();
    mockGetPreviewUrl.mockReturnValue(undefined);
  });

  /**
   * Creates a mock ExtendedFile with sensible defaults
   */
  const createMockFile = (overrides: Partial<ExtendedFile> = {}): ExtendedFile => ({
    file_id: 'test-file-id',
    type: 'image/png',
    preview: 'blob:http://localhost:3080/preview-blob-url',
    filepath: '/images/user123/test-file-id__image.png',
    filename: 'test-image.png',
    progress: 1,
    size: 1024,
    source: FileSources.local,
    ...overrides,
  });

  const renderRow = (ui: React.ReactElement) =>
    render(<FilesHostProvider host={host}>{ui}</FilesHostProvider>);

  const renderFileRow = (files: Map<string, ExtendedFile>) => {
    return renderRow(
      <FileRow files={files} setFiles={mockSetFiles} setFilesLoading={mockSetFilesLoading} />,
    );
  };

  describe('Image URL Selection Logic', () => {
    it('should prefer cached preview over filepath when upload is complete', () => {
      const file = createMockFile({
        file_id: 'uploaded-file',
        preview: 'blob:http://localhost:3080/temp-preview',
        filepath: '/images/user123/uploaded-file__image.png',
        progress: 1,
      });

      const filesMap = new Map<string, ExtendedFile>();
      filesMap.set(file.file_id, file);

      renderFileRow(filesMap);

      const imageUrl = screen.getByTestId('image-url').textContent;
      expect(imageUrl).toBe('blob:http://localhost:3080/temp-preview');
    });

    it('should use preview when progress is less than 1 (uploading)', () => {
      const file = createMockFile({
        file_id: 'uploading-file',
        preview: 'blob:http://localhost:3080/temp-preview',
        filepath: undefined,
        progress: 0.5,
      });

      const filesMap = new Map<string, ExtendedFile>();
      filesMap.set(file.file_id, file);

      renderFileRow(filesMap);

      const imageUrl = screen.getByTestId('image-url').textContent;
      expect(imageUrl).toBe('blob:http://localhost:3080/temp-preview');
    });

    it('should fallback to filepath when preview is undefined and progress is less than 1', () => {
      const file = createMockFile({
        file_id: 'file-without-preview',
        preview: undefined,
        filepath: '/images/user123/file-without-preview__image.png',
        progress: 0.7,
      });

      const filesMap = new Map<string, ExtendedFile>();
      filesMap.set(file.file_id, file);

      renderFileRow(filesMap);

      const imageUrl = screen.getByTestId('image-url').textContent;
      expect(imageUrl).toBe('/images/user123/file-without-preview__image.png');
    });

    it('should prefer preview over filepath when both exist and progress is 1', () => {
      const file = createMockFile({
        file_id: 'complete-file',
        preview: 'blob:http://localhost:3080/old-blob',
        filepath: '/images/user123/complete-file__image.png',
        progress: 1.0,
      });

      const filesMap = new Map<string, ExtendedFile>();
      filesMap.set(file.file_id, file);

      renderFileRow(filesMap);

      const imageUrl = screen.getByTestId('image-url').textContent;
      expect(imageUrl).toBe('blob:http://localhost:3080/old-blob');
    });
  });

  describe('Progress States', () => {
    it('should pass correct progress value during upload', () => {
      const file = createMockFile({
        progress: 0.65,
      });

      const filesMap = new Map<string, ExtendedFile>();
      filesMap.set(file.file_id, file);

      renderFileRow(filesMap);

      const progress = screen.getByTestId('image-progress').textContent;
      expect(progress).toBe('0.65');
    });

    it('should pass progress value of 1 when upload is complete', () => {
      const file = createMockFile({
        progress: 1,
      });

      const filesMap = new Map<string, ExtendedFile>();
      filesMap.set(file.file_id, file);

      renderFileRow(filesMap);

      const progress = screen.getByTestId('image-progress').textContent;
      expect(progress).toBe('1');
    });
  });

  describe('Blocking upload state', () => {
    it.each(['Clipboard content', ''])(
      'does not block on an inlineable paste: %j',
      (pastedText) => {
        const file = createMockFile({ type: 'text/plain', progress: 0, pastedText });
        renderFileRow(new Map([[file.file_id, file]]));

        expect(mockSetFilesLoading).toHaveBeenLastCalledWith(false);
      },
    );

    it('still blocks on an ordinary upload beside an inlineable paste', () => {
      const paste = createMockFile({
        file_id: 'paste',
        type: 'text/plain',
        progress: 0,
        pastedText: 'Clipboard content',
      });
      const upload = createMockFile({ file_id: 'upload', progress: 0.4 });
      renderFileRow(
        new Map([
          [paste.file_id, paste],
          [upload.file_id, upload],
        ]),
      );

      expect(mockSetFilesLoading).toHaveBeenLastCalledWith(true);
    });

    it('clears loading when the remaining ordinary upload finishes', () => {
      const paste = createMockFile({
        file_id: 'paste',
        type: 'text/plain',
        progress: 0,
        pastedText: 'Clipboard content',
      });
      const upload = createMockFile({ file_id: 'upload', progress: 0.4 });
      const files = new Map([
        [paste.file_id, paste],
        [upload.file_id, upload],
      ]);
      const { rerender } = renderFileRow(files);
      expect(mockSetFilesLoading).toHaveBeenLastCalledWith(true);

      rerender(
        <FilesHostProvider host={host}>
          <FileRow
            files={
              new Map([
                [paste.file_id, paste],
                [upload.file_id, { ...upload, progress: 1 }],
              ])
            }
            setFiles={mockSetFiles}
            setFilesLoading={mockSetFilesLoading}
          />
        </FilesHostProvider>,
      );

      expect(mockSetFilesLoading).toHaveBeenLastCalledWith(false);
    });

    it('does not treat stored text alone as an inlineable pending paste', () => {
      const file = createMockFile({ type: 'text/plain', progress: 0, text: 'Stored text' });
      renderFileRow(new Map([[file.file_id, file]]));

      expect(mockSetFilesLoading).toHaveBeenLastCalledWith(true);
    });
  });

  describe('File Source', () => {
    it('should pass local source to Image component', () => {
      const file = createMockFile({
        source: FileSources.local,
      });

      const filesMap = new Map<string, ExtendedFile>();
      filesMap.set(file.file_id, file);

      renderFileRow(filesMap);

      const source = screen.getByTestId('image-source').textContent;
      expect(source).toBe(FileSources.local);
    });

    it('should pass openai source to Image component', () => {
      const file = createMockFile({
        source: FileSources.openai,
      });

      const filesMap = new Map<string, ExtendedFile>();
      filesMap.set(file.file_id, file);

      renderFileRow(filesMap);

      const source = screen.getByTestId('image-source').textContent;
      expect(source).toBe(FileSources.openai);
    });
  });

  describe('File Type Detection', () => {
    it('should render Image component for image files', () => {
      const file = createMockFile({
        type: 'image/jpeg',
      });

      const filesMap = new Map<string, ExtendedFile>();
      filesMap.set(file.file_id, file);

      renderFileRow(filesMap);

      expect(screen.getByTestId('mock-image')).toBeInTheDocument();
      expect(screen.queryByTestId('mock-file-container')).not.toBeInTheDocument();
    });

    it('should render FileContainer for non-image files', () => {
      const file = createMockFile({
        type: 'application/pdf',
        filename: 'document.pdf',
      });

      const filesMap = new Map<string, ExtendedFile>();
      filesMap.set(file.file_id, file);

      renderFileRow(filesMap);

      expect(screen.getByTestId('mock-file-container')).toBeInTheDocument();
      expect(screen.queryByTestId('mock-image')).not.toBeInTheDocument();
    });
  });

  describe('Multiple Files', () => {
    it('should render multiple image files with correct URLs based on their progress', () => {
      const filesMap = new Map<string, ExtendedFile>();

      const uploadingFile = createMockFile({
        file_id: 'file-1',
        preview: 'blob:http://localhost:3080/preview-1',
        filepath: undefined,
        progress: 0.3,
      });

      const completedFile = createMockFile({
        file_id: 'file-2',
        preview: 'blob:http://localhost:3080/preview-2',
        filepath: '/images/user123/file-2__image.png',
        progress: 1,
      });

      filesMap.set(uploadingFile.file_id, uploadingFile);
      filesMap.set(completedFile.file_id, completedFile);

      renderFileRow(filesMap);

      const images = screen.getAllByTestId('mock-image');
      expect(images).toHaveLength(2);

      const urls = screen.getAllByTestId('image-url').map((el) => el.textContent);
      expect(urls).toContain('blob:http://localhost:3080/preview-1');
      expect(urls).toContain('blob:http://localhost:3080/preview-2');
    });

    it('should deduplicate files with the same file_id', () => {
      const filesMap = new Map<string, ExtendedFile>();

      const file1 = createMockFile({ file_id: 'duplicate-id' });
      const file2 = createMockFile({ file_id: 'duplicate-id' });

      filesMap.set('key-1', file1);
      filesMap.set('key-2', file2);

      renderFileRow(filesMap);

      const images = screen.getAllByTestId('mock-image');
      expect(images).toHaveLength(1);
    });
  });

  describe('Empty State', () => {
    it('should render nothing when files map is empty', () => {
      const filesMap = new Map<string, ExtendedFile>();

      const { container } = renderFileRow(filesMap);

      expect(container.firstChild).toBeNull();
    });

    it('should render nothing when files is undefined', () => {
      const { container } = renderRow(
        <FileRow files={undefined} setFiles={mockSetFiles} setFilesLoading={mockSetFilesLoading} />,
      );

      expect(container.firstChild).toBeNull();
    });
  });

  describe('Preview Cache Integration', () => {
    it('should prefer preview blob URL over filepath for zero-flicker rendering', () => {
      const file = createMockFile({
        file_id: 'cache-test',
        preview: 'blob:http://localhost:3080/d25f730c-152d-41f7-8d79-c9fa448f606b',
        filepath:
          '/images/68c98b26901ebe2d87c193a2/c0fe1b93-ba3d-456c-80be-9a492bfd9ed0__image.png',
        progress: 1,
      });

      const filesMap = new Map<string, ExtendedFile>();
      filesMap.set(file.file_id, file);

      renderFileRow(filesMap);

      const imageUrl = screen.getByTestId('image-url').textContent;
      expect(imageUrl).toBe('blob:http://localhost:3080/d25f730c-152d-41f7-8d79-c9fa448f606b');
    });

    it('should fall back to filepath when no preview exists', () => {
      const file = createMockFile({
        file_id: 'no-preview',
        preview: undefined,
        filepath:
          '/images/68c98b26901ebe2d87c193a2/c0fe1b93-ba3d-456c-80be-9a492bfd9ed0__image.png',
        progress: 1,
      });

      const filesMap = new Map<string, ExtendedFile>();
      filesMap.set(file.file_id, file);

      renderFileRow(filesMap);

      const imageUrl = screen.getByTestId('image-url').textContent;
      expect(imageUrl).toBe(
        '/images/68c98b26901ebe2d87c193a2/c0fe1b93-ba3d-456c-80be-9a492bfd9ed0__image.png',
      );
    });
  });
  describe('Pasted-text editing', () => {
    const pastedFile = (overrides: Partial<ExtendedFile> = {}) =>
      createMockFile({
        file_id: 'pasted-file',
        type: 'text/plain',
        filename: 'pasted-text.txt',
        preview: undefined,
        filepath: '/uploads/user123/pasted-text.txt',
        ...overrides,
      });

    const renderWithEditor = (
      file: ExtendedFile,
      {
        isPaste = true,
        actionPending = false,
        onEditPastedText,
        onMovePastedTextInline,
      }: {
        /** Stands in for the provenance registry the composer passes down. */
        isPaste?: boolean;
        /** Stands in for the in-flight action lock the composer passes down. */
        actionPending?: boolean;
        onEditPastedText?: (f: ExtendedFile) => void;
        onMovePastedTextInline?: (f: ExtendedFile) => void;
      } = {},
    ) => {
      const filesMap = new Map<string, ExtendedFile>();
      filesMap.set(file.file_id, file);
      return renderRow(
        <FileRow
          files={filesMap}
          setFiles={mockSetFiles}
          setFilesLoading={mockSetFilesLoading}
          isPastedTextFile={() => isPaste}
          isPasteActionPending={() => actionPending}
          onEditPastedText={onEditPastedText}
          onMovePastedTextInline={onMovePastedTextInline}
        />,
      );
    };

    it('opens the editor with the chip that was clicked', async () => {
      const onEditPastedText = jest.fn();
      const file = pastedFile();
      renderWithEditor(file, { onEditPastedText });

      await userEvent.click(
        screen.getByRole('button', { name: 'Edit pasted text, pasted-text.txt' }),
      );

      expect(onEditPastedText).toHaveBeenCalledWith(file);
    });

    it('names the action rather than just the file for screen readers', () => {
      renderWithEditor(pastedFile(), { onEditPastedText: jest.fn() });

      expect(screen.getByRole('button').getAttribute('aria-label')).toBe(
        'Edit pasted text, pasted-text.txt',
      );
    });

    it('numbered pastes are editable too', () => {
      renderWithEditor(pastedFile({ filename: 'pasted-text-2.txt' }), {
        onEditPastedText: jest.fn(),
      });

      expect(screen.getByRole('button')).toBeInTheDocument();
    });

    it('leaves a deliberate text upload inert', () => {
      renderWithEditor(pastedFile({ filename: 'notes.txt' }), { isPaste: false });

      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('leaves a deliberate upload named like a paste inert', () => {
      renderWithEditor(pastedFile(), { isPaste: false });

      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('waits for upload completion when neither local text nor a local file is available', () => {
      renderWithEditor(pastedFile({ progress: 0.4 }), { onEditPastedText: jest.fn() });

      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('offers editing and moving while original pasted text is still uploading', async () => {
      const onEditPastedText = jest.fn();
      const onMovePastedTextInline = jest.fn();
      const file = pastedFile({ progress: 0.4, pastedText: 'Original clipboard text' });
      renderWithEditor(file, { onEditPastedText, onMovePastedTextInline });

      await userEvent.click(
        screen.getByRole('button', { name: 'Edit pasted text, pasted-text.txt' }),
      );
      await userEvent.click(screen.getByRole('button', { name: 'Move back into message' }));

      expect(onEditPastedText).toHaveBeenCalledWith(file);
      expect(onMovePastedTextInline).toHaveBeenCalledWith(file);
    });

    it('offers editing while a local pasted file is uploading', () => {
      renderWithEditor(
        pastedFile({ progress: 0, file: new File(['Local clipboard text'], 'pasted-text.txt') }),
        { onEditPastedText: jest.fn() },
      );

      expect(
        screen.getByRole('button', { name: 'Edit pasted text, pasted-text.txt' }),
      ).toBeInTheDocument();
    });

    it('can edit an empty local paste before its upload finishes', () => {
      renderWithEditor(pastedFile({ progress: 0, pastedText: '' }), {
        onEditPastedText: jest.fn(),
      });

      expect(
        screen.getByRole('button', { name: 'Edit pasted text, pasted-text.txt' }),
      ).toBeInTheDocument();
    });

    it('previews original pasted text instead of the stored transformed copy', () => {
      renderWithEditor(pastedFile({ pastedText: 'Original paste', text: 'Stored copy' }));

      expect(screen.getByTestId('text-preview')).toHaveTextContent(/^Original paste$/);
    });

    it('previews stored text for a restored generated paste', () => {
      renderWithEditor(pastedFile({ text: 'Restored clipboard text' }));

      expect(screen.getByTestId('text-preview')).toHaveTextContent('Restored clipboard text');
    });

    it('does not preview a deliberate text upload even when its filename matches a paste', () => {
      renderWithEditor(pastedFile({ text: 'Uploaded text', pastedText: 'Not a generated paste' }), {
        isPaste: false,
        onEditPastedText: jest.fn(),
      });

      expect(screen.getByTestId('text-preview')).toBeEmptyDOMElement();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('stays inert where no editor is wired up', () => {
      renderWithEditor(pastedFile());

      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('stays inert where no provenance predicate is wired up', () => {
      const filesMap = new Map<string, ExtendedFile>();
      filesMap.set('pasted-file', pastedFile());
      renderRow(
        <FileRow
          files={filesMap}
          setFiles={mockSetFiles}
          setFilesLoading={mockSetFilesLoading}
          onEditPastedText={jest.fn()}
        />,
      );

      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('offers returning the paste to the composer from the chip subtitle', async () => {
      const onMovePastedTextInline = jest.fn();
      const file = pastedFile();
      renderWithEditor(file, { onEditPastedText: jest.fn(), onMovePastedTextInline });

      await userEvent.click(screen.getByRole('button', { name: 'Move back into message' }));

      expect(onMovePastedTextInline).toHaveBeenCalledWith(file);
    });

    it('offers no subtitle action for a deliberate text upload', () => {
      renderWithEditor(pastedFile({ filename: 'notes.txt' }), {
        isPaste: false,
        onMovePastedTextInline: jest.fn(),
      });

      expect(
        screen.queryByRole('button', { name: 'Move back into message' }),
      ).not.toBeInTheDocument();
    });

    it('hides the paste actions while an action is in flight for the chip', () => {
      renderWithEditor(pastedFile(), {
        actionPending: true,
        onEditPastedText: jest.fn(),
        onMovePastedTextInline: jest.fn(),
      });

      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('offers no subtitle action where no handler is wired up', () => {
      renderWithEditor(pastedFile());

      expect(
        screen.queryByRole('button', { name: 'Move back into message' }),
      ).not.toBeInTheDocument();
    });
  });
});

import React from 'react';
import { FileSources } from 'librechat-data-provider';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { Artifact } from '~/common';
import { fileToArtifact, TOOL_ARTIFACT_TYPES } from '~/utils/artifacts';
import DownloadArtifact from '../DownloadArtifact';

const mockFileDownload = jest.fn();
const mockAttachmentOptions = jest.fn();
let mockFileKey = 'index.html';
let mockCurrentCode: string | undefined;

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string): string =>
      key,
}));

jest.mock('~/hooks/Artifacts/useArtifactProps', () => ({
  __esModule: true,
  default: () => ({ fileKey: mockFileKey, files: {}, template: 'static', sharedProps: {} }),
}));

jest.mock('~/Providers/EditorContext', () => ({
  useCodeState: () => ({ currentCode: mockCurrentCode }),
}));

const mockShowToast = jest.fn();

/* MorphIcon renders a single morphing <svg> with no per-icon class, so map
 * the lucide icon data it was handed back to a stable name instead. */
jest.mock('@librechat/client', () => {
  const { createMorphIconMock } = jest.requireActual('~/../test/mockMorphIcon');
  const { Download, CircleCheckBig } = jest.requireActual('lucide');
  return {
    ...jest.requireActual('@librechat/client'),
    useToastContext: () => ({ showToast: mockShowToast }),
    MorphIcon: createMorphIconMock([
      [Download, 'download'],
      [CircleCheckBig, 'circle-check-big'],
    ]),
  };
});

jest.mock('~/components/Chat/Messages/Content/Parts/LogLink', () => ({
  useAttachmentLink: (options: { filename: string }) => {
    mockAttachmentOptions(options);
    return { handleDownload: mockFileDownload };
  },
  isLocallyStoredSource: (source?: string) =>
    ['local', 'firebase', 's3', 'cloudfront', 'azure_blob'].includes(source ?? ''),
}));

const officeArtifact: Artifact = {
  id: 'tool-artifact-fid-1',
  lastUpdateTime: 0,
  type: TOOL_ARTIFACT_TYPES.PRESENTATION,
  title: 'deck.pptx',
  content: '<html><body>slide text scrape</body></html>',
  download: {
    filepath: '/api/files/code/output/deck.pptx',
    file_id: 'fid-1',
    source: 'execute_code',
    user: 'user-1',
  },
};

const htmlArtifact: Artifact = {
  id: 'llm-artifact-1',
  lastUpdateTime: 0,
  type: TOOL_ARTIFACT_TYPES.HTML,
  title: 'Authored Page',
  content: '<h1>hello</h1>',
};

/* Shared link to a non-snapshotted code-execution office artifact: share
 * sanitization strips source/user and `applyShareFileRoute` deletes
 * filepath, leaving only file_id. There is no route to fetch the
 * original, so the panel must fall back to the preview-content blob. */
const sharedNoRouteArtifact: Artifact = {
  id: 'tool-artifact-fid-2',
  lastUpdateTime: 0,
  type: TOOL_ARTIFACT_TYPES.PRESENTATION,
  title: 'deck.pptx',
  content: '<html><body>slide text scrape</body></html>',
  download: {
    file_id: 'fid-2',
  },
};

/* Locally-stored office artifact with no filepath but full local-file
 * metadata: the API download path (isLocallyStoredSource + file_id +
 * user) can still fetch the original. */
const localMetadataArtifact: Artifact = {
  id: 'tool-artifact-fid-3',
  lastUpdateTime: 0,
  type: TOOL_ARTIFACT_TYPES.SPREADSHEET,
  title: 'book.xlsx',
  content: '<html><body>sheet scrape</body></html>',
  download: {
    file_id: 'fid-3',
    source: 'local',
    user: 'user-3',
  },
};

describe('DownloadArtifact', () => {
  let createObjectURL: jest.Mock;
  let revokeObjectURL: jest.Mock;
  let anchorClick: jest.SpyInstance;

  beforeEach(() => {
    mockFileKey = 'index.html';
    mockCurrentCode = undefined;
    mockFileDownload.mockReset();
    mockShowToast.mockReset();
    // The attachment helper resolves to `true` when a file was delivered.
    mockFileDownload.mockResolvedValue(true);
    createObjectURL = jest.fn(() => 'blob:mock');
    revokeObjectURL = jest.fn();
    Object.defineProperty(window.URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(window.URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURL,
    });
    anchorClick = jest
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    anchorClick.mockRestore();
  });

  it.each([
    ['text/markdown', 'Migration Plan', 'content.md', undefined, 'Migration Plan.md'],
    ['text/md', 'Second Report', 'content.md', undefined, 'Second Report.md'],
    ['text/markdown', 'Report.MD', 'content.md', undefined, 'Report.MD'],
    ['text/plain', 'Meeting Notes', 'content.md', undefined, 'Meeting Notes.txt'],
    ['text/plain', 'notes.odt', 'content.md', undefined, 'notes.odt.txt'],
    ['text/plain', 'report.docx', 'content.md', undefined, 'report.docx.txt'],
    ['text/plain', 'notes.TXT', 'content.md', undefined, 'notes.TXT'],
    ['text/markdown', 'Release Notes v1.0', 'content.md', undefined, 'Release Notes v1.0.md'],
    ['text/html', 'example.com', 'index.html', undefined, 'example.com.html'],
    [TOOL_ARTIFACT_TYPES.CODE, 'script.py', 'content.md', 'python', 'script.py'],
    [TOOL_ARTIFACT_TYPES.CODE, 'script.py', 'content.md', undefined, 'script.py'],
    [TOOL_ARTIFACT_TYPES.CODE, 'example.com', 'content.md', 'python', 'example.com.py'],
    [TOOL_ARTIFACT_TYPES.CODE, 'Analysis', 'content.md', 'python', 'Analysis.py'],
    [TOOL_ARTIFACT_TYPES.CODE, '', 'content.md', 'typescript', 'code.ts'],
    ['text/html', 'Landing Page', 'index.html', undefined, 'Landing Page.html'],
    ['application/vnd.react', 'Dashboard', 'App.tsx', undefined, 'Dashboard.tsx'],
    ['application/vnd.mermaid', 'Flow', 'diagram.mmd', undefined, 'Flow.mmd'],
    ['text/markdown', '  ', 'content.md', undefined, 'content.md'],
    ['text/plain', undefined, 'content.md', undefined, 'content.txt'],
    ['text/markdown', 'Plan: Q3/Q4', 'content.md', undefined, 'Plan_ Q3_Q4.md'],
    [TOOL_ARTIFACT_TYPES.PRESENTATION, 'deck.pptx', 'index.html', undefined, 'deck.pptx.html'],
  ])('names %s download with title %s', async (type, title, fileKey, language, expected) => {
    mockFileKey = fileKey;
    mockCurrentCode = 'edited content';
    render(<DownloadArtifact artifact={{ ...htmlArtifact, type, title, language }} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(anchorClick.mock.instances[0].download).toBe(expected);
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    const content = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    expect(content).toBe('edited content');
    expect(mockFileDownload).not.toHaveBeenCalled();
  });

  it.each([undefined, 'untitled', 'Generated artifact'])(
    'names untitled Markdown from the edited heading (%s)',
    async (title) => {
      mockFileKey = 'content.md';
      mockCurrentCode = '# New **migration** [plan](https://example.com) for `migrate_users.py`';
      render(
        <DownloadArtifact
          artifact={{ ...htmlArtifact, type: 'text/markdown', title, content: '# Old heading' }}
        />,
      );
      await act(async () => {
        fireEvent.click(screen.getByRole('button'));
      });
      expect(anchorClick.mock.instances[0].download).toBe(
        'New migration plan for migrate_users.py.md',
      );
    },
  );

  it.each([
    ['Component.jsx', 'App.tsx'],
    ['page.htm', 'index.html'],
    ['README.markdown', 'content.md'],
    ['README.mdx', 'content.md'],
  ])('downloads file-backed raw content as %s', async (filename, fileKey) => {
    mockFileKey = fileKey;
    const artifact = fileToArtifact({ file_id: 'file', filename, text: 'Raw content' });
    expect(artifact).not.toBeNull();
    render(<DownloadArtifact artifact={artifact!} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    const dot = filename.lastIndexOf('.');
    expect(anchorClick.mock.instances[0].download).toBe(
      `${filename.slice(0, dot)}.preview${filename.slice(dot)}`,
    );
    expect(mockFileDownload).not.toHaveBeenCalled();
  });

  it.each(['untitled', 'Generated artifact', 'Component.jsx', 'notes.txt'])(
    'keeps the exact original filename when fetching %s',
    async (filename) => {
      const artifact = fileToArtifact({
        file_id: 'file',
        filename,
        type: 'text/markdown',
        text: 'Complete file\n\n…[truncated]',
        filepath: '/api/files/code/output/file',
      });
      render(<DownloadArtifact artifact={artifact!} />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button'));
      });
      expect(mockFileDownload).toHaveBeenCalledTimes(1);
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(mockAttachmentOptions).toHaveBeenLastCalledWith(expect.objectContaining({ filename }));
    },
  );

  it.each([
    ['text/markdown', 'content.md', 'content.md'],
    ['text/x-python', 'content.md', 'code.py'],
    ['text/html', 'index.html', 'content.html'],
    ['application/vnd.react', 'App.tsx', 'App.tsx'],
    ['application/vnd.oasis.opendocument.text', 'content.md', 'content.odt'],
    [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'index.html',
      'content.docx',
    ],
    ['text/csv', 'index.html', 'content.csv'],
    ['text/comma-separated-values', 'index.html', 'content.csv'],
    ['text/comma-separated-values; charset=utf-8', 'index.html', 'content.csv'],
    ['application/x-dos_ms_excel', 'index.html', 'content.xls'],
  ])(
    'uses an original-format fallback when %s has no filename',
    async (type, fileKey, expected) => {
      mockFileKey = fileKey;
      const artifact = fileToArtifact({
        file_id: 'file',
        type,
        text: 'Preview',
        filepath: '/api/files/code/output/file',
      });
      expect(artifact?.download?.filename).toBeNull();
      render(<DownloadArtifact artifact={artifact!} />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button'));
      });
      expect(mockFileDownload).toHaveBeenCalledTimes(1);
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(mockAttachmentOptions).toHaveBeenLastCalledWith(
        expect.objectContaining({ filename: expected }),
      );
    },
  );

  it('uses a fallback for an empty attachment filename', async () => {
    const artifact = fileToArtifact({
      file_id: 'file',
      filename: '',
      type: 'text/markdown',
      text: '# Heading',
      filepath: '/api/files/code/output/file',
    });
    render(<DownloadArtifact artifact={artifact!} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(mockFileDownload).toHaveBeenCalledTimes(1);
    expect(mockAttachmentOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ filename: 'content.md' }),
    );
  });

  it.each([undefined, 'Prefix\n\n…[truncated]'])(
    'fetches the complete original for unedited cached content (%s)',
    async (currentCode) => {
      mockCurrentCode = currentCode;
      const artifact = fileToArtifact({
        file_id: 'file',
        filename: 'large.py',
        text: 'Prefix\n\n…[truncated]',
        filepath: '/api/files/code/output/large.py',
      });
      render(<DownloadArtifact artifact={artifact!} />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button'));
      });
      expect(mockFileDownload).toHaveBeenCalledTimes(1);
      expect(createObjectURL).not.toHaveBeenCalled();
    },
  );

  it.each(['Edited prefix', ''])(
    'exports edits to a truncated preview with a distinct name (%s)',
    async (edit) => {
      mockCurrentCode = edit;
      const artifact = fileToArtifact({
        file_id: 'file',
        filename: 'large.py',
        text: 'Prefix\n\n…[truncated]',
        filepath: '/api/files/code/output/large.py',
      });
      render(<DownloadArtifact artifact={artifact!} />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button'));
      });
      expect(mockFileDownload).not.toHaveBeenCalled();
      expect(anchorClick.mock.instances[0].download).toBe('large.preview.py');
      const blob = createObjectURL.mock.calls[0][0] as Blob;
      expect(blob.size).toBe(edit.length);
    },
  );

  it('names a truncated preview distinctly when the original route is unavailable', async () => {
    const artifact = fileToArtifact({
      file_id: 'file',
      filename: 'large.txt',
      text: 'Prefix\n\n…[truncated]',
    });
    render(<DownloadArtifact artifact={artifact!} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(mockFileDownload).not.toHaveBeenCalled();
    expect(anchorClick.mock.instances[0].download).toBe('large.preview.txt');
  });

  it('does not silently substitute a preview after an original download fails, and can retry', async () => {
    mockFileDownload.mockResolvedValueOnce(false);
    const artifact = fileToArtifact({
      file_id: 'file',
      filename: 'large.py',
      text: 'Prefix\n\n…[truncated]',
      filepath: '/api/files/code/output/large.py',
    });
    const { container } = render(<DownloadArtifact artifact={artifact!} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(container.querySelector('[data-icon="circle-check-big"]')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(mockFileDownload).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-icon="circle-check-big"]')).not.toBeNull();
  });

  it('preserves extensionless source filenames', async () => {
    render(
      <DownloadArtifact
        artifact={{
          ...htmlArtifact,
          type: TOOL_ARTIFACT_TYPES.CODE,
          title: 'Dockerfile',
          download: { file_id: 'source' },
        }}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(anchorClick.mock.instances[0].download).toBe('Dockerfile.preview');
  });

  it('downloads the original file (not the preview) for an office artifact and shows success', async () => {
    const { container } = render(<DownloadArtifact artifact={officeArtifact} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(mockFileDownload).toHaveBeenCalledTimes(1);
    // The preview HTML must NOT be serialized into a blob download.
    expect(createObjectURL).not.toHaveBeenCalled();
    // A delivered file flips the button to the success checkmark.
    expect(container.querySelector('[data-icon="circle-check-big"]')).not.toBeNull();
  });

  it('does NOT show success when the original-file download fails', async () => {
    // Expired code-output URL / 404 share download: the helper resolves
    // to false instead of throwing. The checkmark must stay hidden.
    mockFileDownload.mockResolvedValueOnce(false);
    const { container } = render(<DownloadArtifact artifact={officeArtifact} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(mockFileDownload).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-icon="circle-check-big"]')).toBeNull();
    expect(container.querySelector('[data-icon="download"]')).not.toBeNull();
  });

  it('reports a failed blob export instead of looking like it worked', async () => {
    /* The mermaid export menu only speaks in its live region for a reported
     * failure, on the rule that whichever layer returned `false` already
     * told the user. This is that layer for the blob path. */
    createObjectURL.mockImplementation(() => {
      throw new Error('no object url');
    });
    const { container } = render(<DownloadArtifact artifact={htmlArtifact} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    /* The hook localizes through `~/hooks/useLocalize` directly, outside
     * this file's `~/hooks` mock, so the real string lands here. */
    expect(mockShowToast).toHaveBeenCalledWith({
      status: 'error',
      message: 'Error downloading file. The file may have been deleted.',
    });
    expect(container.querySelector('[data-icon="circle-check-big"]')).toBeNull();
  });

  it('downloads an unedited mermaid diagram from its stored file, not the cached text', async () => {
    /* `attachment.text` is the backend's cached extraction, and
     * `extractUtf8` keeps only the first 512 KB of it, so a large stored
     * `.mmd` would be saved truncated if the panel serialized `content`
     * instead of fetching the file. */
    mockFileKey = 'diagram.mmd';
    const artifact = fileToArtifact({
      file_id: 'file',
      filename: 'flow.mmd',
      text: 'graph TD\nA-->B\n\n…[truncated]',
      filepath: '/api/files/code/output/session/flow.mmd',
      source: FileSources.execute_code,
      user: 'user-1',
    });
    expect(artifact?.type).toBe(TOOL_ARTIFACT_TYPES.MERMAID);
    const { container } = render(<DownloadArtifact artifact={artifact!} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(mockFileDownload).toHaveBeenCalledTimes(1);
    expect(mockAttachmentOptions).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'flow.mmd' }),
    );
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(container.querySelector('[data-icon="circle-check-big"]')).not.toBeNull();
  });

  it('serializes an edited mermaid diagram from the panel content', async () => {
    /* Edits live only in the editor, so the stored file is the wrong bytes.
     * The blob is named as a preview of that file: the panel's copy is the
     * cached extraction, which the backend truncates past 512 KB. */
    mockFileKey = 'diagram.mmd';
    mockCurrentCode = 'graph TD\nA-->C';
    const artifact = fileToArtifact({
      file_id: 'file',
      filename: 'flow.mmd',
      text: 'graph TD\nA-->B',
      filepath: '/api/files/code/output/session/flow.mmd',
      source: FileSources.execute_code,
      user: 'user-1',
    });
    render(<DownloadArtifact artifact={artifact!} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(mockFileDownload).not.toHaveBeenCalled();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchorClick.mock.instances[0].download).toBe('flow.preview.mmd');
  });

  it('serializes content as a blob for a non-file-backed (LLM-authored) artifact', async () => {
    render(<DownloadArtifact artifact={htmlArtifact} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(mockFileDownload).not.toHaveBeenCalled();
  });

  it('falls back to the preview blob when an office artifact has only a lone file_id (no usable route)', async () => {
    render(<DownloadArtifact artifact={sharedNoRouteArtifact} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    // No filepath/share route and no local metadata: must NOT call the
    // empty attachment fetch; serialize the preview content instead.
    expect(mockFileDownload).not.toHaveBeenCalled();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('downloads the original via the local-file path when filepath is absent but local metadata is present', async () => {
    render(<DownloadArtifact artifact={localMetadataArtifact} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(mockFileDownload).toHaveBeenCalledTimes(1);
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});

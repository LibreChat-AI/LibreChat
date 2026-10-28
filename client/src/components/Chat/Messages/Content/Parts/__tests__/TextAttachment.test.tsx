import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { TAttachment } from 'librechat-data-provider';

let mockRemScale = 1;
jest.mock('@librechat/client', () => ({
  useRemScale: () => mockRemScale,
}));
import Attachment, { AttachmentGroup } from '../Attachment';

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string): string => {
      const translations: Record<string, string> = {
        com_ui_show_all: 'Show all',
        com_ui_collapse: 'Collapse',
      };
      return translations[key] ?? key;
    },
  /* `FileAttachment` calls this hook unconditionally to bridge the
   * deferred-preview lifecycle. Stub to a no-op for tests that
   * don't exercise the preview flow. */
  useAttachmentPreviewSync: () => ({ status: 'ready', previewError: undefined, isPolling: false }),
  useExpandCollapse: (isExpanded: boolean) => ({
    style: { display: 'grid', gridTemplateRows: isExpanded ? '1fr' : '0fr' },
    ref: { current: null },
  }),
}));

const mockHandleDownload = jest.fn();
jest.mock('../LogLink', () => ({
  useAttachmentLink: () => ({ handleDownload: mockHandleDownload }),
}));

jest.mock('~/components/Chat/Input/Files/FileContainer', () => ({
  __esModule: true,
  default: ({ file, onClick }: { file: { filename?: string }; onClick?: () => void }) => (
    <button type="button" data-testid="file-container" onClick={onClick}>
      {file.filename ?? ''}
    </button>
  ),
}));

jest.mock('~/components/Chat/Messages/Content/Image', () => ({
  __esModule: true,
  default: ({ altText }: { altText?: string }) => <img alt={altText ?? ''} data-testid="image" />,
}));

jest.mock('~/components/Messages/Content/Mermaid/Mermaid', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => (
    <div data-testid="mermaid-render">{children}</div>
  ),
}));

jest.mock('~/components/Chat/Input/Files/FilePreview', () => ({
  __esModule: true,
  default: () => <div data-testid="file-preview" />,
}));

jest.mock('~/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
  getFileType: () => ({ paths: [], color: '', title: 'Artifact' }),
  logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  isArtifactRoute: () => false,
}));

const textAttachment = (overrides: Partial<TAttachment> = {}): TAttachment =>
  ({
    file_id: 'file-1',
    /* JSON stays on the inline `<pre>` rendering path. CSV used to live
     * here too but now routes through the SPREADSHEET artifact panel
     * (Recoil-bound), so a CSV fixture would force every test in this
     * file to add a `RecoilRoot` wrapper. JSON has the same shape (text-
     * bearing, downloadable, expandable) without the panel coupling. */
    filename: 'output.json',
    filepath: '/files/output.json',
    text: '{"a":1,"b":2,"c":3}',
    ...overrides,
  }) as TAttachment;

const originalScrollHeightDescriptor = Object.getOwnPropertyDescriptor(
  HTMLPreElement.prototype,
  'scrollHeight',
);

const setScrollHeight = (value: number) => {
  Object.defineProperty(HTMLPreElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      return value;
    },
  });
};

const restoreScrollHeight = () => {
  if (originalScrollHeightDescriptor) {
    Object.defineProperty(HTMLPreElement.prototype, 'scrollHeight', originalScrollHeightDescriptor);
  } else {
    // No own descriptor existed before — delete the override so the prototype
    // chain falls back to the inherited HTMLElement implementation.

    delete (HTMLPreElement.prototype as any).scrollHeight;
  }
};

afterAll(() => {
  mockRemScale = 1;
  restoreScrollHeight();
});

describe('TextAttachment (via Attachment default export)', () => {
  beforeEach(() => {
    mockRemScale = 1;
    mockHandleDownload.mockReset();
    setScrollHeight(0);
  });

  it('renders the text content inside a <pre>', () => {
    const { container } = render(<Attachment attachment={textAttachment()} />);
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toBe('{"a":1,"b":2,"c":3}');
  });

  it('renders a download chip when filepath is present', () => {
    render(<Attachment attachment={textAttachment()} />);
    expect(screen.getByTestId('file-container')).toBeInTheDocument();
  });

  it('hides the download chip when filepath is absent', () => {
    render(<Attachment attachment={textAttachment({ filepath: '' })} />);
    expect(screen.queryByTestId('file-container')).not.toBeInTheDocument();
  });

  it('does not render a show/collapse button when content fits', () => {
    setScrollHeight(100); // < COLLAPSED_MAX_HEIGHT (320)
    render(<Attachment attachment={textAttachment()} />);
    expect(screen.queryByRole('button', { name: /show all|collapse/i })).not.toBeInTheDocument();
  });

  it('renders an expand button with aria-expanded=false when content overflows', () => {
    setScrollHeight(800); // > COLLAPSED_MAX_HEIGHT (320)
    render(<Attachment attachment={textAttachment()} />);
    const button = screen.getByRole('button', { name: 'Show all' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveAttribute('aria-controls');
  });

  it('toggles aria-expanded and label when the button is clicked', () => {
    setScrollHeight(800);
    render(<Attachment attachment={textAttachment()} />);
    const button = screen.getByRole('button', { name: 'Show all' });
    act(() => {
      fireEvent.click(button);
    });
    const expanded = screen.getByRole('button', { name: 'Collapse' });
    expect(expanded).toHaveAttribute('aria-expanded', 'true');
  });

  it('recalculates the text preview when the root scale changes', () => {
    setScrollHeight(300);
    mockRemScale = 1.5;
    const { container, rerender } = render(<Attachment attachment={textAttachment()} />);
    expect(screen.queryByRole('button', { name: 'Show all' })).not.toBeInTheDocument();

    mockRemScale = 0.5;
    rerender(<Attachment attachment={textAttachment()} />);
    expect(screen.getByRole('button', { name: 'Show all' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(container.querySelector('pre')).toHaveStyle({ maxHeight: '160px' });

    mockRemScale = 1.5;
    rerender(<Attachment attachment={textAttachment()} />);
    expect(screen.queryByRole('button', { name: 'Show all' })).not.toBeInTheDocument();
    expect(container.querySelector('pre')?.style.maxHeight).toBe('');
  });

  it('falls through to FileAttachment when text is missing', () => {
    const noText = textAttachment({ text: undefined as unknown as string });
    render(<Attachment attachment={noText} />);
    // FileAttachment also renders the FileContainer mock — we assert the
    // <pre> is absent to confirm the text branch was not taken.
    expect(screen.queryByText('a,b,c\n1,2,3')).not.toBeInTheDocument();
    expect(screen.getByTestId('file-container')).toBeInTheDocument();
  });

  it('falls through to FileAttachment when text is the empty string', () => {
    const empty = textAttachment({ text: '' });
    const { container } = render(<Attachment attachment={empty} />);
    expect(container.querySelector('pre')).toBeNull();
    expect(screen.getByTestId('file-container')).toBeInTheDocument();
  });
});

describe('AttachmentGroup', () => {
  beforeEach(() => {
    mockRemScale = 1;
    setScrollHeight(0);
  });

  it('routes text-bearing attachments through the text rendering path', () => {
    /* `.json` is text-bearing but not artifact-eligible (JSON has no
     * dedicated viewer yet), so it falls through to the inline <pre>
     * renderer rather than the side panel card. CSV used to live here
     * too but now routes through the SPREADSHEET artifact panel. */
    const attachments = [textAttachment({ file_id: 'a', filename: 'a.json' })] as TAttachment[];
    const { container } = render(<AttachmentGroup attachments={attachments} />);
    expect(container.querySelector('pre')).not.toBeNull();
  });

  it('routes plain-file attachments to the FileAttachment branch', () => {
    const attachments = [
      textAttachment({
        file_id: 'b',
        filename: 'archive.zip',
        text: undefined,
      }),
    ] as TAttachment[];
    const { container } = render(<AttachmentGroup attachments={attachments} />);
    expect(container.querySelector('pre')).toBeNull();
    expect(screen.getAllByTestId('file-container').length).toBeGreaterThan(0);
  });

  it('does not collapse a single downloadable text preview with a non-downloadable placeholder', () => {
    const attachments = [
      textAttachment({
        file_id: 'placeholder',
        filename: 'placeholder.zip',
        filepath: '',
        text: undefined,
      }),
      textAttachment({
        file_id: 'json',
        filename: 'output.json',
        filepath: '/files/output.json',
        text: '{"ok":true}',
      }),
    ] as TAttachment[];

    const { container } = render(<AttachmentGroup attachments={attachments} />);

    expect(screen.queryByRole('button', { name: 'com_ui_show_n_files' })).not.toBeInTheDocument();
    expect(container.querySelector('pre')?.textContent).toBe('{"ok":true}');
    expect(screen.getByTestId('file-container')).toHaveTextContent('output.json');
  });

  it('keeps long grouped text previews clamped until the nested preview is expanded', () => {
    setScrollHeight(800);
    const longJson = Array.from({ length: 1000 }, (_, index) => `{"line":${index}}`).join('\n');
    const attachments = [
      textAttachment({
        file_id: 'archive',
        filename: 'archive.zip',
        text: undefined,
      }),
      textAttachment({
        file_id: 'json',
        filename: 'output.json',
        filepath: '/files/output.json',
        text: longJson,
      }),
    ] as TAttachment[];

    const { container } = render(<AttachmentGroup attachments={attachments} />);
    const groupToggle = screen.getByRole('button', { name: 'com_ui_show_n_files' });
    fireEvent.click(groupToggle);

    expect(screen.getByText('output.json')).toBeInTheDocument();
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre).toHaveStyle({ maxHeight: '320px' });
    const previewToggle = screen.getByRole('button', { name: 'Show all' });
    expect(previewToggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(previewToggle);
    expect(screen.getByRole('button', { name: 'Collapse' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});

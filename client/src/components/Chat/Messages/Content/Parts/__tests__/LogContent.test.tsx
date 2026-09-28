import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen } from '@testing-library/react';
import type { TAttachment } from 'librechat-data-provider';
import type { MutableSnapshot } from 'recoil';
import LogContent from '../LogContent';
import store from '~/store';

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string): string =>
      key,
}));

jest.mock('../LogLink', () => ({
  __esModule: true,
  default: ({
    href,
    filename,
    children,
  }: {
    href: string;
    filename: string;
    children?: React.ReactNode;
  }) => (
    <a data-testid="log-link" href={href} data-filename={filename}>
      {children}
    </a>
  ),
  useAttachmentLink: () => ({ handleDownload: jest.fn() }),
}));

jest.mock('~/components/Chat/Input/Files/FilePreview', () => ({
  __esModule: true,
  default: () => <div data-testid="file-preview" />,
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

jest.mock('~/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
  getFileType: () => ({ paths: [], color: '', title: 'Artifact' }),
  logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  isArtifactRoute: () => false,
}));

const baseAttachment = (overrides: Partial<TAttachment> = {}): TAttachment =>
  ({
    file_id: 'file-1',
    filename: 'unset',
    filepath: '/files/file-1',
    type: 'application/octet-stream',
    ...overrides,
  }) as TAttachment;

/**
 * Default `streaming: true` so `ToolArtifactCard`'s mount-time
 * auto-focus (gated on `isSubmittingFamily(0)`) fires for these tests.
 * The legacy SSE-arrival flow is what every "panel routing" assertion
 * implicitly assumes.
 */
const renderWith = (ui: React.ReactElement, opts: { streaming?: boolean } = {}) => {
  const streaming = opts.streaming ?? true;
  const initializeState = (snapshot: MutableSnapshot) => {
    snapshot.set(store.isSubmittingFamily(0), streaming);
  };
  return render(<RecoilRoot initializeState={initializeState}>{ui}</RecoilRoot>);
};

describe('LogContent attachment routing', () => {
  it('routes HTML attachments through ToolArtifactCard (panel)', () => {
    const html = baseAttachment({
      file_id: 'a',
      filename: 'index.html',
      text: '<h1>hi</h1>',
    } as Partial<TAttachment>);
    renderWith(<LogContent output="" attachments={[html]} />);
    // The artifact row carries an aria-expanded state; auto-focused on mount.
    expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument();
    expect(screen.getByText('index.html')).toBeInTheDocument();
  });

  it('routes mermaid attachments through the standalone Mermaid component', () => {
    const mmd = baseAttachment({
      file_id: 'b',
      filename: 'flow.mmd',
      text: 'graph TD\nA-->B',
    } as Partial<TAttachment>);
    renderWith(<LogContent output="" attachments={[mmd]} />);
    expect(screen.getByTestId('mermaid-render')).toHaveTextContent('graph TD');
    // Panel card not rendered for mermaid
    expect(screen.queryByRole('button', { expanded: true })).not.toBeInTheDocument();
  });

  it('routes text-bearing JSON through inline <pre>, not the panel', () => {
    /* CSV used to fall through here, but now routes to the SPREADSHEET
     * preview bucket. JSON has no dedicated viewer yet, so it remains
     * the canonical "unrouted text" example. */
    const json = baseAttachment({
      file_id: 'c',
      filename: 'data.json',
      text: '{"a":1,"b":2}',
    });
    const { container } = renderWith(<LogContent output="" attachments={[json]} />);
    expect(container.querySelector('pre')).not.toBeNull();
    expect(screen.queryByRole('button', { expanded: true })).not.toBeInTheDocument();
    expect(screen.queryByTestId('mermaid-render')).not.toBeInTheDocument();
  });

  it('routes files without text or panel-eligibility to the LogLink download', () => {
    const zip = baseAttachment({
      file_id: 'd',
      filename: 'archive.zip',
    });
    renderWith(<LogContent output="" attachments={[zip]} />);
    expect(screen.getByTestId('log-link')).toHaveAttribute('data-filename', 'archive.zip');
  });

  it('renders a panel card for a pptx with backend-rendered HTML in text', () => {
    /* PPTX (and DOCX/XLSX/CSV) now route through the office preview
     * bucket with a strict empty-text gate — the artifact only registers
     * once the backend's `bufferToOfficeHtml` has produced the slide-list
     * HTML and shipped it via `attachment.text`. */
    const pptx = baseAttachment({
      file_id: 'e',
      filename: 'slides.pptx',
      text: '<!DOCTYPE html><body><ol><li>Slide 1</li></ol></body>',
    });
    renderWith(<LogContent output="" attachments={[pptx]} />);
    expect(screen.getByText('slides.pptx')).toBeInTheDocument();
  });

  it('falls back to the legacy download branch for an office file with no extracted text', () => {
    /* Empty `text` for an office type fails the strict gate, so the
     * artifact stays unregistered and the file flows to the download
     * fallback (LogLink), not a half-rendered panel card. */
    const pptx = baseAttachment({
      file_id: 'e2',
      filename: 'slides.pptx',
      text: undefined,
    });
    renderWith(<LogContent output="" attachments={[pptx]} />);
    expect(screen.queryByRole('button', { expanded: true })).not.toBeInTheDocument();
    expect(screen.getByTestId('log-link')).toHaveAttribute('data-filename', 'slides.pptx');
  });

  it('routes an expired panel-eligible attachment through the legacy expired path', () => {
    /* Without this gate, an expired pptx/html/etc. with extracted HTML
     * would render as a clickable artifact card backed by a dead
     * download link. The legacy "download expired" message must win for
     * any panel-eligible entry whose `expiresAt` is in the past — even
     * when the office HTML is present. */
    const expired = baseAttachment({
      file_id: 'x-expired',
      filename: 'slides.pptx',
      text: '<!DOCTYPE html><body><ol><li>Slide 1</li></ol></body>',
      expiresAt: Date.now() - 60_000,
    });
    renderWith(<LogContent output="" attachments={[expired]} />);
    // No panel card and no log-link (the expired branch returns plain text).
    expect(screen.queryByRole('button', { expanded: true })).not.toBeInTheDocument();
    expect(screen.queryByTestId('log-link')).not.toBeInTheDocument();
    // The localize mock returns the key, so we assert the expired-message key
    // appears in the rendered output alongside the filename.
    expect(screen.getByText(/slides\.pptx com_download_expired/)).toBeInTheDocument();
  });

  it('still routes a non-expired panel attachment through the panel', () => {
    const fresh = baseAttachment({
      file_id: 'x-fresh',
      filename: 'index.html',
      text: '<h1>hi</h1>',
      expiresAt: Date.now() + 60_000,
    } as Partial<TAttachment>);
    renderWith(<LogContent output="" attachments={[fresh]} />);
    expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument();
  });

  it('splits a mixed list into the right buckets', () => {
    const attachments = [
      baseAttachment({
        file_id: 'h',
        filename: 'index.html',
        text: '<h1>hi</h1>',
      } as Partial<TAttachment>),
      baseAttachment({
        file_id: 'm',
        filename: 'flow.mmd',
        text: 'graph TD\nA-->B',
      } as Partial<TAttachment>),
      baseAttachment({
        file_id: 't',
        /* JSON stays on the inline `<pre>` rendering path. CSV used to
         * live here too but now routes to the SPREADSHEET preview
         * bucket, so it would no longer satisfy the "inline pre" check
         * below. */
        filename: 'notes.json',
        text: '{"a":1,"b":2}',
      } as Partial<TAttachment>),
    ] as TAttachment[];
    const { container } = renderWith(
      <LogContent output="" attachments={attachments} renderImages={true} />,
    );
    // panel artifact card present (find the html title)
    expect(screen.getByText('index.html')).toBeInTheDocument();
    // mermaid render present
    expect(screen.getByTestId('mermaid-render')).toBeInTheDocument();
    // JSON inline pre present
    expect(container.querySelector('pre')).not.toBeNull();
  });
});

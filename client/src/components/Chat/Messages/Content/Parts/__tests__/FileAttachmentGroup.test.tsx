import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen, fireEvent } from '@testing-library/react';
import type { TAttachment } from 'librechat-data-provider';
import { AttachmentGroup } from '../Attachment';

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string): string =>
      key,
  useAttachmentPreviewSync: () => ({ status: 'ready', previewError: undefined, isPolling: false }),
  useExpandCollapse: (isExpanded: boolean) => ({
    style: { display: 'grid', gridTemplateRows: isExpanded ? '1fr' : '0fr' },
    ref: { current: null },
  }),
}));

jest.mock('../LogLink', () => ({
  useAttachmentLink: () => ({ handleDownload: jest.fn() }),
}));

jest.mock('~/components/Chat/Input/Files/FileContainer', () => ({
  __esModule: true,
  default: ({ file, displayName }: { file: { filename?: string }; displayName?: string }) => (
    <div data-testid="file-container">{displayName ?? file.filename ?? ''}</div>
  ),
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

const renderWith = (ui: React.ReactElement) => render(<RecoilRoot>{ui}</RecoilRoot>);

describe('FileAttachmentGroup identity dedup (B12)', () => {
  it('collapses two attachments sharing a file identity into a single, non-folded chip', () => {
    const first = baseAttachment({ file_id: 'dup', filename: 'report.pptx', bytes: 100 });
    const second = baseAttachment({ file_id: 'dup', filename: 'report.pptx', bytes: 100 });
    const { container } = renderWith(<AttachmentGroup attachments={[first, second]} />);

    // A folded row only appears once the unique count exceeds one — dedup
    // must run before the count that decides whether to render it.
    expect(screen.queryByRole('button', { name: 'com_ui_show_n_files' })).not.toBeInTheDocument();
    const chips = container.querySelectorAll('[data-testid="file-container"]');
    expect(chips.length).toBe(1);
    expect(chips[0].textContent).toBe('report.pptx');
  });

  it('folds distinct identities only, using the last occurrence for a repeated identity', () => {
    const older = baseAttachment({ file_id: 'dup', filename: 'old-name.zip', bytes: 100 });
    const distinct = baseAttachment({ file_id: 'other', filename: 'notes.zip', bytes: 50 });
    const newer = baseAttachment({ file_id: 'dup', filename: 'new-name.zip', bytes: 100 });

    const { container } = renderWith(<AttachmentGroup attachments={[older, distinct, newer]} />);

    const toggle = screen.getByRole('button', { name: 'com_ui_show_n_files' });
    fireEvent.click(toggle);
    const chips = Array.from(container.querySelectorAll('[data-testid="file-container"]'));
    const names = chips.map((chip) => chip.textContent);
    expect(chips.length).toBe(2);
    expect(names).toContain('new-name.zip');
    expect(names).not.toContain('old-name.zip');
  });
});

import React from 'react';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { render, screen } from '@testing-library/react';
import type { TAttachment } from 'librechat-data-provider';
import { AttachmentGroup } from '../Attachment';
import { MessageContext } from '~/Providers';
import store from '~/store';

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
  default: ({
    children,
    artifact,
  }: {
    children: string;
    artifact?: { id: string; title?: string; type?: string };
  }) => (
    <div
      data-testid="mermaid-render"
      data-artifact-id={artifact?.id}
      data-artifact-title={artifact?.title}
      data-artifact-type={artifact?.type}
    >
      {children}
    </div>
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

/** Minimal message context; `isExpanded` is required by the type but unused here. */
const messageScope = (messageId: string) => ({ messageId, isExpanded: false });

const ArtifactContentProbe = ({
  artifactId,
  onSnapshot,
}: {
  artifactId: string;
  onSnapshot: (content: string | null) => void;
}) => {
  const artifacts = useRecoilValue(store.artifactsState);
  React.useEffect(() => {
    onSnapshot(artifacts?.[artifactId]?.content ?? null);
  });
  return null;
};

describe('ToolArtifactCard message-scoped dedup and newest-version selection', () => {
  it('shows a card on every message that holds the same file identity (FR-06)', () => {
    const html = () =>
      baseAttachment({ file_id: 'shared-file', filename: 'index.html', text: '<h1>hi</h1>' });
    const { container } = render(
      <RecoilRoot>
        <MessageContext.Provider value={messageScope('m1')}>
          <AttachmentGroup attachments={[html()]} />
        </MessageContext.Provider>
        <MessageContext.Provider value={messageScope('m2')}>
          <AttachmentGroup attachments={[html()]} />
        </MessageContext.Provider>
      </RecoilRoot>,
    );
    expect(container.querySelectorAll('[data-artifact-trigger]')).toHaveLength(2);
    expect(screen.getAllByText('index.html')).toHaveLength(2);
  });

  it('collapses two cards for the same file within one message to one card (FR-07)', () => {
    const dup = baseAttachment({
      file_id: 'dup-in-message',
      filename: 'index.html',
      text: '<h1>v1</h1>',
    });
    const { container } = render(
      <RecoilRoot>
        <MessageContext.Provider value={messageScope('m1')}>
          <AttachmentGroup attachments={[dup]} />
          <AttachmentGroup attachments={[dup]} />
        </MessageContext.Provider>
      </RecoilRoot>,
    );
    expect(container.querySelectorAll('[data-artifact-trigger]')).toHaveLength(1);
  });

  it('keeps the panel on the newest version even when the older card mounts after the newer one (FR-08)', () => {
    const newer = baseAttachment({
      file_id: 'versioned',
      filename: 'report.html',
      text: '<h1>v2 (newer)</h1>',
      updatedAt: '2024-01-02T00:00:00.000Z',
    });
    const older = baseAttachment({
      file_id: 'versioned',
      filename: 'report.html',
      text: '<h1>v1 (older)</h1>',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    let content: string | null = null;
    render(
      <RecoilRoot>
        <ArtifactContentProbe
          artifactId="tool-artifact-versioned"
          onSnapshot={(snapshot) => {
            content = snapshot;
          }}
        />
        <MessageContext.Provider value={messageScope('m1')}>
          <AttachmentGroup attachments={[newer]} />
        </MessageContext.Provider>
        <MessageContext.Provider value={messageScope('m2')}>
          <AttachmentGroup attachments={[older]} />
        </MessageContext.Provider>
      </RecoilRoot>,
    );
    expect(content).toBe('<h1>v2 (newer)</h1>');
  });

  it('keeps the newer content after the newer card unmounts and the older card mounts fresh (FR-08)', () => {
    const newer = baseAttachment({
      file_id: 'remount',
      filename: 'notes.html',
      text: '<h1>v2 (newer)</h1>',
      updatedAt: '2024-01-02T00:00:00.000Z',
    });
    const older = baseAttachment({
      file_id: 'remount',
      filename: 'notes.html',
      text: '<h1>v1 (older)</h1>',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    let content: string | null = null;
    const onSnapshot = (snapshot: string | null) => {
      content = snapshot;
    };
    const { rerender } = render(
      <RecoilRoot>
        <ArtifactContentProbe artifactId="tool-artifact-remount" onSnapshot={onSnapshot} />
        <MessageContext.Provider value={messageScope('m1')}>
          <AttachmentGroup attachments={[newer]} />
        </MessageContext.Provider>
      </RecoilRoot>,
    );
    expect(content).toBe('<h1>v2 (newer)</h1>');

    rerender(
      <RecoilRoot>
        <ArtifactContentProbe artifactId="tool-artifact-remount" onSnapshot={onSnapshot} />
        <MessageContext.Provider value={messageScope('m2')}>
          <AttachmentGroup attachments={[older]} />
        </MessageContext.Provider>
      </RecoilRoot>,
    );
    expect(content).toBe('<h1>v2 (newer)</h1>');
  });
});

describe('ToolMermaidArtifact message-scoped dedup (FR-09)', () => {
  it('shows a diagram card on every message that holds the same file identity', () => {
    const mmd = () =>
      baseAttachment({ file_id: 'diagram', filename: 'flow.mmd', text: 'graph TD\nA-->B' });
    render(
      <RecoilRoot>
        <MessageContext.Provider value={messageScope('m1')}>
          <AttachmentGroup attachments={[mmd()]} />
        </MessageContext.Provider>
        <MessageContext.Provider value={messageScope('m2')}>
          <AttachmentGroup attachments={[mmd()]} />
        </MessageContext.Provider>
      </RecoilRoot>,
    );
    expect(screen.getAllByTestId('mermaid-render')).toHaveLength(2);
  });

  it('collapses two diagram cards for the same file within one message to one', () => {
    const mmd = baseAttachment({
      file_id: 'diagram-dup',
      filename: 'flow.mmd',
      text: 'graph TD\nA-->B',
    });
    render(
      <RecoilRoot>
        <MessageContext.Provider value={messageScope('m1')}>
          <AttachmentGroup attachments={[mmd]} />
          <AttachmentGroup attachments={[mmd]} />
        </MessageContext.Provider>
      </RecoilRoot>,
    );
    expect(screen.getAllByTestId('mermaid-render')).toHaveLength(1);
  });
});

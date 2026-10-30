import React from 'react';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { ContentTypes, Tools } from 'librechat-data-provider';
import { render, screen, fireEvent } from '@testing-library/react';
import type { TAttachment, TMessage, TMessageContentParts } from 'librechat-data-provider';
import type { Artifact } from '~/common';
import SearchContent from '~/components/Chat/Messages/Content/SearchContent';
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
    artifact?: { id: string; title?: string; type?: string; content?: string };
  }) => (
    <div
      data-testid="mermaid-render"
      data-artifact-id={artifact?.id}
      data-artifact-title={artifact?.title}
      data-artifact-type={artifact?.type}
      data-artifact-content={artifact?.content}
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
  // `SearchContent` (rendered by the search-result tests below) maps attachments to
  // their owning tool call with the real implementation.
  mapAttachments: jest.requireActual('~/utils/map').mapAttachments,
}));

/**
 * `SearchContent` routes an `execute_code` tool call through the real
 * `Part` -> `Parts` barrel -> `ExecuteCode`, whose unconditional
 * `PtcToolTrace` child needs MCP query hooks (and thus a `QueryClient`)
 * this suite doesn't set up. Only that one card is replaced with the
 * same `AttachmentGroup` it renders for real — the file-identity
 * routing under test (`SearchContent` -> `MessageContext` ->
 * `AttachmentGroup` -> `ToolArtifactCard`) stays real.
 */
jest.mock('..', () => {
  const actual = jest.requireActual('..');
  return {
    __esModule: true,
    ...actual,
    ExecuteCode: ({ attachments }: { attachments?: TAttachment[] }) => (
      <actual.AttachmentGroup attachments={attachments} />
    ),
  };
});

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
  it('shows a card on every message that holds the same file identity', () => {
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

  it('collapses two cards for the same file within one message to one card', () => {
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

  it('keeps the panel on the newest version even when the older card mounts after the newer one', () => {
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

  it('keeps the newer content after the newer card unmounts and the older card mounts fresh', () => {
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

describe('ToolArtifactCard file identity for id-less attachments', () => {
  it('renders two card triggers for two id-less files sharing a filename but differing by filepath, each opening its own content', () => {
    const first = baseAttachment({
      file_id: undefined,
      filename: 'index.html',
      filepath: '/uploads/session-a/index.html',
      text: '<h1>A</h1>',
    });
    const second = baseAttachment({
      file_id: undefined,
      filename: 'index.html',
      filepath: '/uploads/session-b/index.html',
      text: '<h1>B</h1>',
    });

    let snapshot: Record<string, Artifact | undefined> = {};
    const ArtifactsSnapshotProbe = () => {
      const artifacts = useRecoilValue(store.artifactsState);
      React.useEffect(() => {
        snapshot = artifacts ?? {};
      });
      return null;
    };
    let currentId: string | null = null;
    const CurrentArtifactProbe = () => {
      const id = useRecoilValue(store.currentArtifactId);
      React.useEffect(() => {
        currentId = id;
      });
      return null;
    };

    const { container } = render(
      <RecoilRoot>
        <ArtifactsSnapshotProbe />
        <CurrentArtifactProbe />
        <MessageContext.Provider value={messageScope('m1')}>
          <AttachmentGroup attachments={[first, second]} />
        </MessageContext.Provider>
      </RecoilRoot>,
    );

    const triggers = container.querySelectorAll('[data-artifact-trigger]');
    expect(triggers).toHaveLength(2);

    const firstId = 'tool-artifact-/uploads/session-a/index.html';
    const secondId = 'tool-artifact-/uploads/session-b/index.html';
    const triggerIds = Array.from(triggers).map((el) => el.getAttribute('data-artifact-trigger'));
    expect([...triggerIds].sort()).toEqual([firstId, secondId].sort());

    // Both files' own content registers, keyed by their own identity —
    // a colliding key would have one file's mount overwrite the other's.
    expect(snapshot[firstId]?.content).toBe('<h1>A</h1>');
    expect(snapshot[secondId]?.content).toBe('<h1>B</h1>');

    const firstTrigger = container.querySelector(`[data-artifact-trigger="${firstId}"]`);
    const secondTrigger = container.querySelector(`[data-artifact-trigger="${secondId}"]`);
    expect(firstTrigger).not.toBeNull();
    expect(secondTrigger).not.toBeNull();

    fireEvent.click(firstTrigger as HTMLElement);
    expect(currentId).toBe(firstId);

    fireEvent.click(secondTrigger as HTMLElement);
    expect(currentId).toBe(secondId);
  });
});

describe('ToolMermaidArtifact message-scoped dedup', () => {
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

describe('ToolMermaidArtifact newest-version selection', () => {
  const mermaidCards = () => screen.getAllByTestId('mermaid-render');

  const ArtifactKeysProbe = ({ onSnapshot }: { onSnapshot: (keys: string[]) => void }) => {
    const artifacts = useRecoilValue(store.artifactsState);
    React.useEffect(() => {
      onSnapshot(Object.keys(artifacts ?? {}));
    });
    return null;
  };

  it('offers the older message card the newer content when the newer message mounts after it', () => {
    const older = baseAttachment({
      file_id: 'diagram-mount-order-a',
      filename: 'flow.mmd',
      text: 'graph TD\nA-->B',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    const newer = baseAttachment({
      file_id: 'diagram-mount-order-a',
      filename: 'flow.mmd',
      text: 'graph TD\nA-->C',
      updatedAt: '2024-01-02T00:00:00.000Z',
    });
    let artifactKeys: string[] = [];
    render(
      <RecoilRoot>
        <ArtifactKeysProbe onSnapshot={(keys) => (artifactKeys = keys)} />
        <MessageContext.Provider value={messageScope('m1')}>
          <AttachmentGroup attachments={[older]} />
        </MessageContext.Provider>
        <MessageContext.Provider value={messageScope('m2')}>
          <AttachmentGroup attachments={[newer]} />
        </MessageContext.Provider>
      </RecoilRoot>,
    );
    const cards = mermaidCards();
    expect(cards).toHaveLength(2);
    // Opening EITHER card — including the older message's — would register
    // the newest version.
    cards.forEach((card) => {
      expect(card).toHaveAttribute('data-artifact-content', 'graph TD\nA-->C');
    });
    // Each inline diagram still renders its own message's source.
    expect(cards[0].textContent).toBe('graph TD\nA-->B');
    expect(cards[1].textContent).toBe('graph TD\nA-->C');
    // Mounting alone never writes into artifactsState (navigator unaffected).
    expect(artifactKeys).toHaveLength(0);
  });

  it('keeps the newest content when the newer message mounts before the older one', () => {
    const newer = baseAttachment({
      file_id: 'diagram-mount-order-b',
      filename: 'flow.mmd',
      text: 'graph TD\nA-->C',
      updatedAt: '2024-01-02T00:00:00.000Z',
    });
    const older = baseAttachment({
      file_id: 'diagram-mount-order-b',
      filename: 'flow.mmd',
      text: 'graph TD\nA-->B',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    render(
      <RecoilRoot>
        <MessageContext.Provider value={messageScope('m1')}>
          <AttachmentGroup attachments={[newer]} />
        </MessageContext.Provider>
        <MessageContext.Provider value={messageScope('m2')}>
          <AttachmentGroup attachments={[older]} />
        </MessageContext.Provider>
      </RecoilRoot>,
    );
    const cards = mermaidCards();
    expect(cards).toHaveLength(2);
    cards.forEach((card) => {
      expect(card).toHaveAttribute('data-artifact-content', 'graph TD\nA-->C');
    });
    expect(cards[0].textContent).toBe('graph TD\nA-->C');
    expect(cards[1].textContent).toBe('graph TD\nA-->B');
  });

  it('keeps the newer content after the newer card unmounts and the older card mounts fresh', () => {
    const fileId = 'diagram-remount';
    const newer = baseAttachment({
      file_id: fileId,
      filename: 'flow.mmd',
      text: 'graph TD\nA-->C',
      updatedAt: '2024-01-02T00:00:00.000Z',
    });
    const older = baseAttachment({
      file_id: fileId,
      filename: 'flow.mmd',
      text: 'graph TD\nA-->B',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    const { unmount } = render(
      <RecoilRoot>
        <MessageContext.Provider value={messageScope('m1')}>
          <AttachmentGroup attachments={[newer]} />
        </MessageContext.Provider>
      </RecoilRoot>,
    );
    expect(screen.getByTestId('mermaid-render')).toHaveAttribute(
      'data-artifact-content',
      'graph TD\nA-->C',
    );
    unmount();

    render(
      <RecoilRoot>
        <MessageContext.Provider value={messageScope('m2')}>
          <AttachmentGroup attachments={[older]} />
        </MessageContext.Provider>
      </RecoilRoot>,
    );
    const reopened = screen.getByTestId('mermaid-render');
    expect(reopened).toHaveAttribute('data-artifact-content', 'graph TD\nA-->C');
    expect(reopened.textContent).toBe('graph TD\nA-->B');
  });

  it('settles on one version when two diagrams for the same file share lastUpdateTime (no ping-pong)', () => {
    const fileId = 'diagram-tie';
    const versionA = () =>
      baseAttachment({ file_id: fileId, filename: 'tie.mmd', text: 'graph TD\nA-->B' });
    const versionB = () =>
      baseAttachment({ file_id: fileId, filename: 'tie.mmd', text: 'graph TD\nA-->C' });

    const renderPair = () =>
      render(
        <RecoilRoot>
          <MessageContext.Provider value={messageScope('m1')}>
            <AttachmentGroup attachments={[versionA()]} />
          </MessageContext.Provider>
          <MessageContext.Provider value={messageScope('m2')}>
            <AttachmentGroup attachments={[versionB()]} />
          </MessageContext.Provider>
        </RecoilRoot>,
      );

    const { unmount } = renderPair();
    const firstCards = mermaidCards();
    const settled = firstCards[0].getAttribute('data-artifact-content');
    expect(settled).not.toBeNull();
    expect(['graph TD\nA-->B', 'graph TD\nA-->C']).toContain(settled);
    expect(firstCards[1]).toHaveAttribute('data-artifact-content', settled as string);
    unmount();

    renderPair();
    const secondCards = mermaidCards();
    expect(secondCards[0]).toHaveAttribute('data-artifact-content', settled as string);
    expect(secondCards[1]).toHaveAttribute('data-artifact-content', settled as string);
  });
});

describe('ToolArtifactCard tied writes settle once and do not ping-pong', () => {
  const tieId = 'tool-artifact-tie-file';
  const versionA = () =>
    baseAttachment({ file_id: 'tie-file', filename: 'tie.html', text: '<h1>version A</h1>' });
  const versionB = () =>
    baseAttachment({ file_id: 'tie-file', filename: 'tie.html', text: '<h1>version B</h1>' });

  /** Records each distinct object identity `artifactsState[tieId]` takes on,
   *  i.e. one entry per real write — not one per render. */
  const WriteHistoryProbe = ({ onWrite }: { onWrite: (content: string | null) => void }) => {
    const artifacts = useRecoilValue(store.artifactsState);
    const entry = artifacts?.[tieId];
    const lastSeen = React.useRef<typeof entry>(undefined);
    React.useEffect(() => {
      if (entry !== lastSeen.current) {
        lastSeen.current = entry;
        onWrite(entry?.content ?? null);
      }
    });
    return null;
  };

  it('settles on one version when the second card mounts after the first (sequential)', () => {
    const cardA = versionA();
    const cardB = versionB();
    const writes: (string | null)[] = [];
    const onWrite = (content: string | null) => writes.push(content);

    const { rerender } = render(
      <RecoilRoot>
        <WriteHistoryProbe onWrite={onWrite} />
        <MessageContext.Provider value={messageScope('m1')}>
          <AttachmentGroup attachments={[cardA]} />
        </MessageContext.Provider>
      </RecoilRoot>,
    );

    rerender(
      <RecoilRoot>
        <WriteHistoryProbe onWrite={onWrite} />
        <MessageContext.Provider value={messageScope('m1')}>
          <AttachmentGroup attachments={[cardA]} />
        </MessageContext.Provider>
        <MessageContext.Provider value={messageScope('m2')}>
          <AttachmentGroup attachments={[cardB]} />
        </MessageContext.Provider>
      </RecoilRoot>,
    );

    expect(writes.length).toBeLessThanOrEqual(2);
    const settled = writes[writes.length - 1];
    expect(['<h1>version A</h1>', '<h1>version B</h1>']).toContain(settled);

    // Flush again with an unchanged tree — must not drift or write again.
    rerender(
      <RecoilRoot>
        <WriteHistoryProbe onWrite={onWrite} />
        <MessageContext.Provider value={messageScope('m1')}>
          <AttachmentGroup attachments={[cardA]} />
        </MessageContext.Provider>
        <MessageContext.Provider value={messageScope('m2')}>
          <AttachmentGroup attachments={[cardB]} />
        </MessageContext.Provider>
      </RecoilRoot>,
    );
    expect(writes.length).toBeLessThanOrEqual(2);
    expect(writes[writes.length - 1]).toBe(settled);
  });

  it('settles on one version when both cards mount together', () => {
    const cardA = versionA();
    const cardB = versionB();
    const writes: (string | null)[] = [];
    const onWrite = (content: string | null) => writes.push(content);

    const { rerender } = render(
      <RecoilRoot>
        <WriteHistoryProbe onWrite={onWrite} />
        <MessageContext.Provider value={messageScope('m1')}>
          <AttachmentGroup attachments={[cardA]} />
        </MessageContext.Provider>
        <MessageContext.Provider value={messageScope('m2')}>
          <AttachmentGroup attachments={[cardB]} />
        </MessageContext.Provider>
      </RecoilRoot>,
    );

    expect(writes.length).toBeLessThanOrEqual(2);
    const settled = writes[writes.length - 1];
    expect(['<h1>version A</h1>', '<h1>version B</h1>']).toContain(settled);

    // Flush again with an unchanged tree — must not drift or write again.
    rerender(
      <RecoilRoot>
        <WriteHistoryProbe onWrite={onWrite} />
        <MessageContext.Provider value={messageScope('m1')}>
          <AttachmentGroup attachments={[cardA]} />
        </MessageContext.Provider>
        <MessageContext.Provider value={messageScope('m2')}>
          <AttachmentGroup attachments={[cardB]} />
        </MessageContext.Provider>
      </RecoilRoot>,
    );
    expect(writes.length).toBeLessThanOrEqual(2);
    expect(writes[writes.length - 1]).toBe(settled);
  });
});

describe('SearchContent places cards per message', () => {
  const searchMessage = (overrides: Partial<TMessage> = {}): TMessage =>
    ({ messageId: 'm', text: '', ...overrides }) as TMessage;

  const toolCallPart = (toolCallId: string): TMessageContentParts =>
    ({
      type: ContentTypes.TOOL_CALL,
      [ContentTypes.TOOL_CALL]: { id: toolCallId, name: Tools.execute_code, args: '{}' },
    }) as unknown as TMessageContentParts;

  it('shows a card under each search-result message that holds the same file identity', () => {
    const fileAttachment = (toolCallId: string) =>
      baseAttachment({
        file_id: 'search-shared-file',
        filename: 'result.html',
        text: '<h1>result</h1>',
        toolCallId,
      } as Partial<TAttachment>);

    const { container } = render(
      <RecoilRoot>
        <SearchContent
          message={searchMessage({ messageId: 'search-m1', content: [toolCallPart('call-1')] })}
          attachments={[fileAttachment('call-1')]}
        />
        <SearchContent
          message={searchMessage({ messageId: 'search-m2', content: [toolCallPart('call-2')] })}
          attachments={[fileAttachment('call-2')]}
        />
      </RecoilRoot>,
    );

    expect(container.querySelectorAll('[data-artifact-trigger]')).toHaveLength(2);
    expect(screen.getAllByText('result.html')).toHaveLength(2);
  });

  it('collapses two cards for the same file within one search-result message to one card', () => {
    const dup = baseAttachment({
      file_id: 'search-dup-file',
      filename: 'dup.html',
      text: '<h1>dup</h1>',
      toolCallId: 'call-dup',
    } as Partial<TAttachment>);

    const { container } = render(
      <RecoilRoot>
        <SearchContent
          message={searchMessage({ messageId: 'search-m3', content: [toolCallPart('call-dup')] })}
          attachments={[dup, dup]}
        />
      </RecoilRoot>,
    );

    expect(container.querySelectorAll('[data-artifact-trigger]')).toHaveLength(1);
  });
});

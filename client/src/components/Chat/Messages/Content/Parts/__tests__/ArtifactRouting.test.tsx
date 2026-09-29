import React from 'react';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { TAttachment } from 'librechat-data-provider';
import type { MutableSnapshot } from 'recoil';
import Attachment, { AttachmentGroup } from '../Attachment';
import store from '~/store';

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string): string =>
      key,
  /* `FileAttachment` calls this hook unconditionally to bridge the
   * deferred-preview lifecycle into the attachment cache. The
   * routing tests don't exercise the preview flow itself — stub it
   * to a no-op so it doesn't blow up jsdom rendering. */
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

/**
 * Seeds `isSubmittingFamily(0) = streaming` so `ToolArtifactCard`'s
 * mount-time focus effect (which is gated on streaming state) behaves
 * the way each test expects. Default `streaming: true` matches the
 * legacy SSE-arrival flow that the bulk of these tests exercise.
 */
const renderWith = (ui: React.ReactElement, opts: { streaming?: boolean } = {}) => {
  const streaming = opts.streaming ?? true;
  const initializeState = (snapshot: MutableSnapshot) => {
    snapshot.set(store.isSubmittingFamily(0), streaming);
  };
  return render(<RecoilRoot initializeState={initializeState}>{ui}</RecoilRoot>);
};

interface ArtifactsSnapshot {
  visibility: boolean;
  currentArtifactId: string | null;
  artifactIds: string[];
}

const StateProbe = ({ onSnapshot }: { onSnapshot: (snap: ArtifactsSnapshot) => void }) => {
  const visibility = useRecoilValue(store.artifactsVisibility);
  const currentArtifactId = useRecoilValue(store.currentArtifactId);
  const artifacts = useRecoilValue(store.artifactsState);
  React.useEffect(() => {
    onSnapshot({
      visibility,
      currentArtifactId,
      artifactIds: Object.keys(artifacts ?? {}),
    });
  });
  return null;
};

const renderWithProbe = (ui: React.ReactElement, opts: { streaming?: boolean } = {}) => {
  const streaming = opts.streaming ?? true;
  const initializeState = (snap: MutableSnapshot) => {
    snap.set(store.isSubmittingFamily(0), streaming);
  };
  let snapshot: ArtifactsSnapshot = {
    visibility: false,
    currentArtifactId: null,
    artifactIds: [],
  };
  const utils = render(
    <RecoilRoot initializeState={initializeState}>
      <StateProbe
        onSnapshot={(snap) => {
          snapshot = snap;
        }}
      />
      {ui}
    </RecoilRoot>,
  );
  return {
    ...utils,
    getSnapshot: () => snapshot,
  };
};

describe('Attachment routing for tool artifacts', () => {
  it('renders an HTML artifact card (panel artifact) and exposes a download control', () => {
    const html = baseAttachment({
      filename: 'index.html',
      text: '<h1>hi</h1>',
    } as Partial<TAttachment>);
    renderWith(<Attachment attachment={html} />);

    // Row shows the artifact title and names its format
    expect(screen.getByText('index.html')).toBeInTheDocument();
    expect(screen.getByText('com_ui_artifact_format_html')).toBeInTheDocument();
    // Open-panel button carries aria-expanded (auto-focused on mount per the
    // legacy auto-open behaviour).
    expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument();
    // Download button has the download aria-label
    expect(
      screen.getByRole('button', { name: /com_ui_download.*index\.html/i }),
    ).toBeInTheDocument();
  });

  it('renders a JSX artifact card', () => {
    const jsx = baseAttachment({
      filename: 'App.tsx',
      text: 'export default () => null;',
    } as Partial<TAttachment>);
    renderWith(<Attachment attachment={jsx} />);
    expect(screen.getByText('App.tsx')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /com_ui_download.*App\.tsx/i })).toBeInTheDocument();
  });

  it('renders a Markdown artifact card', () => {
    const md = baseAttachment({
      filename: 'notes.md',
      text: '# hi',
    } as Partial<TAttachment>);
    renderWith(<Attachment attachment={md} />);
    expect(screen.getByText('notes.md')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /com_ui_download.*notes\.md/i })).toBeInTheDocument();
  });

  it.each([
    ['readme.txt', 'Lorem ipsum'],
    ['report.docx', 'Extracted document text'],
    ['notes.odt', 'OpenDocument body text'],
    ['slides.pptx', 'Slide titles and bullets'],
  ])('renders a panel artifact card for %s (text/plain bucket)', (filename, text) => {
    const file = baseAttachment({
      filename,
      text,
    } as Partial<TAttachment>);
    renderWith(<Attachment attachment={file} />);
    expect(screen.getByText(filename)).toBeInTheDocument();
    const downloadPattern = new RegExp(`com_ui_download.*${filename.replace('.', '\\.')}`, 'i');
    expect(screen.getByRole('button', { name: downloadPattern })).toBeInTheDocument();
  });

  it('renders a Mermaid artifact through the standalone Mermaid component (not the panel)', () => {
    const mmd = baseAttachment({
      filename: 'flow.mmd',
      text: 'graph TD\nA-->B',
    } as Partial<TAttachment>);
    renderWith(<Attachment attachment={mmd} />);
    const renderer = screen.getByTestId('mermaid-render');
    expect(renderer).toHaveTextContent('graph TD');
    expect(renderer).toHaveAttribute('data-artifact-id', 'tool-artifact-file-1');
    expect(renderer).toHaveAttribute('data-artifact-title', 'flow.mmd');
    expect(renderer).toHaveAttribute('data-artifact-type', 'application/vnd.mermaid');
    // The card-style trigger should NOT be rendered for mermaid
    expect(screen.queryByText('com_ui_artifact_click')).not.toBeInTheDocument();
  });

  it('falls through to the inline <pre> for unsupported text types (JSON)', () => {
    /* CSV used to fall through here, but now routes to the SPREADSHEET
     * preview bucket. JSON is still inline-only (no dedicated viewer
     * yet); use it as the canonical "unrouted text" example. */
    const json = baseAttachment({
      filename: 'data.json',
      text: '{"a":1,"b":2}',
    });
    const { container } = renderWith(<Attachment attachment={json} />);
    expect(container.querySelector('pre')).not.toBeNull();
    expect(screen.queryByTestId('mermaid-render')).not.toBeInTheDocument();
  });

  it.each([
    ['data.csv', 'text/csv'],
    ['workbook.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ])('routes %s through the office preview panel (panel artifact)', (filename, type) => {
    const att = baseAttachment({
      file_id: `office-${filename}`,
      filename,
      type,
      text: '<!DOCTYPE html><body><table><tr><td>x</td></tr></table></body>',
    } as Partial<TAttachment>);
    renderWith(<Attachment attachment={att} />);
    expect(screen.getByText(filename)).toBeInTheDocument();
    /* Auto-expanded open button (streaming + non-CODE bucket) — same UX as
     * the HTML panel artifact above. */
    expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument();
    const downloadPattern = new RegExp(`com_ui_download.*${filename.replace('.', '\\.')}`, 'i');
    expect(screen.getByRole('button', { name: downloadPattern })).toBeInTheDocument();
  });
});

describe('ToolArtifactCard click behaviour', () => {
  const html = (): TAttachment =>
    baseAttachment({
      file_id: 'html-1',
      filename: 'index.html',
      text: '<h1>hi</h1>',
    } as Partial<TAttachment>);

  // Auto-open invariant: rendering a tool-artifact card must (a) register
  // the artifact in `artifactsState` and (b) focus it via
  // `currentArtifactId`. With `artifactsVisibility` defaulting to `true`,
  // this surfaces the latest tool artifact in the side panel — matching
  // the legacy streaming-artifact UX.
  it('registers and auto-focuses the artifact on mount', () => {
    const { getSnapshot } = renderWithProbe(<Attachment attachment={html()} />);
    const snap = getSnapshot();
    expect(snap.artifactIds).toContain('tool-artifact-html-1');
    expect(snap.currentArtifactId).toBe('tool-artifact-html-1');
  });

  it('toggles closed when the user clicks the (already-selected) card', () => {
    const { getSnapshot } = renderWithProbe(<Attachment attachment={html()} />);
    // Mount auto-focuses; the open button reads as expanded.
    const closeButton = screen.getByRole('button', { expanded: true });
    act(() => {
      fireEvent.click(closeButton);
    });
    const snap = getSnapshot();
    expect(snap.currentArtifactId).toBeNull();
    expect(snap.visibility).toBe(false);
    // Self-heal effect keeps the artifact registered so re-opening works.
    expect(snap.artifactIds).toContain('tool-artifact-html-1');
  });

  it('reopens after a close (regression: artifact still openable post-close)', () => {
    const { getSnapshot } = renderWithProbe(<Attachment attachment={html()} />);
    act(() => {
      fireEvent.click(screen.getByRole('button', { expanded: true }));
    });
    expect(getSnapshot().visibility).toBe(false);
    expect(getSnapshot().currentArtifactId).toBeNull();
    // Click the now-collapsed open button again.
    act(() => {
      fireEvent.click(screen.getByRole('button', { expanded: false }));
    });
    const snap = getSnapshot();
    expect(snap.currentArtifactId).toBe('tool-artifact-html-1');
    expect(snap.visibility).toBe(true);
    expect(snap.artifactIds).toContain('tool-artifact-html-1');
  });

  it('renders sibling cards with the same file_id in one group without React key collisions', () => {
    // Real-world: rare but possible (a single tool call writing the same
    // path twice). The dedup atom collapses duplicates to one rendered
    // chip, but React still has to reconcile both children pre-effect —
    // they need unique keys per occurrence so the wrong card-instance
    // doesn't get reused (and effects reordered) during reconciliation.
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const dup = baseAttachment({
        file_id: 'dup-same-group',
        filename: 'index.html',
        text: '<h1>v1</h1>',
      } as Partial<TAttachment>);
      const { container } = renderWith(<AttachmentGroup attachments={[dup, dup]} />);
      // Dedup atom keeps just one row visible.
      expect(container.querySelectorAll('[data-artifact-trigger]')).toHaveLength(1);
      // No "two children with the same key" warning fired.
      const keyWarning = errorSpy.mock.calls.find(
        (args) => typeof args[0] === 'string' && args[0].includes('same key'),
      );
      expect(keyWarning).toBeUndefined();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('does not ping-pong artifactsState when same file_id has divergent content across turns', () => {
    // Real production path: a code-execution file is overwritten across
    // turns (same file_id, new content). Both ToolArtifactCard
    // instances stay mounted; the older one renders null, but its
    // self-heal effect still ran. Without claim-gating, the older card
    // would observe the newer card's write through `existingEntry`,
    // detect drift, and overwrite it back — old → new → old → ... in a
    // loop. Gating registration on `isMyClaim` makes the write
    // single-writer per id; final state must reflect the newer card.
    interface ContentSnapshot {
      ids: string[];
      contentForDup: string | null;
    }
    let snapshot: ContentSnapshot = { ids: [], contentForDup: null };
    const ContentProbe = () => {
      const artifacts = useRecoilValue(store.artifactsState);
      React.useEffect(() => {
        const ids = Object.keys(artifacts ?? {});
        const dup = artifacts?.['tool-artifact-dup-divergent'];
        snapshot = { ids, contentForDup: dup?.content ?? null };
      });
      return null;
    };
    const older = baseAttachment({
      file_id: 'dup-divergent',
      filename: 'output.html',
      text: '<h1>v1 (older)</h1>',
    } as Partial<TAttachment>);
    const newer = baseAttachment({
      file_id: 'dup-divergent',
      filename: 'output.html',
      text: '<h1>v2 (newer)</h1>',
    } as Partial<TAttachment>);
    render(
      <RecoilRoot>
        <ContentProbe />
        <AttachmentGroup attachments={[older]} />
        <AttachmentGroup attachments={[newer]} />
      </RecoilRoot>,
    );
    expect(snapshot.ids).toContain('tool-artifact-dup-divergent');
    // Newer (claim-winner) content must win and stay won.
    expect(snapshot.contentForDup).toBe('<h1>v2 (newer)</h1>');
  });

  it('dedups cards for the same file_id across separate AttachmentGroups (latest mount wins)', () => {
    // Real scenario: each tool call renders its own AttachmentGroup; the
    // same file (same file_id) shows up in two of them. We expect only
    // ONE card chip in total — the dedup atom collapses them.
    const dup = baseAttachment({
      file_id: 'dup',
      filename: 'index.html',
      text: '<h1>v1</h1>',
    } as Partial<TAttachment>);
    const { container } = renderWith(
      <>
        <AttachmentGroup attachments={[dup]} />
        <AttachmentGroup attachments={[dup]} />
      </>,
    );
    expect(container.querySelectorAll('[data-artifact-trigger]')).toHaveLength(1);
  });

  it('dedups two mermaid cards for the same file_id across groups (latest mount wins)', () => {
    const dupMermaid = baseAttachment({
      file_id: 'mmd-dup',
      filename: 'flow.mmd',
      text: 'graph TD\nA-->B',
    } as Partial<TAttachment>);
    renderWith(
      <>
        <AttachmentGroup attachments={[dupMermaid]} />
        <AttachmentGroup attachments={[dupMermaid]} />
      </>,
    );
    expect(screen.getAllByTestId('mermaid-render')).toHaveLength(1);
  });

  it('focuses the latest card when multiple artifacts mount (legacy parity)', () => {
    // Order: older first, newer last. Last-mounted should win currentArtifactId.
    const olderHtml = baseAttachment({
      file_id: 'older',
      filename: 'old.html',
      text: '<p>1</p>',
    } as Partial<TAttachment>);
    const newerHtml = baseAttachment({
      file_id: 'newer',
      filename: 'new.html',
      text: '<p>2</p>',
    } as Partial<TAttachment>);
    const { getSnapshot } = renderWithProbe(
      <AttachmentGroup attachments={[olderHtml, newerHtml]} />,
    );
    expect(getSnapshot().currentArtifactId).toBe('tool-artifact-newer');
    expect(getSnapshot().artifactIds).toEqual(
      expect.arrayContaining(['tool-artifact-older', 'tool-artifact-newer']),
    );
  });

  it('does NOT auto-focus when the card mounts outside an active stream (history load)', () => {
    // Reproduces "navigating to a previous conversation". Cards mount
    // for already-completed turns; `isSubmitting` is false. The legacy
    // behavior would auto-focus the latest artifact and re-open the
    // panel — we don't want that.
    const html = baseAttachment({
      file_id: 'history-html',
      filename: 'previous.html',
      text: '<h1>prev</h1>',
    } as Partial<TAttachment>);
    const { getSnapshot } = renderWithProbe(<Attachment attachment={html} />, {
      streaming: false,
    });
    const snap = getSnapshot();
    // Artifact still gets registered (so the panel can find it on click)…
    expect(snap.artifactIds).toContain('tool-artifact-history-html');
    // …but currentArtifactId stays null, which means
    // `Presentation`'s render gate (`currentArtifactId != null`) keeps
    // the panel closed.
    expect(snap.currentArtifactId).toBeNull();
  });

  it('does NOT auto-open a streaming CODE artifact (test.py is click-to-open)', () => {
    // Source-code artifacts are excluded from streaming auto-open even
    // when isSubmitting=true. The agent often emits supporting `.py` /
    // `.js` / `Dockerfile` / etc. helpers alongside a richer
    // deliverable; the panel shouldn't hijack the viewport every time
    // a script gets written. Click is the only path that surfaces a
    // CODE artifact in the panel.
    const py = baseAttachment({
      file_id: 'helper-script',
      filename: 'test.py',
      text: 'print("hello")',
    } as Partial<TAttachment>);
    const initializeState = (snap: MutableSnapshot) => {
      snap.set(store.isSubmittingFamily(0), true);
    };
    let snapshot: ArtifactsSnapshot = {
      visibility: false,
      currentArtifactId: null,
      artifactIds: [],
    };
    render(
      <RecoilRoot initializeState={initializeState}>
        <StateProbe
          onSnapshot={(snap) => {
            snapshot = snap;
          }}
        />
        <Attachment attachment={py} />
      </RecoilRoot>,
    );
    // Artifact registered (so the panel can find it on click)…
    expect(snapshot.artifactIds).toContain('tool-artifact-helper-script');
    // …but currentArtifactId stays null and visibility is untouched.
    expect(snapshot.currentArtifactId).toBeNull();
  });

  it('forces panel visibility on streaming mount even if visibility was previously false', () => {
    // Repro: user closed the panel earlier in the session
    // (`artifactsVisibility = false`), then a new tool artifact
    // arrives via SSE. The old behavior set `currentArtifactId` but
    // left visibility alone, so the chip showed "click to close" while
    // the panel stayed hidden. Streaming arrivals must re-open the
    // panel — that's the explicit "auto-open when first created" rule.
    const html = baseAttachment({
      file_id: 'fresh-stream',
      filename: 'fresh.html',
      text: '<h1>fresh</h1>',
    } as Partial<TAttachment>);
    const initializeState = (snap: MutableSnapshot) => {
      snap.set(store.isSubmittingFamily(0), true);
      snap.set(store.artifactsVisibility, false);
    };
    let snapshot: ArtifactsSnapshot = {
      visibility: false,
      currentArtifactId: null,
      artifactIds: [],
    };
    render(
      <RecoilRoot initializeState={initializeState}>
        <StateProbe
          onSnapshot={(snap) => {
            snapshot = snap;
          }}
        />
        <Attachment attachment={html} />
      </RecoilRoot>,
    );
    expect(snapshot.visibility).toBe(true);
    expect(snapshot.currentArtifactId).toBe('tool-artifact-fresh-stream');
  });

  it('does NOT force visibility on history mount (closed panel stays closed)', () => {
    // The flip-side of the prior test: a card mounted from history
    // (isSubmitting=false) must not toggle visibility, so a user who
    // explicitly closed the panel keeps it closed when revisiting.
    const html = baseAttachment({
      file_id: 'history-no-vis',
      filename: 'historic.html',
      text: '<h1>old</h1>',
    } as Partial<TAttachment>);
    const initializeState = (snap: MutableSnapshot) => {
      snap.set(store.isSubmittingFamily(0), false);
      snap.set(store.artifactsVisibility, false);
    };
    let snapshot: ArtifactsSnapshot = {
      visibility: false,
      currentArtifactId: null,
      artifactIds: [],
    };
    render(
      <RecoilRoot initializeState={initializeState}>
        <StateProbe
          onSnapshot={(snap) => {
            snapshot = snap;
          }}
        />
        <Attachment attachment={html} />
      </RecoilRoot>,
    );
    expect(snapshot.visibility).toBe(false);
    expect(snapshot.currentArtifactId).toBeNull();
  });

  it('auto-opens a non-streaming card when the deferred preview just resolved', () => {
    /* Regression for the deferred-preview UX gap: when an office file's
     * background HTML extraction lands AFTER the SSE stream has closed
     * (`isSubmitting=false`), the freshly resolved chip would render in
     * place but never auto-open the panel — the legacy auto-open path
     * is gated only on streaming. `useAttachmentPreviewSync` flips the
     * `previewJustResolved(file_id)` flag on the pending→ready edge to
     * bridge that gap; `ToolArtifactCard` consumes it on mount and
     * auto-opens regardless of submission state. The flag is one-shot:
     * a subsequent re-mount (panel close/reopen, history scroll) must
     * NOT fire again — covered by the next test. */
    const xlsx = baseAttachment({
      file_id: 'just-resolved-xlsx',
      filename: 'data.xlsx',
      text: '<table>resolved</table>',
      textFormat: 'html',
    });
    const initializeState = (snap: MutableSnapshot) => {
      snap.set(store.isSubmittingFamily(0), false);
      snap.set(store.artifactsVisibility, false);
      snap.set(store.previewJustResolved('just-resolved-xlsx'), true);
    };
    let snapshot: ArtifactsSnapshot = {
      visibility: false,
      currentArtifactId: null,
      artifactIds: [],
    };
    render(
      <RecoilRoot initializeState={initializeState}>
        <StateProbe
          onSnapshot={(snap) => {
            snapshot = snap;
          }}
        />
        <Attachment attachment={xlsx} />
      </RecoilRoot>,
    );
    expect(snapshot.currentArtifactId).toBe('tool-artifact-just-resolved-xlsx');
    expect(snapshot.visibility).toBe(true);
  });

  it('does NOT re-auto-open on a second mount after the just-resolved flag is consumed', () => {
    /* The flag is one-shot — first card to mount consumes it. A second
     * mount of the same file_id (panel close + reopen, history scroll
     * onto the same card) must NOT re-steal focus, otherwise the user
     * could never close the panel without it popping back open. */
    const xlsx = baseAttachment({
      file_id: 'one-shot-xlsx',
      filename: 'data.xlsx',
      text: '<table>resolved</table>',
      textFormat: 'html',
    });
    const initializeState = (snap: MutableSnapshot) => {
      snap.set(store.isSubmittingFamily(0), false);
      snap.set(store.artifactsVisibility, false);
      snap.set(store.previewJustResolved('one-shot-xlsx'), true);
    };
    let snapshot: ArtifactsSnapshot = {
      visibility: false,
      currentArtifactId: null,
      artifactIds: [],
    };
    const { unmount } = render(
      <RecoilRoot initializeState={initializeState}>
        <StateProbe
          onSnapshot={(snap) => {
            snapshot = snap;
          }}
        />
        <Attachment attachment={xlsx} />
      </RecoilRoot>,
    );
    /* First mount auto-opened. Now simulate a fresh Recoil tree with the
     * flag in the post-consume state (false) and assert the second
     * mount stays closed. We use a fresh RecoilRoot to mirror what a
     * real "panel was closed and the user then revealed the chip
     * again" pathway would look like at the state level. */
    unmount();
    snapshot = { visibility: false, currentArtifactId: null, artifactIds: [] };
    const secondInit = (snap: MutableSnapshot) => {
      snap.set(store.isSubmittingFamily(0), false);
      snap.set(store.artifactsVisibility, false);
      // flag stays at default (false) — already consumed
    };
    render(
      <RecoilRoot initializeState={secondInit}>
        <StateProbe
          onSnapshot={(snap) => {
            snapshot = snap;
          }}
        />
        <Attachment attachment={xlsx} />
      </RecoilRoot>,
    );
    expect(snapshot.currentArtifactId).toBeNull();
    expect(snapshot.visibility).toBe(false);
  });

  it('clicking a CODE artifact focuses it even though it skipped auto-open', () => {
    // Counterpart to the streaming-CODE no-auto-open test: confirm the
    // click path still surfaces a `.py` chip in the panel. Even on a
    // streaming mount the user can click to open; the carve-out only
    // affects the *automatic* open, not the explicit one.
    const py = baseAttachment({
      file_id: 'click-py',
      filename: 'helper.py',
      text: 'print("hi")',
    } as Partial<TAttachment>);
    const { getSnapshot } = renderWithProbe(<Attachment attachment={py} />);
    expect(getSnapshot().currentArtifactId).toBeNull();
    const openButton = screen.getByRole('button', { name: /com_ui_artifact_click/i });
    act(() => {
      fireEvent.click(openButton);
    });
    expect(getSnapshot().currentArtifactId).toBe('tool-artifact-click-py');
    expect(getSnapshot().visibility).toBe(true);
  });

  it('clicking a history-loaded card focuses it (user-initiated open)', () => {
    // Even though the mount-time auto-focus is suppressed for history,
    // the click handler is unconditional — users explicitly opening a
    // chip must always work.
    const html = baseAttachment({
      file_id: 'history-click',
      filename: 'previous.html',
      text: '<h1>prev</h1>',
    } as Partial<TAttachment>);
    const { getSnapshot } = renderWithProbe(<Attachment attachment={html} />, {
      streaming: false,
    });
    expect(getSnapshot().currentArtifactId).toBeNull();
    /** Pin to the panel-open button by name — the download button has no
     * `aria-expanded`, but `getByRole('button', { expanded: false })`
     * relies on DOM order, which silently shifts if the row's button
     * order changes. */
    const openButton = screen.getByRole('button', { name: /com_ui_artifact_click/i });
    act(() => {
      fireEvent.click(openButton);
    });
    expect(getSnapshot().currentArtifactId).toBe('tool-artifact-history-click');
    expect(getSnapshot().visibility).toBe(true);
  });
});

describe('AttachmentGroup routing', () => {
  it('filters internal sandbox `.dirkeep` placeholders out of every bucket', () => {
    // The bash executor's empty-folder marker (`_.dirkeep-<hash>`,
    // `bytes: 0`) is implementation detail; users shouldn't see it as
    // its own chip. The filter runs ahead of all routing so the
    // placeholder doesn't leak into image / panel / text / file buckets.
    const realFile = baseAttachment({
      file_id: 'real',
      filename: 'test_folder/test_file.txt',
      text: 'hello',
      bytes: 5,
    } as Partial<TAttachment>);
    const dirkeep = baseAttachment({
      file_id: 'dk',
      filename: 'test_folder/_.dirkeep-88b30b',
      bytes: 0,
    } as Partial<TAttachment>);
    const { container } = renderWith(<AttachmentGroup attachments={[dirkeep, realFile]} />);
    // No chip rendered for the dirkeep placeholder.
    expect(screen.queryByText(/dirkeep/)).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/dirkeep/);
    // Real file still renders.
    expect(container.textContent).toMatch(/test_file\.txt/);
  });

  it('sinks empty files below non-empty siblings within the file bucket', () => {
    // Without the salience sort, an early-arriving 0-byte file would
    // render first and visually upstage the real artifact below it.
    // Both files route to the `fileAttachments` bucket (no text, no
    // panel-eligible extension) so the test exercises within-bucket
    // ordering — sort is per-bucket, not cross-bucket.
    const empty = baseAttachment({
      file_id: 'empty-zip',
      filename: 'placeholder.zip',
      bytes: 0,
    });
    const real = baseAttachment({
      file_id: 'real-zip',
      filename: 'archive.zip',
      bytes: 1024,
    });
    const { container } = renderWith(<AttachmentGroup attachments={[empty, real]} />);
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_show_n_files' }));
    const chips = Array.from(container.querySelectorAll('[data-testid="file-container"]'));
    expect(chips.length).toBe(2);
    const filenames = chips.map((c) => c.textContent ?? '');
    // Real chip must render before the empty placeholder.
    expect(filenames[0]).toMatch(/archive\.zip/);
    expect(filenames[1]).toMatch(/placeholder\.zip/);
  });

  it('keeps multiple downloadable files in their own collapsed group while images render outwardly', () => {
    const first = baseAttachment({
      file_id: 'file-a',
      filename: 'a.zip',
    });
    const second = baseAttachment({
      file_id: 'file-b',
      filename: 'b.zip',
    });
    const json = baseAttachment({
      file_id: 'file-c',
      filename: 'c.json',
      text: '{"c":true}',
    });
    const image = baseAttachment({
      file_id: 'image-a',
      filename: 'preview.png',
      width: 16,
      height: 16,
    });

    const { container } = renderWith(
      <AttachmentGroup attachments={[first, second, json, image]} />,
    );

    const toggle = screen.getByRole('button', { name: 'com_ui_show_n_files' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const panel = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    expect(panel?.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('image')).toBeInTheDocument();
    expect(screen.getAllByTestId('file-container').map((chip) => chip.textContent)).not.toContain(
      'c.json',
    );

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('c.json')).toBeInTheDocument();
    expect(container.querySelector('pre')?.textContent).toBe('{"c":true}');
  });

  it('passes a non-dotfile filename through to FileContainer unchanged', () => {
    /** `displayFilename` deliberately leaves non-dotfile names alone —
     * the `-<6 hex>` tail on `archive-deadbe.zip` could be either a
     * user-named hash artifact OR a sanitization disambiguator, and
     * collapsing both onto `archive.zip` would silently merge distinct
     * files in the chip. Only the leading-`_.` dotfile shape has a
     * structural discriminator strong enough to safely strip; everything
     * else passes through verbatim. */
    const sandboxFile = baseAttachment({
      file_id: 'sandbox-zip',
      filename: 'archive-deadbe.zip',
      bytes: 1024,
    });
    const { container } = renderWith(<AttachmentGroup attachments={[sandboxFile]} />);
    const chip = container.querySelector('[data-testid="file-container"]');
    expect(chip?.textContent).toBe('archive-deadbe.zip');
  });

  it('strips the suffix and restores the dot for a sandbox dotfile rendered through FileContainer', () => {
    /** Counterpart: the dotfile shape `_.config-<hash>.zip` IS recoverable
     * because the leading `_.` is the structural fingerprint. Confirm
     * the artifact path's `displayName` flows through `FileContainer`
     * for this case. Uses `.zip` (no panel-artifact extension mapping)
     * so the attachment lands in the plain-file bucket rather than the
     * PLAIN_TEXT panel-artifact bucket. */
    const sandboxDotfile = baseAttachment({
      file_id: 'sandbox-config',
      filename: '_.config-abcdef.zip',
      bytes: 12,
    });
    const { container } = renderWith(<AttachmentGroup attachments={[sandboxDotfile]} />);
    const chip = container.querySelector('[data-testid="file-container"]');
    expect(chip?.textContent).toBe('.config.zip');
  });

  it('renders pending-preview chips in the panel-artifact row alongside resolved siblings', () => {
    /* A pending preview is a future panel artifact — render it in the
     * same row so when it resolves the chip stays put instead of
     * jumping between rows. Plain files keep their own row. */
    const attachments = [
      baseAttachment({
        file_id: 'resolved',
        filename: 'index.html',
        text: '<h1>hi</h1>',
      } as Partial<TAttachment>),
      baseAttachment({
        file_id: 'pending-1',
        filename: 'data.xlsx',
        status: 'pending',
      } as Partial<TAttachment>),
      baseAttachment({
        file_id: 'plain',
        filename: 'archive.zip',
        text: undefined as unknown as string,
      } as Partial<TAttachment>),
    ] as TAttachment[];

    const { container } = renderWith(<AttachmentGroup attachments={attachments} />);

    /* The resolved artifact and the still-pending one share the artifact
     * group, so when the preview lands the row stays put instead of
     * jumping between buckets. The plain download keeps its own group. */
    const group = screen.getByTestId('artifact-row-group');
    expect(group).toContainElement(container.querySelector('[data-artifact-trigger]'));
    expect(group).toContainElement(screen.getByText('index.html'));
    expect(group).toContainElement(screen.getByText('data.xlsx'));
    expect(group).not.toContainElement(screen.getByText('archive.zip'));
  });

  it('keeps a pending placeholder in the row slot it arrived in', () => {
    /* Sinking every pending entry to the end of the group made the
     * placeholder jump the moment its preview resolved and joined the
     * salience-sorted siblings. The slot it arrived in is the slot it
     * upgrades in. */
    const attachments = [
      baseAttachment({
        file_id: 'pending-1',
        filename: 'data.xlsx',
        status: 'pending',
      } as Partial<TAttachment>),
      baseAttachment({
        file_id: 'resolved',
        filename: 'index.html',
        text: '<h1>hi</h1>',
      } as Partial<TAttachment>),
    ] as TAttachment[];

    renderWith(<AttachmentGroup attachments={attachments} />);

    const rows = Array.from(screen.getByTestId('artifact-row-group').children);
    expect(rows.findIndex((row) => row.textContent?.includes('data.xlsx'))).toBe(0);
    expect(rows.findIndex((row) => row.textContent?.includes('index.html'))).toBe(1);
  });

  it('keeps a pending row above an empty artifact through its transition', () => {
    /* The empty artifact sinks by salience, and a pending file carries the
     * same `bytes` before and after its preview resolves, so both renders
     * must order the pair identically — otherwise the row jumps exactly
     * when the preview lands. */
    const empty = baseAttachment({
      file_id: 'empty',
      filename: 'notes.md',
      text: '',
      bytes: 0,
    } as Partial<TAttachment>);
    const loading = baseAttachment({
      file_id: 'pending-2',
      filename: 'report.xlsx',
      bytes: 4096,
      status: 'pending',
    } as Partial<TAttachment>);
    const resolved = baseAttachment({
      file_id: 'pending-2',
      filename: 'report.xlsx',
      bytes: 4096,
      text: '<table></table>',
      textFormat: 'html',
    } as Partial<TAttachment>);

    const order = (attachments: TAttachment[]) => {
      const { unmount } = renderWith(<AttachmentGroup attachments={attachments} />);
      const rows = Array.from(screen.getByTestId('artifact-row-group').children);
      const positions = rows.map((row) => (row.textContent?.includes('report.xlsx') ? 'x' : 'e'));
      unmount();
      return positions.join('');
    };

    expect(order([empty, loading] as TAttachment[])).toBe('xe');
    expect(order([empty, resolved] as TAttachment[])).toBe('xe');
  });

  it('renders separate buckets for panel artifacts, mermaid, text, and plain files', () => {
    const attachments = [
      baseAttachment({
        file_id: 'a',
        filename: 'index.html',
        text: '<h1>hi</h1>',
      } as Partial<TAttachment>),
      baseAttachment({
        file_id: 'b',
        filename: 'flow.mmd',
        text: 'graph TD\nA-->B',
      } as Partial<TAttachment>),
      baseAttachment({
        file_id: 'c',
        filename: 'data.json',
        text: '{"a":1}',
      } as Partial<TAttachment>),
      baseAttachment({
        file_id: 'd',
        filename: 'archive.zip',
        text: undefined as unknown as string,
      } as Partial<TAttachment>),
    ] as TAttachment[];

    const { container } = renderWith(<AttachmentGroup attachments={attachments} />);

    // Panel artifact card title
    expect(screen.getByText('index.html')).toBeInTheDocument();
    // Mermaid render
    expect(screen.getByTestId('mermaid-render')).toBeInTheDocument();
    // JSON and plain zip are both downloadable file outputs, so they collapse together.
    const toggle = screen.getByRole('button', { name: 'com_ui_show_n_files' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const chipLabels = screen.getAllByTestId('file-container').map((chip) => chip.textContent);
    expect(chipLabels).toContain('archive.zip');
    expect(chipLabels).not.toContain('data.json');

    fireEvent.click(toggle);
    expect(screen.getByText('data.json')).toBeInTheDocument();
    expect(container.querySelector('pre')?.textContent).toBe('{"a":1}');
  });
});

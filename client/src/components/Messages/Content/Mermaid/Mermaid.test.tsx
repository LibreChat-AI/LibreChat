import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { RecoilRoot, useRecoilValue, useResetRecoilState } from 'recoil';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Artifact } from '~/common';
import Mermaid, { MermaidRenderer } from './Mermaid';
import { MessageContext } from '~/Providers';
import store from '~/store';

const mockOpenAsArtifactLabel = 'com_ui_open_as_artifact';
const mockExpandLabel = 'com_ui_expand';
const mockProcessedSvg = '<svg viewBox="0 0 400 200" />';
let mockSvgProcessingState = {
  blobUrl: 'blob:mermaid-diagram',
  processedSvg: mockProcessedSvg,
  svgDimensions: { width: 400, height: 200 },
  isLoading: false,
  error: null,
  lastValidSvgRef: { current: null as string | null },
  initialScale: 1,
  calculatedHeight: 240,
};

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string): string =>
      key,
}));

jest.mock('./useSvgProcessing', () => ({
  __esModule: true,
  default: () => mockSvgProcessingState,
}));

jest.mock('./useMermaidZoom', () => ({
  __esModule: true,
  default: () => ({
    zoom: 1,
    pan: { x: 0, y: 0 },
    isPanning: false,
    handleZoomIn: jest.fn(),
    handleZoomOut: jest.fn(),
    handleResetZoom: jest.fn(),
    handleMouseDown: jest.fn(),
  }),
}));

jest.mock('./MermaidHeader', () => ({
  __esModule: true,
  default: ({
    showExpandButton,
    showCode,
    onExpand,
    onToggleCode,
    expandLabel,
    exportSvg,
    exportFilename,
  }: {
    showExpandButton?: boolean;
    showCode: boolean;
    onExpand?: () => void;
    onToggleCode: () => void;
    expandLabel?: string;
    exportSvg?: string | null;
    exportFilename?: string;
  }) => (
    <>
      {showExpandButton && onExpand ? (
        <button type="button" aria-label={expandLabel ?? mockExpandLabel} onClick={onExpand}>
          {expandLabel ?? mockExpandLabel}
        </button>
      ) : null}
      <button
        type="button"
        aria-label={showCode ? 'com_ui_preview' : 'com_ui_show_code'}
        onClick={onToggleCode}
      >
        {showCode ? 'com_ui_preview' : 'com_ui_show_code'}
      </button>
      {exportSvg != null && (
        <output data-testid="mermaid-export">
          {exportFilename}:{exportSvg}
        </output>
      )}
    </>
  ),
}));

jest.mock('./ZoomControls', () => ({
  __esModule: true,
  default: () => <div data-testid="mermaid-zoom-controls" />,
}));

jest.mock('./MermaidDialog', () => ({
  __esModule: true,
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="mermaid-dialog" /> : null),
}));

interface ArtifactStateSnapshot {
  artifacts: Record<string, Artifact | undefined> | null;
  currentArtifactId: string | null;
  visible: boolean;
}

const StateProbe = ({ onChange }: { onChange: (state: ArtifactStateSnapshot) => void }) => {
  const artifacts = useRecoilValue(store.artifactsState);
  const currentArtifactId = useRecoilValue(store.currentArtifactId);
  const visible = useRecoilValue(store.artifactsVisibility);

  React.useEffect(() => {
    onChange({ artifacts, currentArtifactId, visible });
  }, [artifacts, currentArtifactId, onChange, visible]);

  return null;
};

describe('Mermaid Artifact expansion', () => {
  beforeEach(() => {
    mockSvgProcessingState = {
      blobUrl: 'blob:mermaid-diagram',
      processedSvg: mockProcessedSvg,
      svgDimensions: { width: 400, height: 200 },
      isLoading: false,
      error: null,
      lastValidSvgRef: { current: null },
      initialScale: 1,
      calculatedHeight: 240,
    };
  });

  it('opens in the Artifact panel and replaces the inline graph with a reopenable card', async () => {
    let state: ArtifactStateSnapshot = {
      artifacts: null,
      currentArtifactId: null,
      visible: false,
    };
    const handleStateChange = (nextState: ArtifactStateSnapshot) => {
      state = nextState;
    };
    const { container } = render(
      <RecoilRoot>
        <MemoryRouter initialEntries={['/c/conversation-1']}>
          <MessageContext.Provider
            value={{ messageId: 'message-1', conversationId: 'conversation-1', isExpanded: true }}
          >
            <StateProbe onChange={handleStateChange} />
            <Mermaid id="mermaid-0">{'graph TD\nA-->B'}</Mermaid>
          </MessageContext.Provider>
        </MemoryRouter>
      </RecoilRoot>,
    );

    expect(screen.getByTestId('mermaid-export')).toHaveTextContent(
      'com_ui_mermaid_diagram:<svg viewBox="0 0 400 200" />',
    );

    fireEvent.click(screen.getByRole('button', { name: mockOpenAsArtifactLabel }));

    const artifactButton = await screen.findByRole('button', { expanded: true });
    expect(screen.queryByTestId('mermaid-dialog')).not.toBeInTheDocument();
    expect(screen.getByText('com_ui_mermaid_diagram')).toBeInTheDocument();
    expect(artifactButton).toHaveAccessibleName(/com_ui_click_to_close/);
    expect(artifactButton).toHaveAttribute('aria-controls', 'artifact-viewer');
    /* The mermaid trigger is an `ArtifactRow` like every other artifact in
     * the stream: the diagram glyph sits in the row's glyph slot, tinted
     * with the `status-info` accent that marks a rendered preview. */
    expect(artifactButton).toHaveClass('text-text-primary');
    expect(container.querySelector('.lucide-workflow')).not.toBeNull();
    expect(container.querySelector('.lucide-workflow')?.parentElement).toHaveClass(
      'text-status-info',
    );
    await waitFor(() => expect(artifactButton).toHaveFocus());

    const artifact = Object.values(state.artifacts ?? {})[0];
    expect(artifact).toMatchObject({
      type: 'application/vnd.mermaid',
      title: 'com_ui_mermaid_diagram',
      content: 'graph TD\nA-->B',
      messageId: 'message-1',
    });
    expect(state.currentArtifactId).toBe(artifact?.id);
    expect(state.visible).toBe(true);

    fireEvent.click(artifactButton);
    expect(state.currentArtifactId).toBeNull();
    expect(state.visible).toBe(false);
    expect(artifactButton).not.toHaveClass('text-text-primary');
    expect(artifactButton).toHaveAccessibleName(/com_ui_artifact_click/);

    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(state.currentArtifactId).toBe(artifact?.id);
    expect(state.visible).toBe(true);
  });

  it('hands a file-backed diagram its download and reports the row mode', async () => {
    /* A code-execution `.mmd` arrives wrapped in a header that shows the
     * filename and its own download button. Once the diagram becomes its
     * trigger row, the row takes both over, and the wrapper needs to know
     * so it stops repeating them beside it. */
    const onDownload = jest.fn();
    const rowModes: boolean[] = [];
    render(
      <RecoilRoot>
        <MemoryRouter initialEntries={['/c/conversation-1']}>
          <MessageContext.Provider
            value={{ messageId: 'message-1', conversationId: 'conversation-1', isExpanded: true }}
          >
            <Mermaid
              id="flow-file"
              artifact={
                {
                  id: 'tool-artifact-flow',
                  type: 'application/vnd.mermaid',
                  title: 'flow.mmd',
                  content: 'graph TD\nA-->B',
                  lastUpdateTime: 1,
                } as Artifact
              }
              onDownload={onDownload}
              onRowModeChange={(isRow) => rowModes.push(isRow)}
            >
              {'graph TD\nA-->B'}
            </Mermaid>
          </MessageContext.Provider>
        </MemoryRouter>
      </RecoilRoot>,
    );

    expect(rowModes).toEqual([false]);
    fireEvent.click(screen.getByRole('button', { name: mockOpenAsArtifactLabel }));

    const downloadButton = await screen.findByRole('button', { name: 'com_ui_download flow.mmd' });
    fireEvent.click(downloadButton);
    expect(onDownload).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(rowModes[rowModes.length - 1]).toBe(true));
  });

  it('shows the caller-supplied display name on the row, not the raw title', async () => {
    /* A sandbox-generated `_.flow-abcdef.mmd` reads as `.flow.mmd` through
     * `displayFilename`; the row and its download button must not regress
     * to the internal filename once the diagram collapses. */
    render(
      <RecoilRoot>
        <MemoryRouter initialEntries={['/c/conversation-1']}>
          <MessageContext.Provider
            value={{ messageId: 'message-1', conversationId: 'conversation-1', isExpanded: true }}
          >
            <Mermaid
              id="flow-hidden"
              artifact={
                {
                  id: 'tool-artifact-hidden',
                  type: 'application/vnd.mermaid',
                  title: '_.flow-abcdef.mmd',
                  content: 'graph TD\nA-->B',
                  lastUpdateTime: 1,
                } as Artifact
              }
              rowTitle=".flow.mmd"
              onDownload={jest.fn()}
            >
              {'graph TD\nA-->B'}
            </Mermaid>
          </MessageContext.Provider>
        </MemoryRouter>
      </RecoilRoot>,
    );

    fireEvent.click(screen.getByRole('button', { name: mockOpenAsArtifactLabel }));

    expect(await screen.findByText('.flow.mmd')).toBeInTheDocument();
    expect(screen.queryByText('_.flow-abcdef.mmd')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_download .flow.mmd' })).toBeInTheDocument();
  });

  it('separates diagrams that sit in different content parts of one message', async () => {
    let state: ArtifactStateSnapshot = {
      artifacts: null,
      currentArtifactId: null,
      visible: false,
    };
    const handleStateChange = (nextState: ArtifactStateSnapshot) => {
      state = nextState;
    };

    /* Every content part builds its own markdown tree, so a diagram before a
     * tool call and one after it both arrive here as `mermaid-0`. */
    render(
      <RecoilRoot>
        <MemoryRouter initialEntries={['/c/conversation-1']}>
          <StateProbe onChange={handleStateChange} />
          <MessageContext.Provider
            value={{
              messageId: 'message-1',
              conversationId: 'conversation-1',
              partIndex: 0,
              isExpanded: true,
            }}
          >
            <Mermaid id="mermaid-0">{'graph TD\nA-->B'}</Mermaid>
          </MessageContext.Provider>
          <MessageContext.Provider
            value={{
              messageId: 'message-1',
              conversationId: 'conversation-1',
              partIndex: 2,
              isExpanded: true,
            }}
          >
            <Mermaid id="mermaid-0">{'graph TD\nC-->D'}</Mermaid>
          </MessageContext.Provider>
        </MemoryRouter>
      </RecoilRoot>,
    );

    const [firstExpand, secondExpand] = screen.getAllByRole('button', {
      name: mockOpenAsArtifactLabel,
    });
    fireEvent.click(firstExpand);
    fireEvent.click(secondExpand);

    await waitFor(() => expect(Object.keys(state.artifacts ?? {})).toHaveLength(2));

    const registered = Object.values(state.artifacts ?? {}).filter(
      (entry): entry is Artifact => entry != null,
    );
    expect(new Set(registered.map((entry) => entry.id)).size).toBe(2);
    expect(registered.map((entry) => entry.content)).toEqual(
      expect.arrayContaining(['graph TD\nA-->B', 'graph TD\nC-->D']),
    );

    const cards = screen.getAllByRole('button', { expanded: false });
    const selected = screen.getAllByRole('button', { expanded: true });
    expect(cards).toHaveLength(1);
    expect(selected).toHaveLength(1);
  });

  it('restores its registration after the Artifact store is reset', async () => {
    let state: ArtifactStateSnapshot = {
      artifacts: null,
      currentArtifactId: null,
      visible: false,
    };
    const handleStateChange = (nextState: ArtifactStateSnapshot) => {
      state = nextState;
    };
    let resetStore: () => void = () => undefined;
    const StoreResetter = () => {
      resetStore = useResetRecoilState(store.artifactsState);
      return null;
    };

    render(
      <RecoilRoot>
        <MemoryRouter initialEntries={['/c/conversation-1']}>
          <StateProbe onChange={handleStateChange} />
          <StoreResetter />
          <MessageContext.Provider
            value={{ messageId: 'message-1', conversationId: 'conversation-1', isExpanded: true }}
          >
            <Mermaid id="mermaid-0">{'graph TD\nA-->B'}</Mermaid>
          </MessageContext.Provider>
        </MemoryRouter>
      </RecoilRoot>,
    );

    fireEvent.click(screen.getByRole('button', { name: mockOpenAsArtifactLabel }));
    await waitFor(() => expect(Object.keys(state.artifacts ?? {})).toHaveLength(1));

    /* Closing the panel unmounts `Artifacts`, whose cleanup wipes the store
     * while this card stays on screen. */
    act(() => resetStore());

    await waitFor(() => expect(Object.keys(state.artifacts ?? {})).toHaveLength(1));
  });

  it('keeps the dialog expansion on routes without an Artifact panel', () => {
    let state: ArtifactStateSnapshot = {
      artifacts: null,
      currentArtifactId: null,
      visible: false,
    };
    render(
      <RecoilRoot>
        <MemoryRouter initialEntries={['/search']}>
          <StateProbe
            onChange={(nextState) => {
              state = nextState;
            }}
          />
          <Mermaid id="mermaid-0">{'graph TD\nA-->B'}</Mermaid>
        </MemoryRouter>
      </RecoilRoot>,
    );

    fireEvent.click(screen.getByRole('button', { name: mockExpandLabel }));

    expect(screen.getByTestId('mermaid-dialog')).toBeInTheDocument();
    expect(screen.queryByRole('button', { expanded: true })).not.toBeInTheDocument();
    expect(state.artifacts).toBeNull();
    expect(state.currentArtifactId).toBeNull();
  });

  it('keeps Artifact and export controls while showing the last valid streaming diagram', () => {
    mockSvgProcessingState = {
      ...mockSvgProcessingState,
      isLoading: true,
      lastValidSvgRef: { current: '<svg width="400" height="200" />' },
    };

    render(
      <RecoilRoot>
        <MemoryRouter initialEntries={['/c/conversation-1']}>
          <Mermaid id="mermaid-0">{'graph TD\nA-->B'}</Mermaid>
        </MemoryRouter>
      </RecoilRoot>,
    );

    expect(screen.getByRole('button', { name: mockOpenAsArtifactLabel })).toBeInTheDocument();
    expect(screen.getByTestId('mermaid-export')).toHaveTextContent(mockProcessedSvg);
  });

  it('switches exclusively between the inline diagram and its source', () => {
    const { container } = render(
      <RecoilRoot>
        <MemoryRouter initialEntries={['/c/conversation-1']}>
          <Mermaid id="mermaid-0">{'graph TD\nA-->B'}</Mermaid>
        </MemoryRouter>
      </RecoilRoot>,
    );

    expect(screen.getByRole('img', { name: 'com_ui_mermaid_diagram' })).toBeInTheDocument();
    expect(screen.getByTestId('mermaid-zoom-controls')).toBeInTheDocument();
    expect(container.querySelector('pre')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_show_code' }));

    expect(container.querySelector('pre')?.textContent).toBe('graph TD\nA-->B');
    expect(screen.queryByRole('img', { name: 'com_ui_mermaid_diagram' })).not.toBeInTheDocument();
    expect(screen.getByTestId('mermaid-zoom-controls')).not.toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_preview' }));

    expect(screen.getByRole('img', { name: 'com_ui_mermaid_diagram' })).toBeInTheDocument();
    expect(container.querySelector('pre')).toBeNull();
  });

  it('switches exclusively to current source while a last-valid diagram is streaming', () => {
    mockSvgProcessingState = {
      ...mockSvgProcessingState,
      isLoading: true,
      lastValidSvgRef: { current: '<svg width="400" height="200" />' },
    };
    const { container } = render(
      <RecoilRoot>
        <MemoryRouter initialEntries={['/c/conversation-1']}>
          <Mermaid id="mermaid-0">{'graph TD\nA-->B'}</Mermaid>
        </MemoryRouter>
      </RecoilRoot>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_show_code' }));

    expect(container.querySelector('pre')?.textContent).toBe('graph TD\nA-->B');
    expect(screen.queryByRole('img', { name: 'com_ui_mermaid_diagram' })).not.toBeInTheDocument();
    expect(screen.getByTestId('mermaid-zoom-controls')).not.toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_preview' }));

    expect(screen.getByRole('img', { name: 'com_ui_mermaid_diagram' })).toBeInTheDocument();
    expect(container.querySelector('pre')).toBeNull();
  });

  it('renders a toolbar-free native preview for the Artifact panel', () => {
    render(
      <MermaidRenderer
        exportFilename="Flow chart"
        fillContainer
        showExpandButton={false}
        showHeader={false}
      >
        {'graph TD\nA-->B'}
      </MermaidRenderer>,
    );

    const diagram = screen.getByRole('img', { name: 'com_ui_mermaid_diagram' });
    const canvas = screen.getByTestId('mermaid-artifact-canvas');

    expect(diagram).toBeInTheDocument();
    expect(canvas).toHaveClass('h-full', 'rounded-lg');
    expect(canvas).not.toHaveAttribute('style');
    expect(canvas.parentElement).toHaveClass('h-full', 'rounded-xl');
    expect(screen.getByTestId('mermaid-zoom-controls')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'com_ui_show_code' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: mockExpandLabel })).not.toBeInTheDocument();
  });

  it('shares its rendered SVG with the Artifact toolbar instead of rendering the source again', async () => {
    const onExportReady = jest.fn();

    render(
      <MermaidRenderer
        exportFilename="Flow chart"
        onExportReady={onExportReady}
        showExpandButton={false}
        showHeader={false}
      >
        {'graph TD\nA-->B'}
      </MermaidRenderer>,
    );

    await waitFor(() =>
      expect(onExportReady).toHaveBeenCalledWith({
        svg: mockProcessedSvg,
        dimensions: { width: 400, height: 200 },
      }),
    );
  });

  it('withdraws the export payload when the preview unmounts', async () => {
    const onExportReady = jest.fn();

    const { unmount } = render(
      <MermaidRenderer
        exportFilename="Flow chart"
        onExportReady={onExportReady}
        showExpandButton={false}
        showHeader={false}
      >
        {'graph TD\nA-->B'}
      </MermaidRenderer>,
    );

    await waitFor(() => expect(onExportReady).toHaveBeenCalledWith(expect.objectContaining({})));

    unmount();

    expect(onExportReady).toHaveBeenLastCalledWith(null);
  });

  it('announces loading without exposing source in the native Artifact preview', () => {
    mockSvgProcessingState = {
      ...mockSvgProcessingState,
      isLoading: true,
      lastValidSvgRef: { current: null },
    };
    const { container } = render(
      <MermaidRenderer
        exportFilename="Flow chart"
        fillContainer
        showExpandButton={false}
        showHeader={false}
      >
        {'graph TD\nA-->B'}
      </MermaidRenderer>,
    );

    expect(screen.getByRole('status')).toHaveTextContent('com_ui_loading');
    expect(screen.getByRole('status')).toHaveClass('h-full', 'rounded-xl');
    expect(container.querySelector('pre')).toBeNull();
  });

  it('updates an open tool Artifact when a newer instance replaces the same file', async () => {
    let state: ArtifactStateSnapshot = {
      artifacts: null,
      currentArtifactId: null,
      visible: false,
    };
    const handleStateChange = (nextState: ArtifactStateSnapshot) => {
      state = nextState;
    };
    const renderTree = (content: string, version: string) => (
      <RecoilRoot>
        <MemoryRouter initialEntries={['/c/conversation-1']}>
          <MessageContext.Provider
            value={{ messageId: 'message-1', conversationId: 'conversation-1', isExpanded: true }}
          >
            <StateProbe onChange={handleStateChange} />
            <Mermaid
              key={version}
              id="file-1"
              artifact={{
                id: 'tool-artifact-file-1',
                type: 'application/vnd.mermaid',
                title: 'flow.mmd',
                content,
                lastUpdateTime: 1,
              }}
            >
              {content}
            </Mermaid>
          </MessageContext.Provider>
        </MemoryRouter>
      </RecoilRoot>
    );
    const { rerender } = render(renderTree('graph TD\nA-->B', 'v1'));

    fireEvent.click(screen.getByRole('button', { name: mockOpenAsArtifactLabel }));
    expect(state.artifacts?.['tool-artifact-file-1']?.content).toBe('graph TD\nA-->B');

    rerender(renderTree('graph TD\nA-->C', 'v2'));

    await waitFor(() =>
      expect(state.artifacts?.['tool-artifact-file-1']?.content).toBe('graph TD\nA-->C'),
    );
    expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument();
    expect(state.currentArtifactId).toBe('tool-artifact-file-1');
  });

  it('gives Mermaid blocks without explicit IDs separate Artifacts', async () => {
    let state: ArtifactStateSnapshot = {
      artifacts: null,
      currentArtifactId: null,
      visible: false,
    };
    render(
      <RecoilRoot>
        <MemoryRouter initialEntries={['/c/conversation-1']}>
          <MessageContext.Provider
            value={{ messageId: 'message-1', conversationId: 'conversation-1', isExpanded: true }}
          >
            <StateProbe
              onChange={(nextState) => {
                state = nextState;
              }}
            />
            <Mermaid>{'graph TD\nA-->B'}</Mermaid>
            <Mermaid>{'graph TD\nC-->D'}</Mermaid>
          </MessageContext.Provider>
        </MemoryRouter>
      </RecoilRoot>,
    );

    fireEvent.click(screen.getAllByRole('button', { name: mockOpenAsArtifactLabel })[0]);
    fireEvent.click(screen.getByRole('button', { name: mockOpenAsArtifactLabel }));

    await waitFor(() => expect(Object.keys(state.artifacts ?? {})).toHaveLength(2));
    expect(Object.values(state.artifacts ?? {}).map((artifact) => artifact?.content)).toEqual(
      expect.arrayContaining(['graph TD\nA-->B', 'graph TD\nC-->D']),
    );
  });
});

import React from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { render, waitFor } from '@testing-library/react';
import type { SandpackPreviewRef } from '@codesandbox/sandpack-react/unstyled';
import type { Artifact } from '~/common';
import ArtifactTabs from './ArtifactTabs';

interface EditorProps {
  artifact: Artifact;
  readOnly?: boolean;
}

const mockEditor = jest.fn((_props: EditorProps) => null);
const mockUseGetStartupConfig = jest.fn((_options?: unknown) => ({ data: {} }));
const mockUseGetSharedStartupConfig = jest.fn((_shareId?: unknown, _options?: unknown) => ({
  data: {},
}));
let mockCurrentCode: string | undefined;
let mockCodeArtifactId: string | undefined;

jest.mock('./ArtifactCodeEditor', () => ({
  ArtifactCodeEditor: (props: EditorProps) => mockEditor(props),
}));

jest.mock('./ArtifactPreview', () => {
  const testGlobal = globalThis as typeof globalThis & {
    artifactPreviewModuleEvaluations?: number;
  };
  testGlobal.artifactPreviewModuleEvaluations =
    (testGlobal.artifactPreviewModuleEvaluations ?? 0) + 1;
  return { ArtifactPreview: () => null };
});

jest.mock('~/components/Messages/Content/Mermaid/Mermaid', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  let mounts = 0;
  /** Renders the mount ordinal so a remount (new key) is observable. */
  const nativeRenderer = jest.fn(() => {
    const [instance] = ReactModule.useState(() => {
      mounts += 1;
      return mounts;
    });
    return ReactModule.createElement('div', {
      'data-testid': 'mermaid-renderer',
      'data-instance': String(instance),
    });
  });
  const testGlobal = globalThis as typeof globalThis & {
    nativeMermaidRenderer?: typeof nativeRenderer;
  };
  testGlobal.nativeMermaidRenderer = nativeRenderer;
  return { MermaidRenderer: nativeRenderer };
});

jest.mock('~/Providers/EditorContext', () => ({
  useCodeState: () => ({
    currentCode: mockCurrentCode,
    codeArtifactId: mockCodeArtifactId,
    setCurrentCode: jest.fn(),
  }),
}));

jest.mock('~/Providers', () => ({
  useShareContext: () => ({ shareId: undefined }),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: (options: unknown) => mockUseGetStartupConfig(options),
  useGetSharedStartupConfig: (shareId: unknown, options: unknown) =>
    mockUseGetSharedStartupConfig(shareId, options),
}));

jest.mock('~/hooks/Artifacts/useArtifactProps', () => ({
  __esModule: true,
  default: () => ({ files: {}, fileKey: 'diagram.mmd', template: 'static', sharedProps: {} }),
}));

const preview: SandpackPreviewRef = Object.create(null);
const previewRef: React.MutableRefObject<SandpackPreviewRef> = { current: preview };

function renderArtifact(artifact: Artifact, activeTab: 'code' | 'preview' = 'code') {
  return render(
    <Tabs.Root value={activeTab}>
      <ArtifactTabs artifact={artifact} previewRef={previewRef} />
    </Tabs.Root>,
  );
}

describe('ArtifactTabs Mermaid editing', () => {
  beforeEach(() => {
    mockEditor.mockClear();
    mockUseGetStartupConfig.mockClear();
    mockUseGetSharedStartupConfig.mockClear();
    mockCurrentCode = undefined;
    mockCodeArtifactId = undefined;
  });

  it('renders Mermaid natively without loading startup config or Sandpack preview', () => {
    const testGlobal = globalThis as typeof globalThis & {
      artifactPreviewModuleEvaluations?: number;
      nativeMermaidRenderer?: jest.Mock;
    };

    renderArtifact(
      {
        id: 'mermaid-chat-1',
        type: 'application/vnd.mermaid',
        title: 'Flow chart',
        content: 'graph TD\nA-->B',
        lastUpdateTime: 1,
      },
      'preview',
    );

    expect(mockUseGetStartupConfig).not.toHaveBeenCalled();
    expect(mockUseGetSharedStartupConfig).not.toHaveBeenCalled();
    expect(testGlobal.artifactPreviewModuleEvaluations ?? 0).toBe(0);
    expect(testGlobal.nativeMermaidRenderer?.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        children: 'graph TD\nA-->B',
        exportFilename: 'Flow chart',
        fillContainer: true,
        showExpandButton: false,
        showHeader: false,
      }),
    );
  });

  it('previews the current Mermaid editor content', () => {
    const testGlobal = globalThis as typeof globalThis & {
      nativeMermaidRenderer?: jest.Mock;
    };
    const artifact: Artifact = {
      id: 'mermaid-persisted-1',
      type: 'application/vnd.mermaid',
      title: 'Flow chart',
      content: 'graph TD\nA-->B',
      index: 0,
      lastUpdateTime: 1,
    };

    const { rerender } = render(
      <Tabs.Root value="preview">
        <ArtifactTabs artifact={artifact} previewRef={previewRef} />
      </Tabs.Root>,
    );

    /* Editor text belongs to the preview only while it is this artifact's
     * buffer, so the ownership the editor recorded is what applies it. */
    mockCurrentCode = 'graph TD\nA-->C';
    mockCodeArtifactId = artifact.id;
    rerender(
      <Tabs.Root value="preview">
        <ArtifactTabs artifact={artifact} previewRef={previewRef} />
      </Tabs.Root>,
    );

    expect(testGlobal.nativeMermaidRenderer?.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ children: 'graph TD\nA-->C' }),
    );
  });

  it('makes chat Mermaid Artifacts read-only when they have no persisted edit target', () => {
    renderArtifact({
      id: 'mermaid-chat-1',
      type: 'application/vnd.mermaid',
      content: 'graph TD\nA-->B',
      lastUpdateTime: 1,
    });

    expect(mockEditor).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));
  });

  it('keeps persisted Mermaid Artifacts editable', () => {
    renderArtifact({
      id: 'mermaid-persisted-1',
      type: 'application/vnd.mermaid',
      content: 'graph TD\nA-->B',
      index: 0,
      messageId: 'message-1',
      lastUpdateTime: 1,
    });

    expect(mockEditor).toHaveBeenCalledWith(expect.objectContaining({ readOnly: false }));
  });

  it('remounts the renderer when switching between Mermaid Artifacts', () => {
    const first: Artifact = {
      id: 'mermaid-a',
      type: 'application/vnd.mermaid',
      title: 'First',
      content: 'graph TD\nA-->B',
      lastUpdateTime: 1,
    };
    const second: Artifact = {
      id: 'mermaid-b',
      type: 'application/vnd.mermaid',
      title: 'Second',
      content: 'graph TD\nC-->D',
      lastUpdateTime: 2,
    };

    const { rerender, getByTestId } = render(
      <Tabs.Root value="preview">
        <ArtifactTabs artifact={first} previewRef={previewRef} />
      </Tabs.Root>,
    );
    const initialInstance = getByTestId('mermaid-renderer').getAttribute('data-instance');

    rerender(
      <Tabs.Root value="preview">
        <ArtifactTabs artifact={second} previewRef={previewRef} />
      </Tabs.Root>,
    );

    expect(getByTestId('mermaid-renderer').getAttribute('data-instance')).not.toBe(initialInstance);
  });

  it('does not seed the next diagram with the previous artifact editor text', () => {
    const testGlobal = globalThis as typeof globalThis & {
      nativeMermaidRenderer?: jest.Mock;
    };
    const first: Artifact = {
      id: 'mermaid-a',
      type: 'application/vnd.mermaid',
      title: 'First',
      content: 'graph TD\nA-->B',
      index: 0,
      lastUpdateTime: 1,
    };
    const second: Artifact = {
      id: 'mermaid-b',
      type: 'application/vnd.mermaid',
      title: 'Second',
      content: 'graph TD\nC-->D',
      index: 1,
      lastUpdateTime: 2,
    };

    mockCurrentCode = 'graph TD\nEDITED-->A';
    mockCodeArtifactId = first.id;
    const { rerender } = render(
      <Tabs.Root value="preview">
        <ArtifactTabs artifact={first} previewRef={previewRef} />
      </Tabs.Root>,
    );
    testGlobal.nativeMermaidRenderer?.mockClear();
    rerender(
      <Tabs.Root value="preview">
        <ArtifactTabs artifact={second} previewRef={previewRef} />
      </Tabs.Root>,
    );

    const renderedContent = testGlobal.nativeMermaidRenderer?.mock.calls.map(
      (call) => (call[0] as { children: string }).children,
    );
    expect(renderedContent).not.toContain('graph TD\nEDITED-->A');
    expect(testGlobal.nativeMermaidRenderer?.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ children: 'graph TD\nC-->D' }),
    );
  });

  it('does not mount the Mermaid renderer on the code tab', () => {
    const testGlobal = globalThis as typeof globalThis & {
      nativeMermaidRenderer?: jest.Mock;
    };
    testGlobal.nativeMermaidRenderer?.mockClear();

    renderArtifact(
      {
        id: 'mermaid-a',
        type: 'application/vnd.mermaid',
        title: 'First',
        content: 'graph TD\nA-->B',
        lastUpdateTime: 1,
      },
      'code',
    );

    expect(testGlobal.nativeMermaidRenderer).not.toHaveBeenCalled();
  });

  it('does not remount the renderer while the same Artifact is edited', () => {
    const artifact: Artifact = {
      id: 'mermaid-a',
      type: 'application/vnd.mermaid',
      title: 'First',
      content: 'graph TD\nA-->B',
      index: 0,
      lastUpdateTime: 1,
    };

    const { rerender, getByTestId } = render(
      <Tabs.Root value="preview">
        <ArtifactTabs artifact={artifact} previewRef={previewRef} />
      </Tabs.Root>,
    );
    const initialInstance = getByTestId('mermaid-renderer').getAttribute('data-instance');

    mockCurrentCode = 'graph TD\nA-->C';
    rerender(
      <Tabs.Root value="preview">
        <ArtifactTabs artifact={{ ...artifact, lastUpdateTime: 2 }} previewRef={previewRef} />
      </Tabs.Root>,
    );

    expect(getByTestId('mermaid-renderer').getAttribute('data-instance')).toBe(initialInstance);
  });

  it('keeps non-Mermaid Artifacts on the startup-config and sandbox preview path', async () => {
    const testGlobal = globalThis as typeof globalThis & {
      artifactPreviewModuleEvaluations?: number;
    };

    renderArtifact(
      {
        id: 'html-1',
        type: 'text/html',
        content: '<h1>Hello</h1>',
        lastUpdateTime: 1,
      },
      'preview',
    );

    await waitFor(() => expect(mockUseGetStartupConfig).toHaveBeenCalledWith({ enabled: true }));
    expect(testGlobal.artifactPreviewModuleEvaluations).toBe(1);
  });
});

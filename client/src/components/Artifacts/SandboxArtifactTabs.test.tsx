import React from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { render } from '@testing-library/react';
import type { SandpackPreviewRef } from '@codesandbox/sandpack-react/unstyled';
import type { Artifact } from '~/common';
import SandboxArtifactTabs from './SandboxArtifactTabs';

interface PreviewProps {
  files: Record<string, string>;
  fileKey: string;
  currentCode?: string;
}

const mockPreview = jest.fn((_props: PreviewProps) => null);
let mockCurrentCode: string | undefined;

jest.mock('./ArtifactCodeEditor', () => ({
  ArtifactCodeEditor: () => null,
}));

jest.mock('./ArtifactPreview', () => ({
  ArtifactPreview: (props: PreviewProps) => mockPreview(props),
}));

jest.mock('~/Providers/EditorContext', () => ({
  useCodeState: () => ({ currentCode: mockCurrentCode, setCurrentCode: jest.fn() }),
}));

jest.mock('~/Providers', () => ({
  useShareContext: () => ({ shareId: undefined }),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: {} }),
  useGetSharedStartupConfig: () => ({ data: {} }),
}));

const previewRef = {
  current: Object.create(null) as SandpackPreviewRef,
} as React.MutableRefObject<SandpackPreviewRef>;

const original =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
const edited =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';

const svgArtifact: Artifact = {
  id: 'svg-artifact-1',
  type: 'image/svg+xml',
  title: 'Chart',
  content: original,
  lastUpdateTime: 1,
};

function renderTabs(artifact: Artifact = svgArtifact) {
  return render(
    <Tabs.Root value="preview">
      <SandboxArtifactTabs artifact={artifact} previewRef={previewRef} />
    </Tabs.Root>,
  );
}

function lastFiles(): Record<string, string> {
  return mockPreview.mock.calls.at(-1)?.[0].files ?? {};
}

describe('SandboxArtifactTabs SVG preview', () => {
  beforeEach(() => {
    mockCurrentCode = undefined;
    mockPreview.mockClear();
  });

  /** An SVG preview renders a derived `index.html`, so an edit that only
   * replaced `index.svg` left the preview showing the original drawing. */
  it('rebuilds the preview shell from the edited source', () => {
    const { rerender } = renderTabs();
    expect(lastFiles()['index.html']).toContain(original);

    /* Editor text belongs to the preview only once it was typed against the
     * artifact on screen, so it lands on a later render, not on mount. */
    mockCurrentCode = edited;
    rerender(
      <Tabs.Root value="preview">
        <SandboxArtifactTabs artifact={svgArtifact} previewRef={previewRef} />
      </Tabs.Root>,
    );

    const files = lastFiles();
    expect(files['index.svg']).toBe(edited);
    expect(files['index.html']).toContain(edited);
    expect(files['index.html']).not.toContain('<rect');
  });

  it('keeps the artifact source when the editor is emptied', () => {
    const { rerender } = renderTabs();

    mockCurrentCode = '';
    rerender(
      <Tabs.Root value="preview">
        <SandboxArtifactTabs artifact={svgArtifact} previewRef={previewRef} />
      </Tabs.Root>,
    );

    expect(lastFiles()['index.html']).toContain(original);
  });

  it('leaves artifacts whose preview entry is the edited file untouched', () => {
    const htmlArtifact: Artifact = {
      id: 'html-artifact-1',
      type: 'text/html',
      title: 'Page',
      content: '<p>original</p>',
      lastUpdateTime: 1,
    };

    const { rerender } = renderTabs(htmlArtifact);

    mockCurrentCode = '<p>edited</p>';
    rerender(
      <Tabs.Root value="preview">
        <SandboxArtifactTabs artifact={htmlArtifact} previewRef={previewRef} />
      </Tabs.Root>,
    );

    /* `ArtifactPreview` owns this swap; the tabs must not pre-empt it. */
    const call = mockPreview.mock.calls.at(-1)?.[0];
    expect(call?.files['index.html']).toBe('<p>original</p>');
    expect(call?.currentCode).toBe('<p>edited</p>');
  });
});

import React from 'react';
import { render } from '@testing-library/react';
import type {
  SandpackProviderProps,
  SandpackPreviewRef,
} from '@codesandbox/sandpack-react/unstyled';
import { ArtifactPreview } from '../ArtifactPreview';

const mockSandpackProvider = jest.fn(
  ({ files, children }: SandpackProviderProps & { children?: React.ReactNode }) => (
    <div data-testid="sandpack-provider" data-files={JSON.stringify(files)}>
      {children}
    </div>
  ),
);

jest.mock('@codesandbox/sandpack-react/unstyled', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  return {
    SandpackProvider: (props: SandpackProviderProps & { children?: React.ReactNode }) =>
      mockSandpackProvider(props),
    SandpackPreview: ReactModule.forwardRef(
      (_props: Record<string, unknown>, ref: React.Ref<HTMLDivElement>) => (
        <div ref={ref} data-testid="sandpack-preview" />
      ),
    ),
  };
});

describe('ArtifactPreview (#17860)', () => {
  const previewRef = { current: null } as unknown as React.MutableRefObject<SandpackPreviewRef>;

  beforeEach(() => {
    mockSandpackProvider.mockClear();
  });

  it('scopes inline classic scripts in HTML files on static template before passing to SandpackProvider', () => {
    const rawHtml = `<!DOCTYPE html>
<html>
<body>
  <script>
    let k = 1;
    const S = 2;
    class e {}
  </script>
</body>
</html>`;

    render(
      <ArtifactPreview
        files={{ 'index.html': rawHtml }}
        fileKey="index.html"
        template="static"
        sharedProps={{}}
        previewRef={previewRef}
      />,
    );

    expect(mockSandpackProvider).toHaveBeenCalled();
    const passedFiles = mockSandpackProvider.mock.calls.at(-1)?.[0].files as Record<string, string>;
    expect(passedFiles['index.html']).toContain('<script>{\n');
    expect(passedFiles['index.html']).toContain('let k = 1;');
    expect(passedFiles['index.html']).toContain('const S = 2;');
    expect(passedFiles['index.html']).toContain('class e {}');
    expect(passedFiles['index.html']).toContain('\n}</script>');
  });

  it('scopes currentCode edits for HTML artifacts on static template', () => {
    const originalHtml = '<div>original</div>';
    const editedHtml = `<div>edited</div>
<script>
let k = 5;
</script>`;

    render(
      <ArtifactPreview
        files={{ 'index.html': originalHtml }}
        fileKey="index.html"
        template="static"
        sharedProps={{}}
        previewRef={previewRef}
        currentCode={editedHtml}
      />,
    );

    expect(mockSandpackProvider).toHaveBeenCalled();
    const passedFiles = mockSandpackProvider.mock.calls.at(-1)?.[0].files as Record<
      string,
      { code: string }
    >;
    expect(passedFiles['index.html'].code).toContain('<script>{\n');
    expect(passedFiles['index.html'].code).toContain('let k = 5;');
    expect(passedFiles['index.html'].code).toContain('\n}</script>');
  });

  it('does not alter non-static templates (e.g. react-ts)', () => {
    const reactCode = 'export default function App() { return <div>React</div>; }';

    render(
      <ArtifactPreview
        files={{ 'App.tsx': reactCode }}
        fileKey="App.tsx"
        template="react-ts"
        sharedProps={{}}
        previewRef={previewRef}
      />,
    );

    expect(mockSandpackProvider).toHaveBeenCalled();
    const passedFiles = mockSandpackProvider.mock.calls.at(-1)?.[0].files as Record<string, string>;
    expect(passedFiles['App.tsx']).toBe(reactCode);
  });

  it('renders null when artifactFiles is empty', () => {
    const { container } = render(
      <ArtifactPreview
        files={{}}
        fileKey="index.html"
        template="static"
        sharedProps={{}}
        previewRef={previewRef}
      />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(mockSandpackProvider).not.toHaveBeenCalled();
  });
});

import React from 'react';
import { render, screen } from '@testing-library/react';
import type {
  SandpackProviderProps,
  SandpackPreviewRef,
} from '@codesandbox/sandpack-react/unstyled';
import { ARTIFACT_PREVIEW_BRIDGE_SCRIPT } from '~/utils/artifactPreviewCapture';
import { ArtifactPreview } from './ArtifactPreview';

const mockSandpackPreview = jest.fn(() => <div data-testid="sandpack-preview" />);
const mockSandpackProvider = jest.fn((props: SandpackProviderProps) => (
  <div data-testid="sandpack-provider">{props.children}</div>
));

jest.mock('@codesandbox/sandpack-react/unstyled', () => ({
  SandpackPreview: () => mockSandpackPreview(),
  SandpackProvider: (props: SandpackProviderProps) => mockSandpackProvider(props),
}));

describe('ArtifactPreview', () => {
  beforeEach(() => {
    mockSandpackPreview.mockClear();
    mockSandpackProvider.mockClear();
  });

  it('renders static HTML artifacts through the isolated Sandpack preview, not a local iframe', () => {
    const previewRef = {
      current: undefined,
    } as unknown as React.MutableRefObject<SandpackPreviewRef>;

    const { container } = render(
      <ArtifactPreview
        files={{ 'index.html': '<html><body><h1>Hello World!</h1></body></html>' }}
        fileKey="index.html"
        template="static"
        sharedProps={{}}
        previewRef={previewRef}
      />,
    );

    expect(screen.getByTestId('sandpack-provider')).toBeInTheDocument();
    expect(mockSandpackPreview).toHaveBeenCalled();
    expect(container.querySelector('iframe')).toBeNull();
    const providerProps = mockSandpackProvider.mock.calls[0][0];
    expect(providerProps.template).toBe('static');
    const indexFile = providerProps.files?.['index.html'];
    const code = typeof indexFile === 'string' ? indexFile : indexFile?.code;
    expect(code).toContain('<h1>Hello World!</h1>');
  });

  it('injects the preview-capture bridge into the artifact’s own index.html for the static template', () => {
    const previewRef = {
      current: undefined,
    } as unknown as React.MutableRefObject<SandpackPreviewRef>;

    render(
      <ArtifactPreview
        files={{ 'index.html': '<html><head></head><body><h1>Hello</h1></body></html>' }}
        fileKey="index.html"
        template="static"
        sharedProps={{}}
        previewRef={previewRef}
      />,
    );

    const providerProps = mockSandpackProvider.mock.calls[0][0];
    const indexFile = providerProps.files?.['index.html'];
    const code = typeof indexFile === 'string' ? indexFile : indexFile?.code;
    expect(code).toContain(ARTIFACT_PREVIEW_BRIDGE_SCRIPT);
    expect(code).toContain('<h1>Hello</h1>');
    expect(code).toBeDefined();
    expect((code as string).indexOf(ARTIFACT_PREVIEW_BRIDGE_SCRIPT)).toBeLessThan(
      (code as string).indexOf('</head>'),
    );
  });

  it('does not inject the bridge script for non-static (bundler-based) templates', () => {
    const previewRef = {
      current: undefined,
    } as unknown as React.MutableRefObject<SandpackPreviewRef>;

    render(
      <ArtifactPreview
        files={{ 'App.tsx': 'export default () => <div />;' }}
        fileKey="App.tsx"
        template="react"
        sharedProps={{}}
        previewRef={previewRef}
      />,
    );

    const providerProps = mockSandpackProvider.mock.calls[0][0];
    expect(providerProps.files).not.toHaveProperty('index.html');
    expect(providerProps.files).toMatchObject({ 'App.tsx': 'export default () => <div />;' });
  });
});

import { render, screen, waitFor } from '@testing-library/react';
import { UIResourceRenderer as LegacyUIResourceRenderer } from '@mcp-ui/client';
import type { TStartupConfig, UIResource } from 'librechat-data-provider';
import { MCPAppsPolicyProvider } from '~/Providers/MCPAppsPolicyContext';
import UIResourceRenderer from '../Renderer';

jest.mock('@mcp-ui/client', () => ({
  UIResourceRenderer: jest.fn(({ resource }) => (
    <div data-testid="legacy-ui-resource" data-mime-type={resource.mimeType} />
  )),
}));

const mockLegacyRenderer = LegacyUIResourceRenderer as jest.MockedFunction<
  typeof LegacyUIResourceRenderer
>;

const renderEnabled = (ui: React.ReactElement) =>
  render(
    <MCPAppsPolicyProvider
      startupConfig={{ mcpApps: { enabled: true, legacyHtmlEnabled: true } } as TStartupConfig}
      ready
      userId="user-1"
    >
      {ui}
    </MCPAppsPolicyProvider>,
  );

describe('UIResourceRenderer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('loads several resources inside a paragraph without invalid markup or announcements', async () => {
    /** The lazy component keeps its module once resolved, so only the first render in this file can see it pending. */
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const resources = ['first', 'second', 'third'].map(
      (id): UIResource => ({
        resourceId: id,
        uri: `ui://${id}`,
        mimeType: 'text/html',
        text: `<p>${id}</p>`,
      }),
    );

    /** Markdown places an inline resource in a span inside the paragraph that holds its marker. */
    renderEnabled(
      <p>
        <span>
          {resources.map((resource) => (
            <UIResourceRenderer key={resource.resourceId} resource={resource} />
          ))}
        </span>
      </p>,
    );

    expect(screen.getAllByText('Loading interactive view...')).toHaveLength(3);
    expect(mockLegacyRenderer).not.toHaveBeenCalled();
    /** A paragraph cannot hold a block element, and React says so when a fallback is one. */
    expect(
      consoleError.mock.calls.filter(([message]) => String(message).includes('validateDOMNesting')),
    ).toEqual([]);
    /** The viewer opened none of these, so a single load must not announce itself once per resource. */
    expect(screen.queryAllByRole('status')).toHaveLength(0);

    expect(await screen.findAllByTestId('legacy-ui-resource')).toHaveLength(3);
    expect(screen.queryByText('Loading interactive view...')).not.toBeInTheDocument();
  });

  it.each([
    'application/vnd.mcp-ui.remote-dom+javascript',
    'application/vnd.mcp-ui.remote-dom',
    'text/uri-list',
    'text/html;profile=mcp-app',
  ])('blocks MIME type %s from the legacy renderer', (mimeType) => {
    const resource: UIResource = {
      resourceId: 'unsafe-resource',
      uri: 'ui://unsafe',
      mimeType,
      text: "root.innerHTML='<img src=x onerror=alert(window.origin)>'",
    };

    const { container } = renderEnabled(<UIResourceRenderer resource={resource} />);

    expect(container).toBeEmptyDOMElement();
    expect(mockLegacyRenderer).not.toHaveBeenCalled();
  });

  it('blocks malformed non-string MIME values', () => {
    const resource: UIResource = {
      resourceId: 'malformed-resource',
      uri: 'ui://malformed',
      mimeType: 1 as unknown as string,
      text: '<p>Malformed resource</p>',
    };

    const { container } = renderEnabled(<UIResourceRenderer resource={resource} />);

    expect(container).toBeEmptyDOMElement();
    expect(mockLegacyRenderer).not.toHaveBeenCalled();
  });

  it('forces text/html through the raw HTML renderer without popup permissions', async () => {
    const resource: UIResource = {
      resourceId: 'html-resource',
      uri: 'ui://html',
      mimeType: 'text/html',
      contentType: 'remoteDom',
      text: '<p>Safe iframe content</p>',
    };

    renderEnabled(
      <UIResourceRenderer
        resource={resource}
        htmlProps={{ sandboxPermissions: 'allow-popups allow-same-origin' }}
      />,
    );

    expect(await screen.findByTestId('legacy-ui-resource')).toBeInTheDocument();
    expect(mockLegacyRenderer).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: expect.not.objectContaining({ contentType: expect.anything() }),
        htmlProps: {},
        supportedContentTypes: ['rawHtml'],
      }),
      expect.any(Object),
    );
  });

  it.each(['text/html; charset=utf-8', 'TEXT/HTML'])(
    'normalizes HTML MIME type %s',
    async (mimeType) => {
      const resource: UIResource = {
        resourceId: 'html-resource',
        uri: 'ui://html',
        mimeType,
        text: '<p>Safe iframe content</p>',
      };

      renderEnabled(<UIResourceRenderer resource={resource} />);

      await waitFor(() =>
        expect(mockLegacyRenderer).toHaveBeenCalledWith(
          expect.objectContaining({
            resource: expect.objectContaining({ mimeType: 'text/html' }),
            supportedContentTypes: ['rawHtml'],
          }),
          expect.any(Object),
        ),
      );
    },
  );

  it.each([undefined, null])(
    'defaults an absent MIME type (%s) to legacy HTML',
    async (mimeType) => {
      const resource = {
        resourceId: 'legacy-resource',
        uri: 'ui://legacy',
        mimeType,
        text: '<p>Legacy resource</p>',
      } as unknown as UIResource;

      renderEnabled(<UIResourceRenderer resource={resource} />);

      await waitFor(() =>
        expect(mockLegacyRenderer).toHaveBeenCalledWith(
          expect.objectContaining({
            resource: expect.objectContaining({ mimeType: 'text/html' }),
          }),
          expect.any(Object),
        ),
      );
    },
  );

  it('does not reinterpret an explicit empty MIME type as HTML', () => {
    const resource: UIResource = {
      resourceId: 'empty-resource',
      uri: 'ui://empty',
      mimeType: '',
      text: '<p>Explicitly untyped</p>',
    };

    const { container } = renderEnabled(<UIResourceRenderer resource={resource} />);

    expect(container).toBeEmptyDOMElement();
    expect(mockLegacyRenderer).not.toHaveBeenCalled();
  });

  it('does not invoke the legacy SDK without an enabled host policy', () => {
    const resource: UIResource = {
      resourceId: 'stored-html',
      uri: 'ui://legacy/stored',
      mimeType: 'text/html',
      text: '<p>Stored legacy view</p>',
    };

    const { container } = render(<UIResourceRenderer resource={resource} />);

    expect(container).toBeEmptyDOMElement();
    expect(mockLegacyRenderer).not.toHaveBeenCalled();
  });
});

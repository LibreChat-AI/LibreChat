import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen } from '@testing-library/react';
import type { TStartupConfig } from 'librechat-data-provider';
import { useConversationUIResources } from '~/hooks/Messages/useConversationUIResources';
import { MCPAppsPolicyProvider } from '~/Providers/MCPAppsPolicyContext';
import { UI_RESOURCE_MARKER } from '~/components/MCPUIResource/plugin';
import MarkdownLite from '../MarkdownLite';
import Markdown from '../Markdown';

// Mock specific leaf hook rather than barrel exports to avoid circular module evaluation in Jest
jest.mock('~/hooks/Messages/useConversationUIResources', () => ({
  useConversationUIResources: jest.fn(),
}));

jest.mock('@mcp-ui/client', () => ({
  UIResourceRenderer: ({ resource }: any) => (
    <span data-testid="ui-resource-renderer" data-resource-uri={resource?.uri} />
  ),
}));

const mockUseConversationUIResources = useConversationUIResources as jest.MockedFunction<
  typeof useConversationUIResources
>;

const renderMarkdown = (content: string, legacyHtmlEnabled = true) =>
  render(
    <RecoilRoot>
      <MCPAppsPolicyProvider
        startupConfig={{ mcpApps: { enabled: false, legacyHtmlEnabled } } as TStartupConfig}
        ready
      >
        <Markdown content={content} isLatestMessage={false} />
      </MCPAppsPolicyProvider>
    </RecoilRoot>,
  );

describe('Markdown with MCP UI markers (resource IDs)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders two legacy UI resources for markers with resource IDs across separate attachments', () => {
    // Two tool responses, each produced one ui_resources attachment
    const paris = {
      resourceId: 'abc123',
      uri: 'ui://weather/paris',
      mimeType: 'text/html',
      text: '<div>Paris Weather</div>',
    };
    const nyc = {
      resourceId: 'def456',
      uri: 'ui://weather/nyc',
      mimeType: 'text/html',
      text: '<div>NYC Weather</div>',
    };

    const resourceMap = new Map<string, any>([
      ['abc123', paris],
      ['def456', nyc],
    ]);
    mockUseConversationUIResources.mockReturnValue(resourceMap as any);

    const content = [
      'Here are the current weather conditions for both Paris and New York:',
      '',
      '- Paris: Slight rain, 53°F, humidity 76%, wind 9 mph.',
      '- New York: Clear sky, 63°F, humidity 91%, wind 6 mph.',
      '',
      `Browse these weather cards for more details ${UI_RESOURCE_MARKER}{abc123} ${UI_RESOURCE_MARKER}{def456}`,
    ].join('\n');

    renderMarkdown(content);

    const renderers = screen.getAllByTestId('ui-resource-renderer');
    expect(renderers).toHaveLength(2);
    expect(renderers[0]).toHaveAttribute('data-resource-uri', 'ui://weather/paris');
    expect(renderers[1]).toHaveAttribute('data-resource-uri', 'ui://weather/nyc');
  });

  it('does not mount an App View from a legacy Markdown marker', () => {
    mockUseConversationUIResources.mockReturnValue(
      new Map([
        [
          'app-resource',
          {
            resourceId: 'app-resource',
            uri: 'ui://weather/app',
            mimeType: 'text/html;profile=mcp-app',
            text: '<div>App View</div>',
            toolName: 'get_weather',
            serverName: 'weather-server',
          },
        ],
      ]) as any,
    );

    renderMarkdown(
      `App resources are rendered with their tool call ${UI_RESOURCE_MARKER}{app-resource}`,
    );

    expect(screen.queryByTestId('ui-resource-renderer')).not.toBeInTheDocument();
    expect(document.querySelector('iframe[data-sandbox-url]')).not.toBeInTheDocument();
  });

  it('does not invoke the legacy renderer for a stored marker while disabled', () => {
    mockUseConversationUIResources.mockReturnValue(
      new Map([
        [
          'legacy-resource',
          {
            resourceId: 'legacy-resource',
            uri: 'ui://weather/legacy',
            mimeType: 'text/html',
            text: '<div>Stored legacy view</div>',
          },
        ],
      ]) as never,
    );

    renderMarkdown(`Stored result ${UI_RESOURCE_MARKER}{legacy-resource}`, false);

    expect(screen.queryByTestId('ui-resource-renderer')).not.toBeInTheDocument();
    expect(screen.getByText(/Stored result/)).toBeInTheDocument();
  });
});

describe('Markdown table rendering', () => {
  const tableMarkdown = [
    '| Alpha | Bravo | Charlie | Delta | Echo | Foxtrot | Golf | Hotel |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    '| one | two | three | four | five | six | seven | eight |',
  ].join('\n');

  it('wraps GFM tables in a horizontally scrollable container', () => {
    render(
      <RecoilRoot>
        <Markdown content={tableMarkdown} isLatestMessage={false} />
      </RecoilRoot>,
    );

    expect(screen.getByRole('table').parentElement).toHaveClass(
      'markdown-table-wrapper',
      'w-full',
      'max-w-full',
    );
  });

  it('wraps lightweight Markdown tables in a horizontally scrollable container', () => {
    render(<MarkdownLite content={tableMarkdown} />);

    expect(screen.getByRole('table').parentElement).toHaveClass(
      'markdown-table-wrapper',
      'w-full',
      'max-w-full',
    );
  });
});

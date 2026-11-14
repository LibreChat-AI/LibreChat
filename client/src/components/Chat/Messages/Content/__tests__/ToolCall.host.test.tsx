import React from 'react';
import { RecoilRoot } from 'recoil';
import { Constants } from 'librechat-data-provider';
import { ToolCall } from '@librechat/chat/components';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '~/Providers/MessagePartsHostContext';

const mockBindMCPOAuth = jest.fn();
let mockServerNames: string[] = [];
let mockIconMap = new Map<string, string>();

jest.mock('~/hooks/MCP', () => ({
  ...jest.requireActual('~/hooks/MCP'),
  useMCPServerNames: () => mockServerNames,
  useMCPIconMap: () => mockIconMap,
}));

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      bindMCPOAuth: (...args: unknown[]) => mockBindMCPOAuth(...args),
    },
  };
});

function renderCard(ui: React.ReactElement) {
  return render(
    <RecoilRoot>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        {ui}
      </QueryClientProvider>
    </RecoilRoot>,
  );
}

describe('app tool call host', () => {
  beforeEach(() => {
    mockBindMCPOAuth.mockReset();
    mockServerNames = [];
    mockIconMap = new Map();
    mockBindMCPOAuth.mockResolvedValue({ success: true });
  });

  it('shows the completed label through the app progress row', () => {
    renderCard(
      <ToolCall
        args='{"test":"input"}'
        name="testFunction"
        output="Test output"
        initialProgress={1}
        isSubmitting={false}
      />,
    );

    expect(screen.getAllByText('Ran testFunction').length).toBeGreaterThan(0);
  });

  it('binds the MCP server through the app data service when sign-in appears', async () => {
    const callback = 'https://chat.example.com/api/mcp/clickhouse/oauth/callback';
    renderCard(
      <ToolCall
        args="{}"
        name={`oauth${Constants.mcp_delimiter}clickhouse`}
        output={null}
        auth={`https://mcp.example.com/authorize?redirect_uri=${encodeURIComponent(callback)}`}
        initialProgress={0.5}
        isSubmitting
      />,
    );

    await waitFor(() => expect(mockBindMCPOAuth).toHaveBeenCalledWith('clickhouse'));
  });

  it('keeps a bound sign-in prompt ready when the server catalog or icons update', async () => {
    const callback = 'https://chat.example.com/api/mcp/clickhouse/oauth/callback';
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const card = () => (
      <RecoilRoot>
        <QueryClientProvider client={client}>
          <ToolCall
            args="{}"
            name={`oauth${Constants.mcp_delimiter}clickhouse`}
            output={null}
            auth={`https://mcp.example.com/authorize?redirect_uri=${encodeURIComponent(callback)}`}
            initialProgress={0.5}
            isSubmitting
          />
        </QueryClientProvider>
      </RecoilRoot>
    );
    const { rerender } = render(card());

    const button = await screen.findByRole('button', { name: /sign-in to/i });
    await waitFor(() => expect(button).not.toHaveAttribute('aria-busy', 'true'));
    expect(mockBindMCPOAuth).toHaveBeenCalledTimes(1);

    mockServerNames = ['clickhouse'];
    mockIconMap = new Map([['clickhouse', '/icon.svg']]);
    rerender(card());

    await waitFor(() => expect(document.querySelector('img[src="/icon.svg"]')).not.toBeNull());
    const after = screen.getByRole('button', { name: /sign-in to/i });
    expect(after).not.toBeDisabled();
    expect(after).not.toHaveAttribute('aria-busy', 'true');
    expect(mockBindMCPOAuth).toHaveBeenCalledTimes(1);
  });
});

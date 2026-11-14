import React from 'react';
import { RecoilRoot } from 'recoil';
import { Constants } from 'librechat-data-provider';
import { ToolCall } from '@librechat/chat/components';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '~/Providers/MessagePartsHostContext';

const mockBindMCPOAuth = jest.fn();

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
});

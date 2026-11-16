import React from 'react';
import { RecoilRoot } from 'recoil';
import { Tools } from 'librechat-data-provider';
import { ToolCall } from '@librechat/chat/components';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { TStartupConfig } from 'librechat-data-provider';
import { MCPAppsPolicyProvider } from '~/Providers/MCPAppsPolicyContext';
import '~/Providers/MessagePartsHostContext';
import '../toolCallSlots';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string | number>) => {
    const subject = values?.[0];
    const translations: Record<string, string> = {
      com_assistants_completed_function: `Completed ${subject}`,
      com_ui_tool_calling: `Calling ${subject}`,
      com_ui_tool_preparing: `Preparing ${subject}`,
      com_assistants_running_var: `Running ${subject}`,
      com_assistants_running_action: 'Running action',
      com_ui_cancelled: 'Cancelled',
      com_ui_tool_failed: 'failed',
    };
    return translations[key] || key;
  },
}));

jest.mock('~/hooks/MCP', () => ({
  useMCPIconMap: () => new Map(),
  useMCPAppFrame: jest.requireActual('~/hooks/MCP/useMCPAppFrame').useMCPAppFrame,
  useMCPServerNames: () => [],
}));

jest.mock('~/hooks/MCP/useAppBridge', () => ({ useAppBridge: jest.fn() }));

jest.mock('~/components/Chat/Messages/Content/MessageContent', () => ({
  __esModule: true,
  default: ({ content }: { content: string }) => <div data-testid="message-content">{content}</div>,
}));

jest.mock('~/components/Chat/Messages/Content/ProgressText', () => ({
  __esModule: true,
  default: ({
    inProgressText,
    finishedText,
  }: {
    inProgressText?: string;
    finishedText?: string;
  }) => <div data-testid="progress-text">{finishedText || inProgressText}</div>,
}));

jest.mock('~/components/Chat/Messages/Content/Parts', () => ({
  AttachmentGroup: ({ attachments }: { attachments?: unknown }) => (
    <div data-testid="attachment-group">{JSON.stringify(attachments)}</div>
  ),
}));

const mockProps = {
  args: '{"test": "input"}',
  name: 'testFunction',
  output: 'Test output',
  initialProgress: 1,
  isSubmitting: false,
};

function renderWithPolicy(
  component: React.ReactElement,
  mcpApps: { enabled: boolean; legacyHtmlEnabled: boolean } = {
    enabled: true,
    legacyHtmlEnabled: true,
  },
) {
  return render(
    <RecoilRoot>
      <MCPAppsPolicyProvider startupConfig={{ mcpApps } as TStartupConfig} ready userId="user-1">
        {component}
      </MCPAppsPolicyProvider>
    </RecoilRoot>,
  );
}

describe('ToolCall MCP apps', () => {
  const originalSandboxUrl = process.env.VITE_MCP_SANDBOX_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.VITE_MCP_SANDBOX_URL = 'http://sandbox.localhost:3081/api/mcp/sandbox';
  });

  afterAll(() => {
    if (originalSandboxUrl == null) {
      delete process.env.VITE_MCP_SANDBOX_URL;
    } else {
      process.env.VITE_MCP_SANDBOX_URL = originalSandboxUrl;
    }
  });

  it('renders an iframe for an inline ui:// text resource attached to the tool call', async () => {
    const attachments = [
      {
        type: Tools.ui_resources,
        messageId: 'msg1',
        toolCallId: 'tool1',
        conversationId: 'conv1',
        [Tools.ui_resources]: [
          {
            uri: 'ui://test-server/inline.html',
            mimeType: 'text/html;profile=mcp-app',
            text: '<p>inline resource</p>',
            resourceId: 'inline-1',
            toolName: 'test-tool',
            serverName: 'test-server',
            toolArgs: { owner: 'resource' },
            content: [{ type: 'text', text: 'resource result' }],
            structuredContent: { owner: 'resource' },
          },
        ],
      },
    ];

    const { container } = renderWithPolicy(
      <ToolCall
        {...mockProps}
        args={{ owner: 'enclosing leaf' }}
        attachments={attachments as never}
      />,
    );

    expect(container.querySelector('iframe[data-sandbox-url]')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /com_ui_mcp_app_open_named/ }));
    await waitFor(() =>
      expect(container.querySelector('iframe[data-sandbox-url]')).toBeInTheDocument(),
    );
    const { useAppBridge } = jest.requireMock('~/hooks/MCP/useAppBridge') as {
      useAppBridge: jest.Mock;
    };
    expect(useAppBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        toolArgs: { owner: 'resource' },
        toolResult: expect.objectContaining({
          content: [{ type: 'text', text: 'resource result' }],
          structuredContent: { owner: 'resource' },
        }),
      }),
    );
  });

  it('keeps ordinary tool content but does not mount a stored App while disabled', () => {
    const attachments = [
      {
        type: Tools.ui_resources,
        [Tools.ui_resources]: [
          {
            uri: 'ui://test-server/stored.html',
            mimeType: 'text/html;profile=mcp-app',
            text: '<p>stored app</p>',
            resourceId: 'stored-app',
            toolName: 'test-tool',
            serverName: 'test-server',
          },
        ],
      },
    ];

    const { container } = renderWithPolicy(
      <ToolCall {...mockProps} attachments={attachments as never} />,
      { enabled: false, legacyHtmlEnabled: false },
    );

    expect(screen.getAllByText('Completed testFunction').length).toBeGreaterThan(0);
    expect(container.querySelector('iframe[data-sandbox-url]')).not.toBeInTheDocument();
    const { useAppBridge } = jest.requireMock('~/hooks/MCP/useAppBridge') as {
      useAppBridge: jest.Mock;
    };
    expect(useAppBridge).not.toHaveBeenCalled();
  });

  it('removes a mounted App when the observed policy is disabled', async () => {
    const attachments = [
      {
        type: Tools.ui_resources,
        [Tools.ui_resources]: [
          {
            uri: 'ui://test-server/live.html',
            mimeType: 'text/html;profile=mcp-app',
            text: '<p>live app</p>',
            resourceId: 'live-app',
            toolName: 'test-tool',
            serverName: 'test-server',
          },
        ],
      },
    ];
    const enabledConfig = {
      mcpApps: { enabled: true, legacyHtmlEnabled: true },
    } as TStartupConfig;
    const disabledConfig = {
      mcpApps: { enabled: false, legacyHtmlEnabled: false },
    } as TStartupConfig;
    const toolCall = <ToolCall {...mockProps} attachments={attachments as never} />;
    const { container, rerender } = render(
      <RecoilRoot>
        <MCPAppsPolicyProvider startupConfig={enabledConfig} ready userId="user-1">
          {toolCall}
        </MCPAppsPolicyProvider>
      </RecoilRoot>,
    );
    expect(container.querySelector('iframe[data-sandbox-url]')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /com_ui_mcp_app_open_named/ }));
    await waitFor(() =>
      expect(container.querySelector('iframe[data-sandbox-url]')).toBeInTheDocument(),
    );

    rerender(
      <RecoilRoot>
        <MCPAppsPolicyProvider startupConfig={disabledConfig} ready userId="user-1">
          {toolCall}
        </MCPAppsPolicyProvider>
      </RecoilRoot>,
    );

    expect(container.querySelector('iframe[data-sandbox-url]')).not.toBeInTheDocument();
    expect(screen.getAllByText('Completed testFunction').length).toBeGreaterThan(0);
  });

  it('does not mount an App when a parent attachment owner hides the leaf output', () => {
    const attachments = [
      {
        type: Tools.ui_resources,
        [Tools.ui_resources]: [
          {
            resourceId: 'hidden-app',
            uri: 'ui://demo/hidden',
            mimeType: 'text/html;profile=mcp-app',
            toolName: 'show_app',
            serverName: 'demo',
            text: '<p>Hidden App</p>',
          },
        ],
      },
    ];

    const { container } = renderWithPolicy(
      <ToolCall {...mockProps} attachments={attachments as never} hideAttachments />,
    );

    expect(container.querySelector('iframe[data-sandbox-url]')).not.toBeInTheDocument();
    const { useAppBridge } = jest.requireMock('~/hooks/MCP/useAppBridge') as {
      useAppBridge: jest.Mock;
    };
    expect(useAppBridge).not.toHaveBeenCalled();
  });
});

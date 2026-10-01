import React from 'react';
import { RecoilRoot } from 'recoil';
import { Tools, Constants, dataService } from 'librechat-data-provider';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { TStartupConfig } from 'librechat-data-provider';
import { MCPAppsPolicyProvider } from '~/Providers/MCPAppsPolicyContext';
import { ToolAuthWarningContext } from '../auth';
import ToolCall from '../ToolCall';
import { logger } from '~/utils';

// Mock dependencies
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: any) => {
    const translations: Record<string, string> = {
      com_assistants_function_use: `Used ${values?.[0]}`,
      com_assistants_completed_function: `Completed ${values?.[0]}`,
      com_assistants_completed_action: `Completed action on ${values?.[0]}`,
      com_assistants_running_var: `Running ${values?.[0]}`,
      com_assistants_running_action: 'Running action',
      com_ui_tool_preparing: `Preparing ${values?.[0]}`,
      com_ui_tool_calling: `Calling ${values?.[0]}`,
      com_ui_sign_in_to_domain: `Sign in to ${values?.[0]}`,
      com_ui_cancelled: 'Cancelled',
      com_ui_requires_auth: 'Requires authentication',
      com_assistants_allow_sites_you_trust: 'Only allow sites you trust',
      com_ui_via_server: `via ${values?.[0]}`,
      com_ui_tool_failed: 'failed',
      com_ui_tool_name_set_memory: 'Save Memory',
    };
    return translations[key] || key;
  },
  useProgress: (initialProgress: number) => (initialProgress >= 1 ? 1 : initialProgress),
  useExpandCollapse: (isExpanded: boolean) => ({
    style: {
      display: 'grid',
      gridTemplateRows: isExpanded ? '1fr' : '0fr',
      opacity: isExpanded ? 1 : 0,
    },
    ref: { current: null },
  }),
  useLazyCollapseBody: jest.requireActual('~/hooks/Messages/useLazyCollapseBody').default,
}));

jest.mock('~/hooks/MCP', () => {
  const mcpServerNames: string[] = [];
  return {
    useMCPIconMap: () => new Map(),
    useAppBridge: jest.fn(),
    useMCPAppFrame: jest.requireActual('~/hooks/MCP/useMCPAppFrame').useMCPAppFrame,
    useMCPServerNames: () => mcpServerNames,
  };
});

jest.mock('~/components/Chat/Messages/Content/MessageContent', () => ({
  __esModule: true,
  default: ({ content }: { content: string }) => <div data-testid="message-content">{content}</div>,
}));

jest.mock('../ToolCallInfo', () => ({
  __esModule: true,
  default: ({ attachments, ...props }: any) => (
    <div data-testid="tool-call-info" data-attachments={JSON.stringify(attachments)}>
      {JSON.stringify(props)}
    </div>
  ),
}));

jest.mock('../ProgressText', () => ({
  __esModule: true,
  default: ({
    onClick,
    inProgressText,
    finishedText,
    subtitle,
  }: {
    onClick?: () => void;
    inProgressText?: string;
    finishedText?: string;
    subtitle?: string;
  }) => (
    <div data-testid="progress-text" onClick={onClick}>
      {finishedText || inProgressText}
      {subtitle && <span data-testid="subtitle">{subtitle}</span>}
    </div>
  ),
}));

jest.mock('../Parts', () => ({
  AttachmentGroup: ({ attachments }: any) => (
    <div data-testid="attachment-group">{JSON.stringify(attachments)}</div>
  ),
}));

jest.mock('@librechat/client', () => {
  const DialogPart = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const DialogButton = ({
    children,
    onClick,
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
  }) => <button onClick={onClick}>{children}</button>;
  return {
    Button: ({ children, onClick, ...props }: any) => (
      <button onClick={onClick} {...props}>
        {children}
      </button>
    ),
    Spinner: (props: React.HTMLAttributes<HTMLSpanElement>) => <span {...props} />,
    AlertDialog: ({ children, open }: { children?: React.ReactNode; open: boolean }) =>
      open ? <div>{children}</div> : null,
    AlertDialogContent: DialogPart,
    AlertDialogHeader: DialogPart,
    AlertDialogTitle: DialogPart,
    AlertDialogDescription: DialogPart,
    AlertDialogFooter: DialogPart,
    AlertDialogAction: DialogButton,
    AlertDialogCancel: DialogButton,
  };
});

jest.mock('lucide-react', () => ({
  ChevronDown: () => <span>{'ChevronDown'}</span>,
  ChevronUp: () => <span>{'ChevronUp'}</span>,
  TriangleAlert: () => <span>{'TriangleAlert'}</span>,
}));

jest.mock('~/utils', () => ({
  logger: {
    error: jest.fn(),
  },
  cn: (...classes: any[]) => classes.filter(Boolean).join(' '),
  getToolDisplayLabel: (name: string, localize: (key: string) => string) =>
    name === 'set_memory' ? localize('com_ui_tool_name_set_memory') : name,
  openInNewTab: jest.requireActual('~/utils/links').openInNewTab,
}));

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      bindMCPOAuth: jest.fn(),
      bindActionOAuth: jest.fn(),
    },
  };
});

describe('ToolCall', () => {
  const originalSandboxUrl = process.env.VITE_MCP_SANDBOX_URL;
  const mockProps = {
    args: '{"test": "input"}',
    name: 'testFunction',
    output: 'Test output',
    initialProgress: 1,
    isSubmitting: false,
  };

  const renderWithRecoil = (
    component: React.ReactElement,
    mcpApps = { enabled: true, legacyHtmlEnabled: true },
  ) => {
    return render(
      <RecoilRoot>
        <MCPAppsPolicyProvider startupConfig={{ mcpApps } as TStartupConfig} ready userId="user-1">
          {component}
        </MCPAppsPolicyProvider>
      </RecoilRoot>,
    );
  };

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

  describe('tool preparation feedback', () => {
    it('announces preparation and then execution without calling the tool during argument streaming', () => {
      const props = {
        ...mockProps,
        output: null,
        initialProgress: 0.1,
        isSubmitting: true,
        toolPreparationStartedAt: 1_000,
      };
      const { rerender } = renderWithRecoil(<ToolCall {...props} />);
      expect(screen.getByText('Preparing testFunction')).toBeInTheDocument();
      rerender(
        <RecoilRoot>
          <ToolCall {...props} toolDispatchedAt={4_000} />
        </RecoilRoot>,
      );
      expect(screen.getByText('Calling testFunction')).toBeInTheDocument();
    });
  });

  describe('intent label', () => {
    it('renders a streaming intent as the live label before args are complete', () => {
      renderWithRecoil(
        <ToolCall
          {...mockProps}
          args={'{"intent":"Searching for OAuth handling in the callbac'}
          output={null}
          initialProgress={0.5}
          isSubmitting={true}
        />,
      );
      expect(
        screen.getAllByText(/Searching for OAuth handling in the callbac/).length,
      ).toBeGreaterThan(0);
      /** The aria-live region keeps its STABLE generic value while the intent
       *  streams — an atomic polite region would otherwise re-announce the
       *  whole growing sentence on every delta. */
      expect(screen.getByText('Running testFunction')).toBeInTheDocument();
    });

    it('keeps the intent as the settled label instead of the generic completion text', () => {
      renderWithRecoil(
        <ToolCall {...mockProps} args={'{"intent":"Looking up the customer record","q":"acme"}'} />,
      );
      expect(screen.getAllByText('Looking up the customer record').length).toBeGreaterThan(0);
      expect(screen.queryByText('Completed testFunction')).not.toBeInTheDocument();
    });

    it('falls back to the generic labels when args carry no intent', () => {
      renderWithRecoil(<ToolCall {...mockProps} />);
      expect(screen.getAllByText('Completed testFunction').length).toBeGreaterThan(0);
    });
  });

  it('uses a friendly label for the set_memory tool', () => {
    renderWithRecoil(<ToolCall {...mockProps} name="set_memory" />);

    expect(screen.getByTestId('progress-text')).toHaveTextContent('Completed Save Memory');
    expect(screen.queryByText(/set_memory/)).not.toBeInTheDocument();
  });

  it('keeps expanded tool content close to its header', () => {
    renderWithRecoil(<ToolCall {...mockProps} />);

    fireEvent.click(screen.getByTestId('progress-text'));

    expect(screen.getByTestId('tool-call-info').parentElement).toHaveClass('mb-2', 'mt-0');
  });

  describe('attachments prop passing', () => {
    it('should pass attachments to ToolCallInfo when provided', () => {
      const attachments = [
        {
          type: Tools.ui_resources,
          messageId: 'msg123',
          toolCallId: 'tool456',
          conversationId: 'conv789',
          [Tools.ui_resources]: {
            '0': { type: 'button', label: 'Click me' },
          },
        },
      ];

      renderWithRecoil(<ToolCall {...mockProps} attachments={attachments as any} />);

      expect(screen.getByTestId('attachment-group')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('progress-text'));

      expect(screen.getByTestId('tool-call-info')).toBeInTheDocument();
    });

    it('should render ToolCallInfo without attachment-group when no attachments', () => {
      renderWithRecoil(<ToolCall {...mockProps} />);

      expect(screen.queryByTestId('attachment-group')).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId('progress-text'));

      expect(screen.getByTestId('tool-call-info')).toBeInTheDocument();
    });

    it('should render AttachmentGroup with all attachments of mixed types', () => {
      const attachments = [
        {
          type: Tools.ui_resources,
          messageId: 'msg1',
          toolCallId: 'tool1',
          conversationId: 'conv1',
          [Tools.ui_resources]: {
            '0': { type: 'form', fields: [] },
          },
        },
        {
          type: Tools.web_search,
          messageId: 'msg2',
          toolCallId: 'tool2',
          conversationId: 'conv2',
          [Tools.web_search]: {
            results: ['result1', 'result2'],
          },
        },
      ];

      renderWithRecoil(<ToolCall {...mockProps} attachments={attachments as any} />);

      const attachmentGroup = screen.getByTestId('attachment-group');
      expect(JSON.parse(attachmentGroup.textContent!)).toEqual(attachments);
    });

    it('renders an iframe for an inline ui:// text resource attached to the tool call', () => {
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

      const { container } = renderWithRecoil(
        <ToolCall
          {...mockProps}
          args={{ owner: 'enclosing leaf' }}
          attachments={attachments as any}
        />,
      );

      // Stored results do not run App code until the viewer explicitly opens the App.
      expect(container.querySelector('iframe[data-sandbox-url]')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /com_ui_mcp_app_open_named/ }));
      const iframe = container.querySelector('iframe[data-sandbox-url]');
      expect(iframe).toBeInTheDocument();
      const { useAppBridge } = jest.requireMock('~/hooks/MCP') as { useAppBridge: jest.Mock };
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

      const { container } = renderWithRecoil(
        <ToolCall {...mockProps} attachments={attachments as never} />,
        { enabled: false, legacyHtmlEnabled: false },
      );

      expect(screen.getAllByText('Completed testFunction').length).toBeGreaterThan(0);
      expect(container.querySelector('iframe[data-sandbox-url]')).not.toBeInTheDocument();
      const { useAppBridge } = jest.requireMock('~/hooks/MCP') as { useAppBridge: jest.Mock };
      expect(useAppBridge).not.toHaveBeenCalled();
    });

    it('removes a mounted App when the observed policy is disabled', () => {
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
      expect(container.querySelector('iframe[data-sandbox-url]')).toBeInTheDocument();

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
  });

  describe('attachment group rendering', () => {
    it('should render AttachmentGroup when attachments are provided', () => {
      const attachments = [
        {
          type: Tools.ui_resources,
          messageId: 'msg123',
          toolCallId: 'tool456',
          conversationId: 'conv789',
          [Tools.ui_resources]: {
            '0': { type: 'chart', data: [] },
          },
        },
      ];

      renderWithRecoil(<ToolCall {...mockProps} attachments={attachments as any} />);

      const attachmentGroup = screen.getByTestId('attachment-group');
      expect(attachmentGroup).toBeInTheDocument();
      expect(attachmentGroup.textContent).toBe(JSON.stringify(attachments));
    });

    it('should not render AttachmentGroup when no attachments', () => {
      renderWithRecoil(<ToolCall {...mockProps} />);

      expect(screen.queryByTestId('attachment-group')).not.toBeInTheDocument();
    });

    it('should not render AttachmentGroup when attachments is empty array', () => {
      renderWithRecoil(<ToolCall {...mockProps} attachments={[]} />);

      expect(screen.queryByTestId('attachment-group')).not.toBeInTheDocument();
    });

    it('should not render AttachmentGroup when hideAttachments is true (grouped path)', () => {
      const attachments = [
        {
          type: Tools.ui_resources,
          messageId: 'msg-hide',
          toolCallId: 'tool-hide',
          conversationId: 'conv-hide',
          [Tools.ui_resources]: { '0': { type: 'chart', data: [] } },
        },
      ];

      renderWithRecoil(
        <ToolCall {...mockProps} attachments={attachments as any} hideAttachments />,
      );

      expect(screen.queryByTestId('attachment-group')).not.toBeInTheDocument();
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

      const { container } = renderWithRecoil(
        <ToolCall {...mockProps} attachments={attachments as never} hideAttachments />,
      );

      expect(container.querySelector('iframe[data-sandbox-url]')).not.toBeInTheDocument();
      const { useAppBridge } = jest.requireMock('~/hooks/MCP') as { useAppBridge: jest.Mock };
      expect(useAppBridge).not.toHaveBeenCalled();
    });

    it('should render AttachmentGroup when hideAttachments is false explicitly', () => {
      const attachments = [
        {
          type: Tools.ui_resources,
          messageId: 'msg-show',
          toolCallId: 'tool-show',
          conversationId: 'conv-show',
          [Tools.ui_resources]: { '0': { type: 'chart', data: [] } },
        },
      ];

      renderWithRecoil(
        <ToolCall {...mockProps} attachments={attachments as any} hideAttachments={false} />,
      );

      expect(screen.getByTestId('attachment-group')).toBeInTheDocument();
    });
  });

  describe('tool call info visibility', () => {
    it('should mount tool call info only after expanding via the header', () => {
      renderWithRecoil(<ToolCall {...mockProps} />);

      // Collapsed info stays unmounted until the first expansion
      expect(screen.queryByTestId('tool-call-info')).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId('progress-text'));
      expect(screen.getByTestId('tool-call-info')).toBeInTheDocument();
    });

    it('should pass input and output props to ToolCallInfo', () => {
      renderWithRecoil(<ToolCall {...mockProps} />);
      fireEvent.click(screen.getByTestId('progress-text'));

      const toolCallInfo = screen.getByTestId('tool-call-info');
      const props = JSON.parse(toolCallInfo.textContent!);

      expect(props.input).toBe('{"test": "input"}');
      expect(props.output).toBe('Test output');
    });
  });

  describe('authentication flow', () => {
    it('should show sign-in button when auth URL is provided', () => {
      const open = jest.spyOn(window, 'open').mockImplementation(() => null);
      const click = jest
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(() => undefined);

      renderWithRecoil(
        <ToolCall
          {...mockProps}
          initialProgress={0.5} // Less than 1 so it's not complete
          auth="https://auth.example.com"
          isSubmitting={true} // Should be submitting for auth to show
        />,
      );

      const signInButton = screen.getByText('Sign in to auth.example.com');
      expect(signInButton).toBeInTheDocument();

      fireEvent.click(signInButton);
      expect(click).toHaveBeenCalledTimes(1);
      const link = click.mock.instances[0] as unknown as HTMLAnchorElement;
      expect(link.href).toBe('https://auth.example.com/');
      expect(link.target).toBe('_blank');
      expect(link.rel).toBe('noopener noreferrer');
      /** A features string makes WebKit request a popup window, which iOS web apps cannot open. */
      expect(open).not.toHaveBeenCalled();

      click.mockRestore();
      open.mockRestore();
    });

    describe('MCP sign-in', () => {
      const callbackUrl = 'https://chat.example.com/api/mcp/clickhouse/oauth/callback';
      const mcpAuth = `https://mcp.example.com/authorize?redirect_uri=${encodeURIComponent(callbackUrl)}`;
      const mcpProps = {
        ...mockProps,
        name: `oauth${Constants.mcp_delimiter}clickhouse`,
        auth: mcpAuth,
        initialProgress: 0.5,
        isSubmitting: true,
      };
      let click: jest.SpyInstance;

      beforeEach(() => {
        click = jest
          .spyOn(HTMLAnchorElement.prototype, 'click')
          .mockImplementation(() => undefined);
      });

      afterEach(() => {
        click.mockRestore();
      });

      const signInButton = () => screen.getByRole('button', { name: 'Sign in to mcp.example.com' });

      it('binds when the prompt appears and opens the provider within the tap', async () => {
        (dataService.bindMCPOAuth as jest.Mock).mockResolvedValue({ success: true });
        renderWithRecoil(<ToolCall {...mcpProps} />);
        expect(dataService.bindMCPOAuth).toHaveBeenCalledWith('clickhouse');
        await waitFor(() => expect(signInButton()).toBeEnabled());

        fireEvent.click(signInButton());

        expect(click).toHaveBeenCalledTimes(1);
        expect((click.mock.instances[0] as unknown as HTMLAnchorElement).href).toBe(mcpAuth);
        expect(dataService.bindMCPOAuth).toHaveBeenCalledTimes(2);
        expect(dataService.bindMCPOAuth).toHaveBeenLastCalledWith('clickhouse');
      });

      it('claims the shared CSRF binding for the prompt the user taps', async () => {
        (dataService.bindMCPOAuth as jest.Mock).mockResolvedValue({ success: true });
        const notionCallback = 'https://chat.example.com/api/mcp/notion/oauth/callback';
        const notionAuth = `https://notion.example.com/authorize?redirect_uri=${encodeURIComponent(notionCallback)}`;
        const notionButton = () =>
          screen.getByRole('button', { name: 'Sign in to notion.example.com' });
        renderWithRecoil(
          <>
            <ToolCall {...mcpProps} />
            <ToolCall
              {...mcpProps}
              name={`oauth${Constants.mcp_delimiter}notion`}
              auth={notionAuth}
            />
          </>,
        );
        await waitFor(() => expect(signInButton()).toBeEnabled());
        await waitFor(() => expect(notionButton()).toBeEnabled());
        expect(dataService.bindMCPOAuth).toHaveBeenLastCalledWith('notion');

        fireEvent.click(signInButton());

        expect(click).toHaveBeenCalledTimes(1);
        expect((click.mock.instances[0] as unknown as HTMLAnchorElement).href).toBe(mcpAuth);
        expect(dataService.bindMCPOAuth).toHaveBeenLastCalledWith('clickhouse');
      });

      it('keeps sign-in disabled until the bind lands', async () => {
        let finishBind: (() => void) | undefined;
        (dataService.bindMCPOAuth as jest.Mock).mockReturnValue(
          new Promise((resolve) => {
            finishBind = () => resolve({ success: true });
          }),
        );
        renderWithRecoil(<ToolCall {...mcpProps} />);

        expect(signInButton()).toBeDisabled();
        expect(signInButton()).toHaveAttribute('aria-busy', 'true');
        fireEvent.click(signInButton());
        expect(click).not.toHaveBeenCalled();

        finishBind!();
        await waitFor(() => expect(signInButton()).toBeEnabled());
        fireEvent.click(signInButton());
        expect(click).toHaveBeenCalledTimes(1);
      });

      it('retries a failed bind on tap instead of opening the provider', async () => {
        (dataService.bindMCPOAuth as jest.Mock)
          .mockRejectedValueOnce(new Error('bind failed'))
          .mockResolvedValue({ success: true });
        renderWithRecoil(<ToolCall {...mcpProps} />);
        await waitFor(() => expect(logger.error).toHaveBeenCalled());
        await waitFor(() => expect(signInButton()).toBeEnabled());

        fireEvent.click(signInButton());

        expect(click).not.toHaveBeenCalled();
        expect(screen.getByRole('alert')).toHaveTextContent('com_ui_oauth_error_generic');
        await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
        expect(dataService.bindMCPOAuth).toHaveBeenCalledTimes(2);
        await waitFor(() => expect(signInButton()).toBeEnabled());

        fireEvent.click(signInButton());
        expect(click).toHaveBeenCalledTimes(1);
      });
    });

    it('should not show auth section when cancelled', () => {
      renderWithRecoil(
        <ToolCall
          {...mockProps}
          auth="https://auth.example.com"
          initialProgress={0.5}
          isSubmitting={false} // Not submitting + progress < 1 = cancelled
        />,
      );

      expect(screen.queryByText('Sign in to auth.example.com')).not.toBeInTheDocument();
    });

    it('should not show auth section when progress is complete', () => {
      renderWithRecoil(
        <ToolCall
          {...mockProps}
          auth="https://auth.example.com"
          initialProgress={1}
          isSubmitting={false}
        />,
      );

      expect(screen.queryByText('Sign in to auth.example.com')).not.toBeInTheDocument();
    });
  });

  describe('edge cases', () => {
    it('should handle undefined args', () => {
      renderWithRecoil(<ToolCall {...mockProps} args={undefined as any} />);
      fireEvent.click(screen.getByTestId('progress-text'));

      const toolCallInfo = screen.getByTestId('tool-call-info');
      const props = JSON.parse(toolCallInfo.textContent!);
      expect(props.input).toBe('');
    });

    it('should handle null output', () => {
      renderWithRecoil(<ToolCall {...mockProps} output={null} />);
      fireEvent.click(screen.getByTestId('progress-text'));

      const toolCallInfo = screen.getByTestId('tool-call-info');
      const props = JSON.parse(toolCallInfo.textContent!);
      expect(props.output).toBeNull();
    });

    it('should handle simple function name without domain', () => {
      renderWithRecoil(<ToolCall {...mockProps} name="simpleName" />);
      fireEvent.click(screen.getByTestId('progress-text'));

      expect(screen.getByTestId('tool-call-info')).toBeInTheDocument();
    });

    it('should render AttachmentGroup with complex nested attachments', () => {
      const complexAttachments = [
        {
          type: Tools.ui_resources,
          messageId: 'msg123',
          toolCallId: 'tool456',
          conversationId: 'conv789',
          [Tools.ui_resources]: {
            '0': {
              type: 'nested',
              data: {
                deep: {
                  value: 'test',
                  array: [1, 2, 3],
                  object: { key: 'value' },
                },
              },
            },
          },
        },
      ];

      renderWithRecoil(<ToolCall {...mockProps} attachments={complexAttachments as any} />);

      const attachmentGroup = screen.getByTestId('attachment-group');
      expect(JSON.parse(attachmentGroup.textContent!)).toEqual(complexAttachments);
    });
  });

  describe('MCP OAuth detection', () => {
    const d = Constants.mcp_delimiter;

    it('shows the trust warning for an ungrouped authentication call', () => {
      renderWithRecoil(
        <ToolCall
          {...mockProps}
          initialProgress={0.5}
          isSubmitting={true}
          output=""
          auth="https://auth.example.com"
        />,
      );

      expect(
        screen.getByRole('button', { name: 'Sign in to auth.example.com' }),
      ).toBeInTheDocument();
      expect(screen.getByText('Only allow sites you trust')).toBeInTheDocument();
    });

    it('keeps the sign-in action while a group suppresses the repeated warning', () => {
      renderWithRecoil(
        <ToolAuthWarningContext.Provider value>
          <ToolCall
            {...mockProps}
            initialProgress={0.5}
            isSubmitting={true}
            output=""
            auth="https://auth.example.com"
          />
        </ToolAuthWarningContext.Provider>,
      );

      expect(
        screen.getByRole('button', { name: 'Sign in to auth.example.com' }),
      ).toBeInTheDocument();
      expect(screen.queryByText('Only allow sites you trust')).not.toBeInTheDocument();
    });

    it('should detect MCP OAuth from delimiter in tool-call name', () => {
      renderWithRecoil(
        <ToolCall
          {...mockProps}
          name={`oauth${d}my-server`}
          initialProgress={0.5}
          isSubmitting={true}
          auth="https://auth.example.com"
        />,
      );
      const subtitle = screen.getByTestId('subtitle');
      expect(subtitle.textContent).toBe('via my-server');
    });

    it('should preserve full server name when it contains the delimiter substring', () => {
      renderWithRecoil(
        <ToolCall
          {...mockProps}
          name={`oauth${d}foo${d}bar`}
          initialProgress={0.5}
          isSubmitting={true}
          auth="https://auth.example.com"
        />,
      );
      const subtitle = screen.getByTestId('subtitle');
      expect(subtitle.textContent).toBe(`via foo${d}bar`);
    });

    it('should display server name (not "oauth") as function_name for OAuth tool calls', () => {
      renderWithRecoil(
        <ToolCall
          {...mockProps}
          name={`oauth${d}my-server`}
          initialProgress={1}
          isSubmitting={false}
          output="done"
          auth="https://auth.example.com"
        />,
      );
      const progressText = screen.getByTestId('progress-text');
      expect(progressText.textContent).toContain('Completed my-server');
      expect(progressText.textContent).not.toContain('Completed oauth');
    });

    it('should display server name even when auth is cleared (post-completion)', () => {
      // After OAuth completes, createOAuthEnd re-emits the toolCall without auth.
      // The display should still show the server name, not literal "oauth".
      renderWithRecoil(
        <ToolCall
          {...mockProps}
          name={`oauth${d}my-server`}
          initialProgress={1}
          isSubmitting={false}
          output="done"
        />,
      );
      const progressText = screen.getByTestId('progress-text');
      expect(progressText.textContent).toContain('Completed my-server');
      expect(progressText.textContent).not.toContain('Completed oauth');
    });

    it('should fallback to auth URL redirect_uri when name lacks delimiter', () => {
      const authUrl =
        'https://oauth.example.com/authorize?redirect_uri=' +
        encodeURIComponent('https://app.example.com/api/mcp/my-server/oauth/callback');
      renderWithRecoil(
        <ToolCall
          {...mockProps}
          name="bare_name"
          initialProgress={0.5}
          isSubmitting={true}
          auth={authUrl}
        />,
      );
      const subtitle = screen.getByTestId('subtitle');
      expect(subtitle.textContent).toBe('via my-server');
    });

    it('should display server name (not raw tool-call ID) in fallback path finished text', () => {
      const authUrl =
        'https://oauth.example.com/authorize?redirect_uri=' +
        encodeURIComponent('https://app.example.com/api/mcp/my-server/oauth/callback');
      renderWithRecoil(
        <ToolCall
          {...mockProps}
          name="bare_name"
          initialProgress={1}
          isSubmitting={false}
          output="done"
          auth={authUrl}
        />,
      );
      const progressText = screen.getByTestId('progress-text');
      expect(progressText.textContent).toContain('Completed my-server');
      expect(progressText.textContent).not.toContain('bare_name');
    });

    it('should show normalized server name when it contains _mcp_ after prefixing', () => {
      // Server named oauth@mcp@server normalizes to oauth_mcp_server,
      // gets prefixed to oauth_mcp_oauth_mcp_server. Client parses:
      // func="oauth", server="oauth_mcp_server". Visually awkward but
      // semantically correct — the normalized name IS oauth_mcp_server.
      renderWithRecoil(
        <ToolCall
          {...mockProps}
          name={`oauth${d}oauth${d}server`}
          initialProgress={0.5}
          isSubmitting={true}
          auth="https://auth.example.com"
        />,
      );
      const subtitle = screen.getByTestId('subtitle');
      expect(subtitle.textContent).toBe(`via oauth${d}server`);
    });

    it('should not misidentify non-MCP action auth as MCP via fallback', () => {
      const authUrl =
        'https://oauth.example.com/authorize?redirect_uri=' +
        encodeURIComponent('https://app.example.com/api/actions/xyz/oauth/callback');
      renderWithRecoil(
        <ToolCall
          {...mockProps}
          name="action_name"
          initialProgress={0.5}
          isSubmitting={true}
          auth={authUrl}
        />,
      );
      expect(screen.queryByTestId('subtitle')).not.toBeInTheDocument();
    });
  });

  describe('A11Y-04: screen reader status announcements', () => {
    it('includes sr-only aria-live region for status announcements', () => {
      renderWithRecoil(
        <ToolCall
          {...mockProps}
          initialProgress={1}
          isSubmitting={false}
          name="test_func"
          output="result"
        />,
      );

      const liveRegion = document.querySelector('[aria-live="polite"]');
      expect(liveRegion).not.toBeNull();
      expect(liveRegion!.className).toContain('sr-only');
    });
  });
});

describe('ToolCall failure fast path', () => {
  const failedProps = {
    args: '{"url":"https://x"}',
    name: 'fetch_page',
    output: 'Error: tool call failed: HTTP 429 from github.com\nretry after 60',
    initialProgress: 1,
    isSubmitting: false,
  };

  it('spends the subtitle on the first line of the error', () => {
    render(
      <RecoilRoot>
        <ToolCall {...failedProps} />
      </RecoilRoot>,
    );
    expect(screen.getByTestId('subtitle')).toHaveTextContent('HTTP 429 from github.com');
  });
});

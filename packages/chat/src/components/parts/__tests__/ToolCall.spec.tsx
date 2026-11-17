/**
 * @jest-environment jsdom
 */
import React from 'react';
import { Tools, Constants } from 'librechat-data-provider';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { ToolCallChrome } from '../../../react/host';
import {
  LoneGroupContext,
  SoleToolContext,
  GeneratedToolLabelContext,
} from '../../../react/parts/disclosure';
import { createMessagePartsHost } from '../../../__fixtures__/partsHost';
import { translate } from '../../../__fixtures__/toolCallLocale';
import { MessagePartsHostProvider } from '../../../react/host';
import { ToolAuthWarningContext } from '../auth';
import ToolCall from '../ToolCall';

jest.mock('@librechat/client', () => {
  const { translate: localize } = jest.requireActual(
    '../../../__fixtures__/toolCallLocale',
  ) as typeof import('../../../__fixtures__/toolCallLocale');
  return {
    ...jest.requireActual('@librechat/client'),
    useLocalize: () => localize,
  };
});

const bindMCPOAuth = jest.fn();
const bindActionOAuth = jest.fn();
const logError = jest.fn();

/** Same anchor the app's openInNewTab uses, so the sign-in tests still see the click. */
function openUrl(url: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function ProgressStub({
  onClick,
  inProgressText,
  finishedText,
  subtitle,
}: {
  onClick?: () => void;
  inProgressText?: string;
  finishedText?: string;
  subtitle?: string;
}) {
  return (
    <div data-testid="progress-text" onClick={onClick}>
      {finishedText || inProgressText}
      {subtitle ? <span data-testid="subtitle">{subtitle}</span> : null}
    </div>
  );
}

function InfoStub(props: { input: string; output?: string | null }) {
  return <div data-testid="tool-call-info">{JSON.stringify(props)}</div>;
}

function AttachmentStub({ attachments }: { attachments?: unknown }) {
  return <div data-testid="attachment-group">{JSON.stringify(attachments)}</div>;
}

const chrome: ToolCallChrome = {
  localize: translate,
  mcpServerNames: [],
  mcpIconUrl: () => undefined,
  bindMCPOAuth,
  bindActionOAuth,
  openUrl,
  logError,
  renderProgress: (props) => <ProgressStub {...props} />,
  renderInfo: (props) => <InfoStub input={props.input} output={props.output} />,
  renderIcon: () => null,
  renderAttachments: (attachments) => <AttachmentStub attachments={attachments} />,
};

function Host({
  children,
  autoExpand = false,
}: {
  children: React.ReactNode;
  autoExpand?: boolean;
}): React.ReactElement {
  return (
    <MessagePartsHostProvider
      host={createMessagePartsHost({
        useAutoExpandTools: () => autoExpand,
        useToolCallChrome: () => chrome,
      })}
    >
      {children}
    </MessagePartsHostProvider>
  );
}

describe('ToolCall', () => {
  const mockProps = {
    args: '{"test": "input"}',
    name: 'testFunction',
    output: 'Test output',
    initialProgress: 1,
    isSubmitting: false,
  };

  const renderWithRecoil = (component: React.ReactElement) => render(<Host>{component}</Host>);

  beforeEach(() => {
    jest.clearAllMocks();
    bindMCPOAuth.mockResolvedValue({ success: true });
    bindActionOAuth.mockResolvedValue({ success: true });
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
        <Host>
          <ToolCall {...props} toolDispatchedAt={4_000} />
        </Host>,
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
       *  streams. An atomic polite region would otherwise re-announce the
       *  whole growing sentence on every delta. */
      expect(screen.getByText('Preparing testFunction')).toBeInTheDocument();
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

      renderWithRecoil(<ToolCall {...mockProps} attachments={attachments as never} />);

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

      renderWithRecoil(<ToolCall {...mockProps} attachments={attachments as never} />);

      const attachmentGroup = screen.getByTestId('attachment-group');
      expect(JSON.parse(attachmentGroup.textContent!)).toEqual(attachments);
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

      renderWithRecoil(<ToolCall {...mockProps} attachments={attachments as never} />);

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
        <ToolCall {...mockProps} attachments={attachments as never} hideAttachments />,
      );

      expect(screen.queryByTestId('attachment-group')).not.toBeInTheDocument();
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
        <ToolCall {...mockProps} attachments={attachments as never} hideAttachments={false} />,
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
        bindMCPOAuth.mockResolvedValue({ success: true });
        renderWithRecoil(<ToolCall {...mcpProps} />);
        expect(bindMCPOAuth).toHaveBeenCalledWith('clickhouse');
        await waitFor(() => expect(signInButton()).toBeEnabled());

        fireEvent.click(signInButton());

        expect(click).toHaveBeenCalledTimes(1);
        expect((click.mock.instances[0] as unknown as HTMLAnchorElement).href).toBe(mcpAuth);
        expect(bindMCPOAuth).toHaveBeenCalledTimes(2);
        expect(bindMCPOAuth).toHaveBeenLastCalledWith('clickhouse');
      });

      it('claims the shared CSRF binding for the prompt the user taps', async () => {
        bindMCPOAuth.mockResolvedValue({ success: true });
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
        expect(bindMCPOAuth).toHaveBeenLastCalledWith('notion');

        fireEvent.click(signInButton());

        expect(click).toHaveBeenCalledTimes(1);
        expect((click.mock.instances[0] as unknown as HTMLAnchorElement).href).toBe(mcpAuth);
        expect(bindMCPOAuth).toHaveBeenLastCalledWith('clickhouse');
      });

      it('keeps sign-in disabled until the bind lands', async () => {
        let finishBind: (() => void) | undefined;
        bindMCPOAuth.mockReturnValue(
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
        bindMCPOAuth
          .mockRejectedValueOnce(new Error('bind failed'))
          .mockResolvedValue({ success: true });
        renderWithRecoil(<ToolCall {...mcpProps} />);
        await waitFor(() => expect(logError).toHaveBeenCalled());
        await waitFor(() => expect(signInButton()).toBeEnabled());

        fireEvent.click(signInButton());

        expect(click).not.toHaveBeenCalled();
        expect(screen.getByRole('alert')).toHaveTextContent('com_ui_oauth_error_generic');
        await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
        expect(bindMCPOAuth).toHaveBeenCalledTimes(2);
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
      renderWithRecoil(<ToolCall {...mockProps} args={undefined as never} />);
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

      renderWithRecoil(<ToolCall {...mockProps} attachments={complexAttachments as never} />);

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
      // semantically correct. The normalized name IS oauth_mcp_server.
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
      <Host>
        <ToolCall {...failedProps} />
      </Host>,
    );
    expect(screen.getByTestId('subtitle')).toHaveTextContent('HTTP 429 from github.com');
  });
});

describe('ToolCall sole tool disclosure', () => {
  it('keeps the row of an only MCP call, the one place its function name shows', () => {
    render(
      <Host>
        <SoleToolContext.Provider value>
          <ToolCall
            args='{"query":"weather"}'
            name="search_documents_mcp_Workspace"
            output="sunny"
            initialProgress={1}
            isSubmitting={false}
          />
        </SoleToolContext.Provider>
      </Host>,
    );
    expect(screen.getByTestId('tool-call')).toBeInTheDocument();
  });

  it('drops its row when its group holds one call inside a phase of several', () => {
    render(
      <Host>
        <SoleToolContext.Provider value={false}>
          <LoneGroupContext.Provider value>
            <ToolCall
              args='{"query":"weather"}'
              name="lookup"
              output="sunny"
              initialProgress={1}
              isSubmitting={false}
            />
          </LoneGroupContext.Provider>
        </SoleToolContext.Provider>
      </Host>,
    );
    expect(screen.queryByTestId('tool-call')).not.toBeInTheDocument();
    expect(screen.getByTestId('tool-call-info')).toBeInTheDocument();
  });

  it.each([['{}'], ['[]']])(
    'keeps the row of an only call whose arguments are %s and output is empty',
    (args) => {
      render(
        <Host>
          <SoleToolContext.Provider value>
            <ToolCall
              args={args}
              name="lookup"
              output=""
              initialProgress={1}
              isSubmitting={false}
              runStepStatus="completed"
            />
          </SoleToolContext.Provider>
        </Host>,
      );
      expect(screen.getByTestId('tool-call')).toBeInTheDocument();
    },
  );

  it('keeps the row of an only call whose output is only whitespace', () => {
    render(
      <Host>
        <SoleToolContext.Provider value>
          <ToolCall
            args="{}"
            name="lookup"
            output={'  \n '}
            initialProgress={1}
            isSubmitting={false}
            runStepStatus="completed"
          />
        </SoleToolContext.Provider>
      </Host>,
    );
    expect(screen.getByTestId('tool-call')).toBeInTheDocument();
  });

  it('keeps the row of an only call whose output blocks render as empty text', () => {
    render(
      <Host>
        <SoleToolContext.Provider value>
          <ToolCall
            args="{}"
            name="lookup"
            output={JSON.stringify([{ type: 'text', text: '  ' }])}
            initialProgress={1}
            isSubmitting={false}
            runStepStatus="completed"
          />
        </SoleToolContext.Provider>
      </Host>,
    );
    expect(screen.getByTestId('tool-call')).toBeInTheDocument();
  });

  it('keeps the row of an only call that is still running', () => {
    render(
      <Host>
        <SoleToolContext.Provider value>
          <ToolCall
            args='{"query":"weather"}'
            name="lookup"
            output=""
            initialProgress={0.5}
            isSubmitting
          />
        </SoleToolContext.Provider>
      </Host>,
    );
    expect(screen.getByTestId('tool-call')).toBeInTheDocument();
  });

  it('keeps the row of an only call that carries a model-authored intent', () => {
    render(
      <Host>
        <SoleToolContext.Provider value>
          <ToolCall
            args='{"intent":"Look up the weather","query":"weather"}'
            name="lookup"
            output="sunny"
            initialProgress={1}
            isSubmitting={false}
          />
        </SoleToolContext.Provider>
      </Host>,
    );
    expect(screen.getByTestId('tool-call')).toBeInTheDocument();
  });

  it('keeps the row of an only action call, which names the operation and domain', () => {
    render(
      <Host>
        <SoleToolContext.Provider value>
          <ToolCall
            args='{"query":"weather"}'
            name="get_weather_action_api---example---com"
            output="sunny"
            initialProgress={1}
            isSubmitting={false}
          />
        </SoleToolContext.Provider>
      </Host>,
    );
    expect(screen.getByTestId('tool-call')).toBeInTheDocument();
  });

  it('drops its own row once the only call has settled, leaving the info panel', () => {
    render(
      <Host>
        <SoleToolContext.Provider value>
          <ToolCall
            args='{"query":"weather"}'
            name="lookup"
            output="sunny"
            initialProgress={1}
            isSubmitting={false}
          />
        </SoleToolContext.Provider>
      </Host>,
    );
    expect(screen.queryByTestId('tool-call')).not.toBeInTheDocument();
    expect(screen.getByTestId('tool-call-info')).toBeInTheDocument();
  });

  it('opens the only call of a group when it returned no output but has arguments', () => {
    const { container } = render(
      <Host>
        <SoleToolContext.Provider value>
          <ToolCall
            args='{"query":"weather"}'
            name="lookup"
            output=""
            initialProgress={1}
            isSubmitting={false}
          />
        </SoleToolContext.Provider>
      </Host>,
    );
    const panel = container.querySelector('[style*="--tool-expand-rows"]') as HTMLElement;
    expect(panel.style.getPropertyValue('--tool-expand-rows')).toBe('1fr');
    expect(screen.getByTestId('tool-call-info')).toBeInTheDocument();
  });

  it('keeps the preference opening a call only once it has output', () => {
    const { container } = render(
      <Host autoExpand>
        <ToolCall
          args='{"query":"weather"}'
          name="lookup"
          output=""
          initialProgress={1}
          isSubmitting={false}
        />
      </Host>,
    );
    const panel = container.querySelector('[style*="--tool-expand-rows"]') as HTMLElement;
    expect(panel.style.getPropertyValue('--tool-expand-rows')).toBe('0fr');
  });
});

describe('generated single-tool label', () => {
  it.each(['search_documents_mcp_Workspace', 'get_weather_action_api---example---com', 'lookup'])(
    'replaces the completed %s row with its panel',
    (name) => {
      render(
        <Host>
          <GeneratedToolLabelContext.Provider value>
            <ToolCall
              name={name}
              args='{"intent":"Check weather","query":"weather"}'
              output="sunny"
              initialProgress={1}
              isSubmitting={false}
            />
          </GeneratedToolLabelContext.Provider>
        </Host>,
      );
      expect(screen.queryByTestId('tool-call')).not.toBeInTheDocument();
    },
  );
  it('keeps the output available without a second disclosure', () => {
    render(
      <Host>
        <GeneratedToolLabelContext.Provider value>
          <ToolCall
            name="search_documents_mcp_Workspace"
            args='{"query":"weather"}'
            output="sunny"
            initialProgress={1}
            isSubmitting={false}
          />
        </GeneratedToolLabelContext.Provider>
      </Host>,
    );
    expect(screen.getByTestId('tool-call-info')).toBeInTheDocument();
  });
});

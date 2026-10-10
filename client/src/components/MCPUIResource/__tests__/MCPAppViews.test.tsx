import React from 'react';
import { Tools } from 'librechat-data-provider';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { TAttachment, TStartupConfig, UIResource } from 'librechat-data-provider';
import type { MCPAppFrameState } from '~/hooks/MCP';
import { MCPAppsPolicyProvider } from '~/Providers/MCPAppsPolicyContext';
import { MCPAppSuppressionContext, MCPAppViews } from '../MCPAppViews';
import { useAppBridge, useMCPAppFrame } from '~/hooks/MCP';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<number, string>) => {
    if (key === 'com_ui_mcp_app_frame_title') return `MCP App: ${values?.[0] ?? ''}`;
    if (key === 'com_ui_mcp_app_open_named' || key === 'com_ui_mcp_app_close_named') {
      return `${key} ${values?.[0]} (${values?.[1]})`;
    }
    return key;
  },
}));

jest.mock('~/hooks/MCP', () => ({
  useAppBridge: jest.fn(),
  useMCPAppFrame: jest.fn(),
}));

const mockUseAppBridge = useAppBridge as jest.MockedFunction<typeof useAppBridge>;
const mockUseMCPAppFrame = useMCPAppFrame as jest.MockedFunction<typeof useMCPAppFrame>;

const enabledConfig = {
  mcpApps: { enabled: true, legacyHtmlEnabled: true },
} as TStartupConfig;

function app(overrides: Partial<UIResource>): UIResource {
  return {
    resourceId: 'shared-resource',
    uri: 'ui://demo/view',
    mimeType: 'text/html;profile=mcp-app',
    toolName: 'show_app',
    serverName: 'demo',
    text: '<p>view</p>',
    ...overrides,
  };
}

function makeFrameState(
  resource: UIResource,
  toolArgs?: string | Record<string, unknown>,
  overrides: Partial<MCPAppFrameState> = {},
): MCPAppFrameState {
  const { buildAppToolResult } = jest.requireActual('~/utils/mcpApps');
  return {
    iframeRef: { current: null },
    status: 'ready',
    kind: 'app',
    height: 320,
    attempt: 0,
    canRetry: false,
    sandboxUrl: 'http://sandbox.localhost:3081/api/mcp/sandbox',
    inlineHtml: resource.text,
    toolArgs: typeof toolArgs === 'string' ? undefined : toolArgs,
    toolResult: buildAppToolResult(resource),
    active: true,
    onSizeChanged: jest.fn(),
    onLoaded: jest.fn(),
    onTeardown: jest.fn(),
    onFailed: jest.fn(),
    onRetry: jest.fn(),
    ...overrides,
  };
}

function attachment(
  owner: { toolCallId: string; agentId: string; stepId: string },
  resources: UIResource[],
): TAttachment {
  return {
    type: Tools.ui_resources,
    ...owner,
    [Tools.ui_resources]: resources,
  } as unknown as TAttachment;
}

describe('MCPAppViews', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseMCPAppFrame.mockImplementation((resource, options) =>
      makeFrameState(resource as UIResource, options.toolArgs),
    );
  });

  it('does not create frame or bridge hooks without both policy and host identity', () => {
    const attachments = [
      attachment({ toolCallId: 'call-1', agentId: 'agent-1', stepId: 'step-1' }, [
        app({ toolArgs: { owner: 'one' } }),
      ]),
    ];

    const { container } = render(
      <MCPAppsPolicyProvider startupConfig={enabledConfig} ready>
        <MCPAppViews attachments={attachments} />
      </MCPAppsPolicyProvider>,
    );

    expect(container).toBeEmptyDOMElement();
    expect(mockUseMCPAppFrame).not.toHaveBeenCalled();
    expect(mockUseAppBridge).not.toHaveBeenCalled();
  });

  it('retains every wrapper occurrence and gives each App only its own input and result', () => {
    const alpha = app({
      toolArgs: { owner: 'alpha' },
      content: [{ type: 'text', text: 'alpha result' }],
      structuredContent: { owner: 'alpha' },
    });
    const beta = app({
      toolArgs: { owner: 'beta' },
      content: [{ type: 'text', text: 'beta result' }],
      structuredContent: { owner: 'beta' },
    });
    const attachments = [
      attachment({ toolCallId: 'call-0', agentId: 'agent-alpha', stepId: 'step-alpha' }, [alpha]),
      attachment({ toolCallId: 'call-0', agentId: 'agent-beta', stepId: 'step-beta' }, [beta]),
    ];

    const { container } = render(
      <MCPAppsPolicyProvider startupConfig={enabledConfig} ready userId="user-1">
        <MCPAppViews attachments={attachments} />
      </MCPAppsPolicyProvider>,
    );

    expect(container.querySelectorAll('iframe[data-sandbox-url]')).toHaveLength(0);
    expect(mockUseAppBridge).not.toHaveBeenCalled();
    screen.getAllByRole('button', { name: /com_ui_mcp_app_open_named/ }).forEach(fireEvent.click);
    expect(container.querySelectorAll('iframe[data-sandbox-url]')).toHaveLength(2);
    expect(mockUseAppBridge).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        resource: alpha,
        userId: 'user-1',
        toolArgs: { owner: 'alpha' },
        toolResult: expect.objectContaining({
          content: [{ type: 'text', text: 'alpha result' }],
          structuredContent: { owner: 'alpha' },
        }),
      }),
    );
    expect(mockUseAppBridge).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        resource: beta,
        userId: 'user-1',
        toolArgs: { owner: 'beta' },
        toolResult: expect.objectContaining({
          content: [{ type: 'text', text: 'beta result' }],
          structuredContent: { owner: 'beta' },
        }),
      }),
    );
  });

  it('gives duplicate App buttons distinct accessible names', () => {
    const attachments = [
      attachment({ toolCallId: 'dup', agentId: 'agent', stepId: 'step' }, [
        app({ resourceId: 'one' }),
        app({ resourceId: 'two' }),
      ]),
    ];
    const view = render(
      <MCPAppsPolicyProvider startupConfig={enabledConfig} ready userId="user-1">
        <MCPAppViews attachments={attachments} />
      </MCPAppsPolicyProvider>,
    );
    const buttons = view.getAllByRole('button', { name: /com_ui_mcp_app_open_named/ });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveAccessibleName('com_ui_mcp_app_open_named show_app (1)');
    expect(buttons[1]).toHaveAccessibleName('com_ui_mcp_app_open_named show_app (2)');
    fireEvent.click(buttons[0]);
    expect(view.getByRole('button', { name: /com_ui_mcp_app_close_named/ })).toBeInTheDocument();
  });

  it('applies the published limit to all Views and clears failed capacity notices on release', () => {
    const config = {
      mcpApps: { enabled: true, legacyHtmlEnabled: true, maxActiveViews: 1 },
    } as TStartupConfig;
    const attachments = [
      attachment({ toolCallId: 'bounded', agentId: 'agent', stepId: 'step' }, [
        app({ resourceId: 'first' }),
        app({ resourceId: 'second' }),
      ]),
    ];
    const view = render(
      <MCPAppsPolicyProvider startupConfig={config} ready userId="user-1">
        <MCPAppViews attachments={attachments} />
      </MCPAppsPolicyProvider>,
    );
    const buttons = view.getAllByRole('button', { name: /com_ui_mcp_app_open_named/ });
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);
    expect(view.getByRole('alert')).toHaveTextContent('com_ui_mcp_app_at_capacity');
    fireEvent.click(view.getByRole('button', { name: /com_ui_mcp_app_close_named/ }));
    expect(view.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(view.getAllByRole('button', { name: /com_ui_mcp_app_open_named/ })[1]);
    expect(view.container.querySelectorAll('iframe[data-sandbox-url]')).toHaveLength(1);
  });

  it('returns keyboard focus to the replacement App control without stealing focus on peer teardown', () => {
    const attachments = [
      attachment({ toolCallId: 'focus', agentId: 'agent', stepId: 'step' }, [app({})]),
    ];
    const view = render(
      <MCPAppsPolicyProvider startupConfig={enabledConfig} ready userId="user-1">
        <MCPAppViews attachments={attachments} />
      </MCPAppsPolicyProvider>,
    );
    const open = view.getByRole('button', { name: /com_ui_mcp_app_open_named/ });
    open.focus();
    fireEvent.click(open);
    const close = view.getByRole('button', { name: /com_ui_mcp_app_close_named/ });
    expect(close).toHaveFocus();
    fireEvent.click(close);
    expect(view.getByRole('button', { name: /com_ui_mcp_app_open_named/ })).toHaveFocus();

    fireEvent.click(view.getByRole('button', { name: /com_ui_mcp_app_open_named/ }));
    view.getByRole('button', { name: /com_ui_mcp_app_close_named/ }).focus();
    act(() => {
      mockUseAppBridge.mock.calls.at(-1)?.[0].onTeardown?.();
    });
    expect(view.getByRole('button', { name: /com_ui_mcp_app_open_named/ })).toHaveFocus();

    fireEvent.click(view.getByRole('button', { name: /com_ui_mcp_app_open_named/ }));
    const unrelated = document.createElement('button');
    document.body.appendChild(unrelated);
    unrelated.focus();
    act(() => {
      mockUseAppBridge.mock.calls.at(-1)?.[0].onTeardown?.();
    });
    expect(unrelated).toHaveFocus();
    expect(view.getByRole('button', { name: /com_ui_mcp_app_open_named/ })).toBeInTheDocument();
    unrelated.remove();
  });

  it('does not reserve capacity or mount a bridge for a read-only URI-only App', () => {
    const config = {
      mcpApps: { enabled: true, legacyHtmlEnabled: true, maxActiveViews: 1 },
    } as TStartupConfig;
    const attachments = [
      attachment({ toolCallId: 'read-only', agentId: 'agent', stepId: 'step' }, [
        app({ text: undefined, resourceId: 'uri-only' }),
        app({ resourceId: 'inline' }),
      ]),
    ];
    const view = render(
      <MCPAppsPolicyProvider startupConfig={config} ready userId="user-1">
        <MCPAppViews attachments={attachments} />
      </MCPAppsPolicyProvider>,
    );
    expect(view.getByText('com_ui_mcp_app_shared_unavailable')).toBeInTheDocument();
    expect(mockUseMCPAppFrame).not.toHaveBeenCalled();
    expect(view.getAllByRole('button', { name: /com_ui_mcp_app_open_named/ })).toHaveLength(1);
    fireEvent.click(view.getByRole('button', { name: /com_ui_mcp_app_open_named/ }));
    expect(view.container.querySelectorAll('iframe[data-sandbox-url]')).toHaveLength(1);
  });

  it('limits simultaneous live bridges and releases the slot on close', () => {
    const attachments = [
      attachment(
        { toolCallId: 'batch', agentId: 'agent', stepId: 'step' },
        Array.from({ length: 4 }, (_, i) => app({ resourceId: `r${i}`, toolName: `tool${i}` })),
      ),
    ];
    const view = render(
      <MCPAppsPolicyProvider startupConfig={enabledConfig} ready userId="user-1">
        <MCPAppViews attachments={attachments} />
      </MCPAppsPolicyProvider>,
    );
    expect(mockUseAppBridge).not.toHaveBeenCalled();
    view
      .getAllByRole('button', { name: /com_ui_mcp_app_open_named/ })
      .slice(0, 3)
      .forEach(fireEvent.click);
    expect(view.container.querySelectorAll('iframe[data-sandbox-url]')).toHaveLength(3);
    fireEvent.click(view.getByRole('button', { name: /com_ui_mcp_app_open_named/ }));
    expect(view.getByRole('alert')).toHaveTextContent('com_ui_mcp_app_at_capacity');
    expect(view.container.querySelectorAll('iframe[data-sandbox-url]')).toHaveLength(3);
    fireEvent.click(view.getAllByRole('button', { name: /com_ui_mcp_app_close_named/ })[0]);
    expect(view.container.querySelectorAll('iframe[data-sandbox-url]')).toHaveLength(2);
    fireEvent.click(view.getAllByRole('button', { name: /com_ui_mcp_app_open_named/ }).at(-1)!);
    expect(view.container.querySelectorAll('iframe[data-sandbox-url]')).toHaveLength(3);
  });

  it('keeps legitimate same-owner and same-resource occurrences distinct', () => {
    const attachments = [
      attachment({ toolCallId: 'call-0', agentId: 'agent-alpha', stepId: 'step-alpha' }, [
        app({ toolArgs: { occurrence: 'first' }, content: [{ type: 'text', text: 'first' }] }),
        app({ toolArgs: { occurrence: 'second' }, content: [{ type: 'text', text: 'second' }] }),
      ]),
    ];

    const { container } = render(
      <MCPAppsPolicyProvider startupConfig={enabledConfig} ready userId="user-1">
        <MCPAppViews attachments={attachments} />
      </MCPAppsPolicyProvider>,
    );

    expect(container.querySelectorAll('iframe[data-sandbox-url]')).toHaveLength(0);
    expect(mockUseAppBridge).not.toHaveBeenCalled();
    screen.getAllByRole('button', { name: /com_ui_mcp_app_open_named/ }).forEach(fireEvent.click);
    expect(container.querySelectorAll('iframe[data-sandbox-url]')).toHaveLength(2);
    expect(mockUseAppBridge.mock.calls.map(([params]) => params.toolArgs)).toEqual([
      { occurrence: 'first' },
      { occurrence: 'second' },
    ]);
    expect(mockUseAppBridge.mock.calls.map(([params]) => params.toolResult?.content)).toEqual([
      [{ type: 'text', text: 'first' }],
      [{ type: 'text', text: 'second' }],
    ]);
  });

  it('preserves an App frame when unrelated wrappers and resources are inserted or reordered', () => {
    const target = app({ resourceId: 'target', toolName: 'target', toolArgs: { target: true } });
    const unrelated = app({
      resourceId: 'unrelated',
      toolName: 'unrelated',
      toolArgs: { unrelated: true },
    });
    const targetAttachment = attachment(
      { toolCallId: 'call-target', agentId: 'agent-a', stepId: 'step-a' },
      [target],
    );
    const unrelatedAttachment = attachment(
      { toolCallId: 'call-other', agentId: 'agent-b', stepId: 'step-b' },
      [unrelated],
    );
    const renderViews = (attachments: TAttachment[]) => (
      <MCPAppsPolicyProvider startupConfig={enabledConfig} ready userId="user-1">
        <MCPAppViews attachments={attachments} />
      </MCPAppsPolicyProvider>
    );
    const view = render(renderViews([targetAttachment]));
    expect(view.queryByTitle('MCP App: target')).not.toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: /com_ui_mcp_app_open_named/ }));
    const targetFrame = view.getByTitle('MCP App: target');

    view.rerender(renderViews([unrelatedAttachment, targetAttachment]));
    expect(view.getByTitle('MCP App: target')).toBe(targetFrame);

    const expandedTargetAttachment = attachment(
      { toolCallId: 'call-target', agentId: 'agent-a', stepId: 'step-a' },
      [unrelated, target],
    );
    view.rerender(renderViews([expandedTargetAttachment, unrelatedAttachment]));
    expect(view.getByTitle('MCP App: target')).toBe(targetFrame);

    view.rerender(renderViews([unrelatedAttachment, targetAttachment]));
    expect(view.getByTitle('MCP App: target')).toBe(targetFrame);
  });

  it('suppresses only attachments owned by an ancestor App surface', () => {
    const owned = attachment({ toolCallId: 'call-owned', agentId: 'agent-a', stepId: 'step-a' }, [
      app({ resourceId: 'owned', toolName: 'owned' }),
    ]);
    const nested = attachment({ toolCallId: 'call-nested', agentId: 'agent-b', stepId: 'step-b' }, [
      app({ resourceId: 'nested', toolName: 'nested' }),
    ]);

    const view = render(
      <MCPAppsPolicyProvider startupConfig={enabledConfig} ready userId="user-1">
        <MCPAppSuppressionContext.Provider value={new Set([owned])}>
          <MCPAppViews attachments={[owned, nested]} />
        </MCPAppSuppressionContext.Provider>
      </MCPAppsPolicyProvider>,
    );

    expect(view.queryByTitle('MCP App: owned')).not.toBeInTheDocument();
    expect(view.queryByTitle('MCP App: nested')).not.toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: /com_ui_mcp_app_open_named/ }));
    expect(view.getByTitle('MCP App: nested')).toBeInTheDocument();
  });

  it.each([
    ['default', 320],
    ['compact', 260],
    ['lower clamp', 80],
  ])('uses the hook-owned %s height without a second surface minimum', (_label, height) => {
    mockUseMCPAppFrame.mockImplementationOnce((resource, options) =>
      makeFrameState(resource as UIResource, options.toolArgs, { height }),
    );
    const attachments = [
      attachment({ toolCallId: 'call-1', agentId: 'agent-1', stepId: 'step-1' }, [
        app({ toolName: 'compact' }),
      ]),
    ];

    const view = render(
      <MCPAppsPolicyProvider startupConfig={enabledConfig} ready userId="user-1">
        <MCPAppViews attachments={attachments} />
      </MCPAppsPolicyProvider>,
    );
    expect(view.queryByTitle('MCP App: compact')).not.toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: /com_ui_mcp_app_open_named/ }));
    const container = view.getByTitle('MCP App: compact').parentElement;

    expect(container).toHaveStyle({ height: `${height}px` });
    expect(container?.style.minHeight).toBe('');
  });
});

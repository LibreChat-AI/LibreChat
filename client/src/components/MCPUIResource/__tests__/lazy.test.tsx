import { Component } from 'react';
import { Tools } from 'librechat-data-provider';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TAttachment, TStartupConfig, UIResource } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { MCPAppsPolicyProvider } from '~/Providers/MCPAppsPolicyContext';
import { MCPAppViews } from '~/components/MCPUIResource';
import UIResourceRenderer from '../Renderer';

/**
 * The legacy renderer SDK and the App Bridge SDK ship in on-demand chunks. Importing the
 * components below must not evaluate either package, so these factories only run when a lazy
 * boundary actually loads one: a static import anywhere in these graphs makes this suite fail.
 * They throw what a stale or unreachable chunk throws, to exercise the failure path.
 */
const mockEvaluated = jest.fn();
jest.mock('@mcp-ui/client', () => {
  mockEvaluated('@mcp-ui/client');
  throw new TypeError('Failed to fetch dynamically imported module: /assets/mcp-ui-old.js');
});
jest.mock('@modelcontextprotocol/ext-apps/app-bridge', () => {
  mockEvaluated('@modelcontextprotocol/ext-apps/app-bridge');
  throw new TypeError('Failed to fetch dynamically imported module: /assets/mcp-apps-old.js');
});

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <div role="alert" /> : this.props.children;
  }
}

const policy = (legacyHtmlEnabled: boolean) =>
  ({ mcpApps: { enabled: true, legacyHtmlEnabled } }) as TStartupConfig;

const legacy: UIResource = {
  resourceId: 'legacy',
  uri: 'ui://legacy',
  mimeType: 'text/html',
  text: '<p>Legacy</p>',
};

const appAttachments = [
  {
    type: Tools.ui_resources,
    toolCallId: 'call',
    agentId: 'agent',
    stepId: 'step',
    [Tools.ui_resources]: [
      {
        resourceId: 'app',
        uri: 'ui://demo/view',
        mimeType: 'text/html;profile=mcp-app',
        toolName: 'show_app',
        serverName: 'demo',
        text: '<p>App</p>',
      },
    ],
  },
] as unknown as TAttachment[];

describe('on-demand MCP UI chunks', () => {
  let recover: jest.Mock;

  beforeEach(() => {
    recover = jest.fn(() => false);
    window.__lcRecoverStaleAssets = recover;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete window.__lcRecoverStaleAssets;
    delete window.__lcStaleAssetRecoveryPending;
  });

  it('loads neither SDK when the components are imported or rendered without a legacy or App view', () => {
    expect(mockEvaluated).not.toHaveBeenCalled();

    const view = render(
      <MCPAppsPolicyProvider startupConfig={policy(false)} ready userId="user-1">
        <UIResourceRenderer resource={legacy} />
        <MCPAppViews attachments={appAttachments} />
      </MCPAppsPolicyProvider>,
    );

    expect(view.getByRole('button', { name: 'Open app: show_app (1)' })).toBeInTheDocument();
    expect(mockEvaluated).not.toHaveBeenCalled();
  });

  it('reports a legacy SDK chunk that cannot load instead of waiting on it forever', async () => {
    render(
      <Boundary>
        <MCPAppsPolicyProvider startupConfig={policy(true)} ready userId="user-1">
          <UIResourceRenderer resource={legacy} />
        </MCPAppsPolicyProvider>
      </Boundary>,
    );

    expect(screen.getByText('Loading interactive view...')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(mockEvaluated).toHaveBeenCalledWith('@mcp-ui/client');
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('reports an App Bridge chunk that cannot load after the viewer opens the App', async () => {
    render(
      <Boundary>
        <MCPAppsPolicyProvider startupConfig={policy(true)} ready userId="user-1">
          <MCPAppViews attachments={appAttachments} />
        </MCPAppsPolicyProvider>
      </Boundary>,
    );
    expect(mockEvaluated).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Open app: show_app (1)' }));
    expect(screen.getByText('Loading interactive view...')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(mockEvaluated).toHaveBeenCalledWith('@modelcontextprotocol/ext-apps/app-bridge');
    expect(recover).toHaveBeenCalledTimes(1);
  });
});

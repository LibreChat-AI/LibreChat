import type { MCPServerStatus } from 'librechat-data-provider';
import {
  getStatusColor,
  getStatusTextKey,
  isMCPServerReadyForAgent,
  shouldShowActionButton,
} from './mcpServerUtils';

const status = (
  connectionState: MCPServerStatus['connectionState'],
  authorizationState: MCPServerStatus['authorizationState'],
): MCPServerStatus => ({ connectionState, authorizationState, requiresOAuth: false });

describe('isMCPServerReadyForAgent', () => {
  it('treats an authorized idle request-scoped server as ready', () => {
    expect(isMCPServerReadyForAgent(status('disconnected', 'authorized'), true)).toBe(true);
  });

  it('treats an idle request-scoped server without an auth requirement as ready', () => {
    expect(isMCPServerReadyForAgent(status('disconnected', 'not_required'), true)).toBe(true);
  });

  it('keeps request-scoped servers gated while authorization is incomplete or failed', () => {
    expect(isMCPServerReadyForAgent(status('disconnected', 'needs_authorization'), true)).toBe(
      false,
    );
    expect(isMCPServerReadyForAgent(status('error', 'error'), true)).toBe(false);
  });

  it('requires declared custom variables before an on-demand server is ready', () => {
    const missingConfiguration = {
      ...status('disconnected', 'not_required'),
      configurationState: 'needs_configuration' as const,
    };
    const configured = {
      ...missingConfiguration,
      configurationState: 'configured' as const,
    };

    expect(isMCPServerReadyForAgent(missingConfiguration, true, true)).toBe(false);
    expect(isMCPServerReadyForAgent(configured, true, true)).toBe(true);
  });

  it('rejects missing required variables even with a connected transport', () => {
    expect(
      isMCPServerReadyForAgent(
        { ...status('connected', 'not_required'), configurationState: 'needs_configuration' },
        false,
        true,
      ),
    ).toBe(false);
  });

  it('requires a live connection for servers that are not request-scoped', () => {
    expect(isMCPServerReadyForAgent(status('disconnected', 'not_required'), false)).toBe(false);
    expect(isMCPServerReadyForAgent(status('connected', 'not_required'), false)).toBe(true);
  });
});

describe('shouldShowActionButton', () => {
  it('keeps configuration actionable for an idle request-scoped server', () => {
    const serverStatus: MCPServerStatus = {
      connectionState: 'disconnected',
      authorizationState: 'not_required',
      requiresOAuth: false,
      requestScoped: true,
      configurationState: 'needs_configuration',
    };
    const baseProps = {
      serverName: 'server',
      serverStatus,
      isInitializing: false,
      canCancel: false,
      onCancel: jest.fn(),
      onConfigClick: jest.fn(),
    };

    expect(shouldShowActionButton({ ...baseProps, hasCustomUserVars: true })).toBe(true);
    expect(shouldShowActionButton({ ...baseProps, hasCustomUserVars: false })).toBe(false);
  });
});

it('preserves connected readiness from older replicas without configurationState', () => {
  expect(
    isMCPServerReadyForAgent({ connectionState: 'connected', requiresOAuth: false }, false, true),
  ).toBe(true);
});

it('presents an unavailable lookup as unknown and keeps retry actionable', () => {
  const serverStatus: MCPServerStatus = {
    connectionState: 'error',
    connectionStateSource: 'unavailable',
    requiresOAuth: true,
  };
  expect(getStatusTextKey('server', { server: serverStatus })).toBe('com_nav_mcp_status_unknown');
  expect(getStatusColor('server', { server: serverStatus })).toBe('bg-status-neutral');
  expect(isMCPServerReadyForAgent(serverStatus, false)).toBe(false);
  expect(isMCPServerReadyForAgent({ ...serverStatus, requestScoped: true }, true, true)).toBe(
    false,
  );
  expect(
    shouldShowActionButton({
      serverName: 'server',
      serverStatus,
      isInitializing: false,
      canCancel: false,
      onCancel: jest.fn(),
      onConfigClick: jest.fn(),
    }),
  ).toBe(true);
});

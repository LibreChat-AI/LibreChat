import type { MCPServerStatus } from 'librechat-data-provider';
import {
  getMCPControlState,
  getMCPServerAction,
  getStatusColor,
  getMCPStatusLabelKey,
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
  it('keeps the menu action slot in sync with the current Connect result', () => {
    const props = {
      serverName: 'server',
      serverStatus: status('connected', 'not_required'),
      isInitializing: false,
      canCancel: false,
      onCancel: jest.fn(),
      onConfigClick: jest.fn(),
      view: { state: 'failed', canUse: false } as const,
    };

    expect(getMCPServerAction(props)).toBe('connect');
    expect(shouldShowActionButton(props)).toBe(true);

    const succeeded = {
      ...props,
      serverStatus: status('disconnected', 'not_required'),
      view: { state: 'succeeded', canUse: true } as const,
    };
    expect(getMCPServerAction(succeeded)).toBeUndefined();
    expect(shouldShowActionButton(succeeded)).toBe(false);
  });

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

it('omits an unobserved status label and keeps retry actionable', () => {
  const serverStatus: MCPServerStatus = {
    connectionState: 'error',
    connectionStateSource: 'unavailable',
    requiresOAuth: true,
  };
  expect(getMCPStatusLabelKey(serverStatus)).toBeUndefined();
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

it('uses explicit operation readiness for agent attachment without changing transport state', () => {
  const raw = {
    requiresOAuth: false,
    connectionState: 'disconnected' as const,
    connectionStateSource: 'unobserved' as const,
  };
  expect(
    isMCPServerReadyForAgent(raw, false, false, {
      state: 'succeeded',
      canUse: true,
      observation: raw,
    }),
  ).toBe(true);
  expect(
    isMCPServerReadyForAgent(raw, false, false, {
      state: 'unknown',
      canUse: false,
      observation: raw,
    }),
  ).toBe(false);
  expect(raw.connectionState).toBe('disconnected');
});

it('keeps the existing secondary-replica display neutral while preserving reconnect', () => {
  const raw: MCPServerStatus = {
    requiresOAuth: false,
    connectionState: 'disconnected',
    connectionStateSource: 'unobserved',
  };
  const view = { state: 'succeeded', canUse: true, observation: raw } as const;

  expect(getMCPStatusLabelKey(raw, false, view)).toBeUndefined();
  expect(getMCPStatusLabelKey(raw, false, { state: 'unknown', canUse: false })).toBeUndefined();
  expect(
    getMCPStatusLabelKey(
      { ...raw, connectionState: 'connected', connectionStateSource: 'authorization' },
      false,
      { state: 'authorized', canUse: true },
    ),
  ).toBeUndefined();
  expect(getStatusColor('mcp', { mcp: raw }, undefined, view)).toBe('bg-status-neutral');
  expect(getMCPControlState(raw, view)).toBe('connected');
  expect(getMCPControlState(raw, { state: 'unknown', canUse: false })).toBe('disconnected');
});

it('uses the existing error and retry presentation for a failed reconnect over old status', () => {
  const raw = status('connected', 'not_required');
  const view = { state: 'failed', canUse: false, observation: raw } as const;

  expect(getMCPStatusLabelKey(raw, false, view)).toBe('com_nav_mcp_status_error');
  expect(getStatusColor('mcp', { mcp: raw }, undefined, view)).toBe('bg-status-error');
  expect(getMCPControlState(raw, view)).toBe('error');
});

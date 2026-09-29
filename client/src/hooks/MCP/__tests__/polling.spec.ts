import {
  applyMCPDiscoveryAuthorizationState,
  getMCPOAuthTimeout,
  getMCPOAuthPollingOutcome,
  isMCPReadyAfterOAuth,
  shouldFailMCPOAuthFallback,
  isTerminalMCPOAuthPollingError,
  shouldUseMCPConnectionStatus,
} from '../polling';

describe('applyMCPDiscoveryAuthorizationState', () => {
  it('overrides stale connected status when catalog discovery requires reauthorization', () => {
    const result = applyMCPDiscoveryAuthorizationState(
      {
        oauth: {
          requiresOAuth: true,
          connectionState: 'connected',
          authorizationState: 'authorized',
          authorizationGeneration: 'generation-1',
        },
      },
      {
        servers: {
          oauth: {
            name: 'oauth',
            icon: '',
            authenticated: false,
            authorizationState: 'reauth_required',
            authorizationGeneration: 'generation-1',
            authConfig: [],
            tools: [],
          },
        },
      },
    );

    expect(result?.oauth).toEqual({
      requiresOAuth: true,
      connectionState: 'disconnected',
      authorizationState: 'needs_authorization',
      authorizationGeneration: 'generation-1',
    });
  });

  it('keeps status from a newer shared authorization generation', () => {
    const currentStatus = {
      oauth: {
        requiresOAuth: true,
        connectionState: 'connected' as const,
        authorizationState: 'authorized' as const,
        authorizationGeneration: 'generation-2',
      },
    };
    const result = applyMCPDiscoveryAuthorizationState(currentStatus, {
      servers: {
        oauth: {
          name: 'oauth',
          icon: '',
          authenticated: false,
          authorizationState: 'reauth_required',
          authorizationGeneration: 'generation-1',
          authConfig: [],
          tools: [],
        },
      },
    });

    expect(result).toBe(currentStatus);
  });

  it.each([
    ['missing discovery generation', undefined, 'generation-2'],
    ['missing status generation', 'generation-1', undefined],
  ])('keeps authorized status with %s', (_label, discoveryGeneration, statusGeneration) => {
    const currentStatus = {
      oauth: {
        requiresOAuth: true,
        connectionState: 'connected' as const,
        authorizationState: 'authorized' as const,
        authorizationGeneration: statusGeneration,
      },
    };
    const result = applyMCPDiscoveryAuthorizationState(currentStatus, {
      servers: {
        oauth: {
          name: 'oauth',
          icon: '',
          authenticated: false,
          authorizationState: 'reauth_required',
          authorizationGeneration: discoveryGeneration,
          authConfig: [],
          tools: [],
        },
      },
    });

    expect(result).toBe(currentStatus);
  });

  it('preserves an active OAuth flow over cached reauthorization state', () => {
    const currentStatus = {
      oauth: {
        requiresOAuth: true,
        connectionState: 'connecting' as const,
        authorizationState: 'authorizing' as const,
        authorizationGeneration: 'generation-1',
      },
    };
    const result = applyMCPDiscoveryAuthorizationState(currentStatus, {
      servers: {
        oauth: {
          name: 'oauth',
          icon: '',
          authenticated: false,
          authorizationState: 'reauth_required',
          authorizationGeneration: 'generation-1',
          authConfig: [],
          tools: [],
        },
      },
    });

    expect(result).toBe(currentStatus);
  });
});

describe('getMCPOAuthTimeout', () => {
  it('preserves the remaining timeout of a reused flow over the global server window', () => {
    expect(getMCPOAuthTimeout(45_000, 600_000)).toBe(45_000);
  });

  it('uses the global server window when the attempt has no explicit timeout', () => {
    expect(getMCPOAuthTimeout(undefined, 300_000)).toBe(300_000);
  });
});

describe('getMCPOAuthPollingOutcome', () => {
  it('treats shared flow completion as terminal success', () => {
    expect(getMCPOAuthPollingOutcome({ status: 'COMPLETED', completed: true, failed: false })).toBe(
      'completed',
    );
  });

  it('treats a retained timeout failure as terminal failure', () => {
    expect(
      getMCPOAuthPollingOutcome({
        status: 'FAILED',
        completed: false,
        failed: true,
        error: 'mcp_oauth flow timed out',
      }),
    ).toBe('failed');
  });

  it('keeps polling a pending flow', () => {
    expect(getMCPOAuthPollingOutcome({ status: 'PENDING', completed: false, failed: false })).toBe(
      'pending',
    );
  });

  it('treats missing and unauthorized flow records as terminal polling errors', () => {
    expect(isTerminalMCPOAuthPollingError({ response: { status: 404 } })).toBe(true);
    expect(isTerminalMCPOAuthPollingError({ response: { status: 403 } })).toBe(true);
    expect(isTerminalMCPOAuthPollingError({ response: { status: 500 } })).toBe(false);
  });
});

describe('shouldUseMCPConnectionStatus', () => {
  it('ignores stale cached errors while a live OAuth flow is pending', () => {
    expect(shouldUseMCPConnectionStatus('active-flow', false)).toBe(false);
  });

  it('uses durable connection status when no usable flow endpoint remains', () => {
    expect(shouldUseMCPConnectionStatus(undefined, false)).toBe(true);
    expect(shouldUseMCPConnectionStatus('missing-flow', true)).toBe(true);
  });
});

describe('shouldFailMCPOAuthFallback', () => {
  it('keeps polling when a fallback pod still reports active authorization', () => {
    expect(
      shouldFailMCPOAuthFallback(true, {
        requiresOAuth: true,
        connectionState: 'error',
        authorizationState: 'authorizing',
      }),
    ).toBe(false);
    expect(
      shouldFailMCPOAuthFallback(true, {
        requiresOAuth: true,
        connectionState: 'connecting',
        authorizationState: 'needs_authorization',
      }),
    ).toBe(false);
  });

  it('fails a missing flow only after fallback status is no longer authorizing', () => {
    expect(
      shouldFailMCPOAuthFallback(true, {
        requiresOAuth: true,
        connectionState: 'disconnected',
        authorizationState: 'needs_authorization',
      }),
    ).toBe(true);
    expect(shouldFailMCPOAuthFallback(false, undefined)).toBe(false);
  });
});

describe('isMCPReadyAfterOAuth', () => {
  const response = {
    success: true,
    message: 'ready',
    serverName: 'test-server',
  };

  it('accepts a successful post-OAuth reinitialization', () => {
    expect(isMCPReadyAfterOAuth(response)).toBe(true);
  });

  it('does not treat another OAuth challenge as connection readiness', () => {
    expect(isMCPReadyAfterOAuth({ ...response, oauthRequired: true })).toBe(false);
  });
});

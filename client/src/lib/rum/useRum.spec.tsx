import { renderHook, waitFor } from '@testing-library/react';
import useRum from './useRum';

const mockInit = jest.fn();
const mockAddAction = jest.fn();
const mockSetGlobalAttributes = jest.fn();
const mockUseGetStartupConfig = jest.fn();
const mockUseAuthContext = jest.fn();
const mockUseLocation = jest.fn();

jest.mock('@hyperdx/browser', () => ({
  __esModule: true,
  default: {
    addAction: (...args: unknown[]) => mockAddAction(...args),
    init: (...args: unknown[]) => mockInit(...args),
    setGlobalAttributes: (...args: unknown[]) => mockSetGlobalAttributes(...args),
  },
}));

jest.mock('./diagnostics', () => ({
  discardEarlyRumQueue: jest.fn(),
  queueSpaRouteChange: jest.fn(),
  forwardQueuedAssetEvents: jest.fn(),
  restoreRumEmitter: jest.fn(),
  startRumDiagnostics: jest.fn(),
}));

const { discardEarlyRumQueue, queueSpaRouteChange, restoreRumEmitter, startRumDiagnostics } =
  jest.requireMock('./diagnostics');

jest.mock('./logs', () => ({
  startClientLogs: jest.fn(),
  stopClientLogs: jest.fn(),
}));

const { startClientLogs, stopClientLogs } = jest.requireMock('./logs');

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => mockUseGetStartupConfig(),
}));

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => mockUseAuthContext(),
}));

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useLocation: () => mockUseLocation(),
}));

describe('useRum', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseGetStartupConfig.mockReturnValue({ data: undefined, isFetched: false });
    mockUseLocation.mockReturnValue({ pathname: '/c/conversation-123' });
    mockUseAuthContext.mockReturnValue({
      isAuthenticated: true,
      token: 'jwt-token',
      user: {
        id: 'user-123',
        role: 'USER',
        tenantId: 'org-123',
        email: 'user@example.com',
      },
    });
  });

  it('initializes HyperDX public-token RUM with privacy defaults and safe attributes', async () => {
    mockUseGetStartupConfig.mockReturnValue({
      data: {
        rum: {
          provider: 'hyperdx',
          enabled: true,
          url: 'https://rum.example.com',
          serviceName: 'librechat-web',
          authMode: 'publicToken',
          publicToken: 'public-token',
          tracePropagationTargets: ['https://librechat.example.com'],
        },
      },
    });

    renderHook(() => useRum());

    await waitFor(() => {
      expect(mockInit).toHaveBeenCalledWith({
        advancedNetworkCapture: false,
        apiKey: 'public-token',
        consoleCapture: false,
        disableReplay: true,
        service: 'librechat-web',
        tracePropagationTargets: ['https://librechat.example.com'],
        url: 'https://rum.example.com',
      });
    });

    expect(mockSetGlobalAttributes).toHaveBeenCalledWith({
      clientBuildId: 'unknown',
      route: '/c/:conversationId',
      role: 'USER',
      userId: 'user-123',
      orgId: 'org-123',
      serviceName: 'librechat-web',
    });
    expect(mockSetGlobalAttributes).not.toHaveBeenCalledWith(
      expect.objectContaining({ email: 'user@example.com' }),
    );
    expect(startRumDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ init: expect.any(Function) }),
      expect.any(Function),
    );
  });

  it('does not initialize RUM for unsupported auth modes', async () => {
    mockUseGetStartupConfig.mockReturnValue({
      isFetched: true,
      data: {
        rum: {
          provider: 'hyperdx',
          enabled: true,
          url: 'https://rum.example.com/ingest',
          serviceName: 'librechat-web',
          authMode: 'userJwt',
          publicToken: 'public-token',
        },
      },
    });

    renderHook(() => useRum());

    expect(mockInit).not.toHaveBeenCalled();
    expect(discardEarlyRumQueue).toHaveBeenCalled();
  });

  it('discards the early RUM queue when sampling excludes the page', async () => {
    mockUseGetStartupConfig.mockReturnValue({
      isFetched: true,
      data: {
        rum: {
          provider: 'hyperdx',
          enabled: true,
          url: 'https://rum.example.com',
          serviceName: 'librechat-web',
          authMode: 'publicToken',
          publicToken: 'public-token',
          sampleRate: 0,
        },
      },
    });

    renderHook(() => useRum());

    expect(mockInit).not.toHaveBeenCalled();
    expect(discardEarlyRumQueue).toHaveBeenCalled();
  });

  it('discards and stops route buffering when startup config has no RUM config', async () => {
    mockUseGetStartupConfig.mockReturnValue({
      data: {},
      isFetched: true,
    });

    const { rerender } = renderHook(() => useRum());

    expect(discardEarlyRumQueue).toHaveBeenCalled();

    mockUseLocation.mockReturnValue({ pathname: '/login' });
    rerender();

    expect(queueSpaRouteChange).not.toHaveBeenCalled();
  });

  it('preserves the early RUM queue while proxy mode waits for an auth token', async () => {
    mockUseAuthContext.mockReturnValue({
      isAuthenticated: false,
      token: undefined,
      user: undefined,
    });
    mockUseGetStartupConfig.mockReturnValue({
      isFetched: true,
      data: {
        rum: {
          provider: 'hyperdx',
          enabled: true,
          url: '/api/rum',
          serviceName: 'librechat-web',
          authMode: 'proxy',
        },
      },
    });

    renderHook(() => useRum());

    expect(mockInit).not.toHaveBeenCalled();
    expect(discardEarlyRumQueue).not.toHaveBeenCalled();
  });

  it('restores the RUM emitter when an initialized config becomes valid again', async () => {
    const validRumConfig = {
      provider: 'hyperdx',
      enabled: true,
      url: 'https://rum.example.com',
      serviceName: 'librechat-web',
      authMode: 'publicToken',
      publicToken: 'public-token',
    };
    let rumConfig = validRumConfig;
    mockUseGetStartupConfig.mockImplementation(() => ({
      isFetched: true,
      data: {
        rum: rumConfig,
      },
    }));

    const { rerender } = renderHook(() => useRum());

    await waitFor(() => {
      expect(mockInit).toHaveBeenCalled();
    });

    rumConfig = { ...validRumConfig, enabled: false };
    rerender();

    expect(discardEarlyRumQueue).toHaveBeenCalled();

    rumConfig = { ...validRumConfig };
    rerender();

    expect(restoreRumEmitter).toHaveBeenCalledWith(
      expect.objectContaining({ init: expect.any(Function) }),
    );
  });

  it('initializes proxy RUM with the LibreChat bearer token for same-origin ingest', async () => {
    const fetchMock = jest.fn(
      (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        Promise.resolve({ ok: true, status: 200 } as Response),
    );
    window.fetch = Object.assign(fetchMock, { preconnect: () => undefined });
    mockUseGetStartupConfig.mockReturnValue({
      isFetched: true,
      data: {
        rum: {
          provider: 'hyperdx',
          enabled: true,
          url: '/api/rum',
          serviceName: 'librechat-web',
          authMode: 'proxy',
        },
      },
    });

    renderHook(() => useRum());

    await waitFor(() => {
      expect(mockInit).toHaveBeenCalledWith({
        advancedNetworkCapture: false,
        apiKey: 'librechat-rum-proxy',
        consoleCapture: false,
        disableReplay: true,
        service: 'librechat-web',
        tracePropagationTargets: undefined,
        url: '/api/rum',
      });
    });

    await window.fetch('/api/rum/v1/traces', { method: 'POST' });

    const headers = fetchMock.mock.calls[0]?.[1]?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get('authorization')).toBe('Bearer jwt-token');
  });

  it('does not initialize proxy RUM without an authenticated token', async () => {
    mockUseAuthContext.mockReturnValue({
      isAuthenticated: false,
      token: undefined,
      user: undefined,
    });
    mockUseGetStartupConfig.mockReturnValue({
      isFetched: true,
      data: {
        rum: {
          provider: 'hyperdx',
          enabled: true,
          url: '/api/rum',
          serviceName: 'librechat-web',
          authMode: 'proxy',
        },
      },
    });

    renderHook(() => useRum());

    expect(mockInit).not.toHaveBeenCalled();
    expect(discardEarlyRumQueue).not.toHaveBeenCalled();
  });

  it('queues SPA route changes through the shared early RUM channel', async () => {
    mockUseGetStartupConfig.mockReturnValue({
      data: {
        rum: {
          provider: 'hyperdx',
          enabled: true,
          url: 'https://rum.example.com',
          serviceName: 'librechat-web',
          authMode: 'publicToken',
          publicToken: 'public-token',
        },
      },
    });

    const { rerender } = renderHook(() => useRum());

    await waitFor(() => {
      expect(mockInit).toHaveBeenCalled();
    });

    mockUseLocation.mockReturnValue({ pathname: '/login' });
    rerender();

    expect(queueSpaRouteChange).toHaveBeenCalledWith('/c/:conversationId', '/login');
  });
  describe('client logs', () => {
    const proxyRum = {
      provider: 'hyperdx',
      enabled: true,
      url: '/api/rum',
      serviceName: 'librechat-web',
      authMode: 'proxy',
      environment: 'demo',
      clientLogs: true,
    };

    it('starts proxy-mode client logs on the same-origin logs path with the session token', () => {
      mockUseGetStartupConfig.mockReturnValue({ isFetched: true, data: { rum: proxyRum } });

      renderHook(() => useRum());

      expect(startClientLogs).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: '/api/rum/v1/logs',
          serviceName: 'librechat-web',
          environment: 'demo',
        }),
      );
      const [{ getToken }] = startClientLogs.mock.calls[0];
      expect(getToken()).toBe('jwt-token');
    });

    it('keeps client logs off when the server leaves them disabled', () => {
      mockUseGetStartupConfig.mockReturnValue({
        isFetched: true,
        data: { rum: { ...proxyRum, clientLogs: false } },
      });

      renderHook(() => useRum());

      expect(startClientLogs).not.toHaveBeenCalled();
      expect(stopClientLogs).toHaveBeenCalled();
    });

    it('never starts client logs in public-token mode', () => {
      mockUseGetStartupConfig.mockReturnValue({
        isFetched: true,
        data: {
          rum: {
            ...proxyRum,
            url: 'https://rum.example.com',
            authMode: 'publicToken',
            publicToken: 'public-token',
          },
        },
      });

      renderHook(() => useRum());

      expect(startClientLogs).not.toHaveBeenCalled();
    });

    it('follows RUM session sampling', () => {
      mockUseGetStartupConfig.mockReturnValue({
        isFetched: true,
        data: { rum: { ...proxyRum, sampleRate: 0 } },
      });

      renderHook(() => useRum());

      expect(startClientLogs).not.toHaveBeenCalled();
      expect(stopClientLogs).toHaveBeenCalled();
    });

    it('stops client logs when the session token goes away', () => {
      mockUseGetStartupConfig.mockReturnValue({ isFetched: true, data: { rum: proxyRum } });
      const { rerender } = renderHook(() => useRum());
      expect(startClientLogs).toHaveBeenCalledTimes(1);

      mockUseAuthContext.mockReturnValue({
        isAuthenticated: false,
        token: undefined,
        user: undefined,
      });
      rerender();

      expect(stopClientLogs).toHaveBeenCalled();
    });

    it('stops client logs when the authenticated layout unmounts', () => {
      mockUseGetStartupConfig.mockReturnValue({ isFetched: true, data: { rum: proxyRum } });
      const { unmount } = renderHook(() => useRum());
      stopClientLogs.mockClear();

      unmount();

      expect(stopClientLogs).toHaveBeenCalledTimes(1);
    });

    it('stops client logs when startup config has no RUM config', () => {
      mockUseGetStartupConfig.mockReturnValue({ isFetched: true, data: {} });

      renderHook(() => useRum());

      expect(startClientLogs).not.toHaveBeenCalled();
      expect(stopClientLogs).toHaveBeenCalled();
    });
  });
});

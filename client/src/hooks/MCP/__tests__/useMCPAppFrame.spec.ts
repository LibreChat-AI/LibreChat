import { act, renderHook } from '@testing-library/react';
import type { UIResource } from 'librechat-data-provider';
import { useMCPAppFrame, APP_REVEAL_TIMEOUT_MS } from '~/hooks/MCP/useMCPAppFrame';
import { MAX_CAROUSEL_VIEW_HEIGHT, MIN_APP_VIEW_HEIGHT } from '~/utils/mcpApps';
import { useMCPAppsPolicy } from '~/Providers/MCPAppsPolicyContext';
import { useIsMessagesViewReadOnly } from '~/Providers';

jest.mock('~/utils/mcpApps', () => ({
  ...jest.requireActual('~/utils/mcpApps'),
  getMCPSandboxUrl: jest.fn(() => 'http://sandbox.localhost:3081/api/mcp/sandbox'),
}));

jest.mock('~/Providers', () => ({
  useIsMessagesViewReadOnly: jest.fn(() => false),
}));

jest.mock('~/Providers/MCPAppsPolicyContext', () => ({
  useMCPAppsPolicy: jest.fn(() => ({ enabled: true, legacyHtmlEnabled: true })),
}));

const mockReadOnly = useIsMessagesViewReadOnly as jest.MockedFunction<
  typeof useIsMessagesViewReadOnly
>;
const mockUseMCPAppsPolicy = useMCPAppsPolicy as jest.MockedFunction<typeof useMCPAppsPolicy>;

const appResource = (overrides: Partial<UIResource> = {}): UIResource =>
  ({
    resourceId: 'r1',
    uri: 'ui://app/main',
    mimeType: 'text/html;profile=mcp-app',
    toolName: 'render',
    serverName: 'demo',
    serverBinding: 'binding-demo',
    ...overrides,
  }) as UIResource;

describe('useMCPAppFrame', () => {
  beforeEach(() => {
    mockReadOnly.mockReturnValue(false);
    mockUseMCPAppsPolicy.mockReturnValue({ enabled: true, legacyHtmlEnabled: true });
  });

  describe('kind', () => {
    it('classifies app, static, unavailable and empty resources', () => {
      const app = renderHook(() => useMCPAppFrame(appResource(), { defaultHeight: 100 }));
      expect(app.result.current.kind).toBe('app');

      const staticView = renderHook(() =>
        useMCPAppFrame(
          appResource({ toolName: undefined, serverName: undefined, text: '<p>x</p>' }),
          { defaultHeight: 100 },
        ),
      );
      expect(staticView.result.current.kind).toBe('static');

      mockReadOnly.mockReturnValue(true);
      const unavailable = renderHook(() => useMCPAppFrame(appResource(), { defaultHeight: 100 }));
      expect(unavailable.result.current.kind).toBe('unavailable');

      const missing = renderHook(() => useMCPAppFrame(undefined, { defaultHeight: 100 }));
      expect(missing.result.current.kind).toBe('empty');
    });

    it('fails closed when a distinct sandbox origin is not configured', () => {
      const { getMCPSandboxUrl } = jest.requireMock('~/utils/mcpApps') as {
        getMCPSandboxUrl: jest.Mock;
      };
      getMCPSandboxUrl.mockReturnValueOnce(undefined);
      const { result } = renderHook(() => useMCPAppFrame(appResource(), { defaultHeight: 100 }));

      expect(result.current.status).toBe('failed');
      expect(result.current.sandboxUrl).toBeUndefined();
      expect(result.current.canRetry).toBe(false);

      act(() => result.current.onRetry());
      expect(result.current.status).toBe('failed');
      expect(result.current.attempt).toBe(0);
    });

    it('resolves the sandbox from the authenticated runtime policy', () => {
      const runtimeUrl = 'https://mcp-sandbox.example.com/api/mcp/sandbox';
      const { getMCPSandboxUrl } = jest.requireMock('~/utils/mcpApps') as {
        getMCPSandboxUrl: jest.Mock;
      };
      mockUseMCPAppsPolicy.mockReturnValue({
        enabled: true,
        legacyHtmlEnabled: true,
        sandboxUrl: runtimeUrl,
      });

      const { result } = renderHook(() => useMCPAppFrame(appResource(), { defaultHeight: 100 }));

      expect(getMCPSandboxUrl).toHaveBeenCalledWith(runtimeUrl);
      expect(result.current.sandboxUrl).toBe('http://sandbox.localhost:3081/api/mcp/sandbox');
    });

    it('does not expose a frame or active bridge when Apps are disabled', () => {
      mockUseMCPAppsPolicy.mockReturnValue({ enabled: false, legacyHtmlEnabled: false });
      const { result } = renderHook(() =>
        useMCPAppFrame(appResource({ text: '<p>stored app</p>' }), { defaultHeight: 100 }),
      );

      expect(result.current.kind).toBe('empty');
      expect(result.current.sandboxUrl).toBeUndefined();
      expect(result.current.active).toBe(false);
    });
  });

  describe('height', () => {
    it('is always definite so the iframe height resolves before any size report', () => {
      const { result } = renderHook(() => useMCPAppFrame(appResource(), { defaultHeight: 360 }));
      expect(result.current.height).toBe(360);
      expect(result.current.status).toBe('loading');
    });

    it('clamps a reported size into the surface bounds', () => {
      const { result } = renderHook(() =>
        useMCPAppFrame(appResource(), {
          defaultHeight: 360,
          maxHeight: MAX_CAROUSEL_VIEW_HEIGHT,
        }),
      );

      act(() => result.current.onSizeChanged({ height: 500 }));
      expect(result.current.height).toBe(500);
      expect(result.current.status).toBe('ready');

      act(() => result.current.onSizeChanged({ height: 1_000_000 }));
      expect(result.current.height).toBe(MAX_CAROUSEL_VIEW_HEIGHT);

      act(() => result.current.onSizeChanged({ height: 12 }));
      expect(result.current.height).toBe(MIN_APP_VIEW_HEIGHT);
    });

    it.each([[0], [-5], [Number.NaN], [undefined]])(
      'leaves an unusable size report (%s) in the loading state',
      (height) => {
        const { result } = renderHook(() => useMCPAppFrame(appResource(), { defaultHeight: 360 }));
        act(() => result.current.onSizeChanged({ height }));
        expect(result.current.status).toBe('loading');
        expect(result.current.height).toBe(360);
      },
    );

    it('reports the clamped height to the surface that owns the container', () => {
      const onHeightChange = jest.fn();
      const { result } = renderHook(() =>
        useMCPAppFrame(appResource(), { defaultHeight: 360, onHeightChange }),
      );
      act(() => result.current.onSizeChanged({ height: 400 }));
      expect(onHeightChange).toHaveBeenCalledWith(400);
    });
  });

  describe('reveal budget', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('spans the resource read as well as the handshake', () => {
      const { result } = renderHook(() => useMCPAppFrame(appResource(), { defaultHeight: 100 }));
      act(() => {
        jest.advanceTimersByTime(APP_REVEAL_TIMEOUT_MS - 1);
      });
      expect(result.current.status).toBe('loading');

      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(result.current.status).toBe('timedOut');
    });

    it('is not armed for static or placeholder renders', () => {
      const { result } = renderHook(() =>
        useMCPAppFrame(
          appResource({ toolName: undefined, serverName: undefined, text: '<p>x</p>' }),
          { defaultHeight: 100 },
        ),
      );
      act(() => {
        jest.advanceTimersByTime(APP_REVEAL_TIMEOUT_MS * 2);
      });
      expect(result.current.status).toBe('loading');
    });

    it('is disarmed once the app is ready', () => {
      const { result } = renderHook(() => useMCPAppFrame(appResource(), { defaultHeight: 100 }));
      act(() => result.current.onLoaded());
      act(() => {
        jest.advanceTimersByTime(APP_REVEAL_TIMEOUT_MS * 2);
      });
      expect(result.current.status).toBe('ready');
    });
  });

  describe('status transitions', () => {
    it('reports a read failure separately from the reveal budget', () => {
      const { result } = renderHook(() => useMCPAppFrame(appResource(), { defaultHeight: 100 }));
      act(() => result.current.onFailed());
      expect(result.current.status).toBe('failed');
    });

    it('starts one fresh attempt after a terminal failure', () => {
      const { result } = renderHook(() => useMCPAppFrame(appResource(), { defaultHeight: 320 }));
      act(() => result.current.onFailed());
      expect(result.current.status).toBe('failed');
      expect(result.current.canRetry).toBe(true);
      const staleRetry = result.current.onRetry;

      act(() => result.current.onRetry());
      expect(result.current.status).toBe('loading');
      expect(result.current.height).toBe(320);
      expect(result.current.attempt).toBe(1);
      expect(result.current.canRetry).toBe(false);

      act(() => staleRetry());
      expect(result.current.attempt).toBe(1);
    });

    it('starts one fresh attempt after the reveal budget expires', () => {
      jest.useFakeTimers();
      const { result } = renderHook(() => useMCPAppFrame(appResource(), { defaultHeight: 320 }));
      act(() => jest.advanceTimersByTime(APP_REVEAL_TIMEOUT_MS));
      expect(result.current.status).toBe('timedOut');

      act(() => result.current.onRetry());
      expect(result.current.status).toBe('loading');
      expect(result.current.height).toBe(320);
      expect(result.current.attempt).toBe(1);
      jest.useRealTimers();
    });

    it('does not downgrade a ready app on a late failure', () => {
      const { result } = renderHook(() => useMCPAppFrame(appResource(), { defaultHeight: 100 }));
      act(() => result.current.onLoaded());
      act(() => result.current.onFailed());
      expect(result.current.status).toBe('ready');
    });

    it('latches teardown so a late load cannot re-mount the bridge', () => {
      const onTornDown = jest.fn();
      const { result } = renderHook(() =>
        useMCPAppFrame(appResource(), { defaultHeight: 100, onTornDown }),
      );
      act(() => result.current.onFailed());
      const staleRetry = result.current.onRetry;
      act(() => result.current.onTeardown());
      expect(result.current.status).toBe('tornDown');
      expect(result.current.active).toBe(false);
      expect(onTornDown).toHaveBeenCalled();

      act(() => result.current.onRetry());
      expect(result.current.status).toBe('tornDown');
      expect(result.current.attempt).toBe(0);

      act(() => staleRetry());
      expect(result.current.status).toBe('tornDown');
      expect(result.current.attempt).toBe(0);

      act(() => result.current.onLoaded());
      act(() => result.current.onSizeChanged({ height: 400 }));
      expect(result.current.status).toBe('tornDown');
      expect(result.current.active).toBe(false);
    });

    it('resets when the html revision changes at a reused identity', () => {
      const { result, rerender } = renderHook(
        ({ resource }: { resource: UIResource }) =>
          useMCPAppFrame(resource, { defaultHeight: 100 }),
        { initialProps: { resource: appResource({ text: '<p>v1</p>' }) } },
      );
      act(() => result.current.onSizeChanged({ height: 500 }));
      expect(result.current.status).toBe('ready');

      rerender({ resource: appResource({ text: '<p>v2</p>' }) });
      expect(result.current.status).toBe('loading');
      expect(result.current.height).toBe(100);
    });
  });

  describe('tool arguments', () => {
    it('resolves the string and object forms to one shape', () => {
      const parsed = renderHook(() =>
        useMCPAppFrame(appResource(), { defaultHeight: 100, toolArgs: '{"a":1}' }),
      );
      expect(parsed.result.current.toolArgs).toEqual({ a: 1 });

      const passthrough = renderHook(() =>
        useMCPAppFrame(appResource(), { defaultHeight: 100, toolArgs: { a: 1 } }),
      );
      expect(passthrough.result.current.toolArgs).toEqual({ a: 1 });

      const malformed = renderHook(() =>
        useMCPAppFrame(appResource(), { defaultHeight: 100, toolArgs: 'not json' }),
      );
      expect(malformed.result.current.toolArgs).toBeUndefined();
    });

    it('falls back to the args persisted on the resource', () => {
      const { result } = renderHook(() =>
        useMCPAppFrame(appResource({ toolArgs: { b: 2 } } as Partial<UIResource>), {
          defaultHeight: 100,
        }),
      );
      expect(result.current.toolArgs).toEqual({ b: 2 });
    });
  });
});

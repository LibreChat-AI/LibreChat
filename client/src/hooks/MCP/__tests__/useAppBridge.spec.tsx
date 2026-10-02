import React from 'react';
import { RecoilRoot } from 'recoil';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, renderHook, screen, act } from '@testing-library/react';
import type { TStartupConfig, UIResource } from 'librechat-data-provider';
import {
  callMCPAppTool,
  fetchMCPResourceHtml,
  listMCPResources,
  listMCPResourceTemplates,
  readMCPResource,
  validateMCPAppBinding,
} from '~/utils/mcpApps';
import { MCPAppsPolicyProvider } from '~/Providers/MCPAppsPolicyContext';
import { MCPAppFrame } from '~/components/MCPUIResource/MCPAppFrame';
import { useMCPAppFrame } from '~/hooks/MCP/useMCPAppFrame';
import { useAppBridge } from '~/hooks/MCP/useAppBridge';
import { useIsMessagesViewReadOnly } from '~/Providers';

type Listener = (params: unknown) => void;
const requestExtra = () => ({ signal: new AbortController().signal });
type RequestHandler = (
  params: Record<string, unknown>,
  extra: ReturnType<typeof requestExtra>,
) => Promise<unknown>;
const mockAsk = jest.fn();
const mockApproveAction = jest.fn();

class FakeAppBridge {
  static instances: FakeAppBridge[] = [];

  capabilities: Record<string, unknown>;
  listeners = new Map<string, Listener[]>();
  connected: unknown = null;
  closed = false;
  resourceReady: Array<Record<string, unknown>> = [];
  toolInput: unknown[] = [];
  toolResults: unknown[] = [];
  hostContextChanges: unknown[] = [];
  teardowns = 0;
  onopenlink?: (
    params: { url: string },
    extra: ReturnType<typeof requestExtra>,
  ) => Promise<unknown>;

  oninitialized?: () => Promise<void>;
  oncalltool?: RequestHandler;
  onreadresource?: RequestHandler;
  onlistresources?: RequestHandler;
  onlistresourcetemplates?: RequestHandler;
  onmessage?: RequestHandler;

  constructor(
    _transport: unknown,
    _info: unknown,
    capabilities: Record<string, unknown>,
    _options: unknown,
  ) {
    this.capabilities = capabilities;
    FakeAppBridge.instances.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  emit(type: string, params: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(params);
    }
  }

  async connect(transport: unknown) {
    this.connected = transport;
  }

  close() {
    this.closed = true;
  }

  async sendSandboxResourceReady(params: Record<string, unknown>) {
    this.resourceReady.push(params);
  }

  async sendToolInput(params: unknown) {
    this.toolInput.push(params);
  }

  async sendToolResult(params: unknown) {
    this.toolResults.push(params);
  }

  async sendHostContextChange(params: unknown) {
    this.hostContextChanges.push(params);
  }

  async teardownResource() {
    this.teardowns += 1;
    return {};
  }
}

jest.mock('@modelcontextprotocol/ext-apps/app-bridge', () => ({
  AppBridge: jest.fn(),
  PostMessageTransport: jest.fn().mockImplementation((post: unknown, listen: unknown) => ({
    post,
    listen,
  })),
  buildAllowAttribute: (permissions?: Record<string, unknown>) =>
    ['camera', 'microphone', 'geolocation', 'clipboardWrite']
      .filter((key) => permissions?.[key])
      .map((key) => (key === 'clipboardWrite' ? 'clipboard-write' : key))
      .join('; '),
}));

jest.mock('~/utils/mcpApps', () => ({
  ...jest.requireActual('~/utils/mcpApps'),
  getMCPSandboxUrl: jest.fn(() => 'http://sandbox.localhost:3081/api/mcp/sandbox'),
  fetchMCPResourceHtml: jest.fn(),
  callMCPAppTool: jest.fn(),
  readMCPResource: jest.fn(),
  listMCPResources: jest.fn(),
  listMCPResourceTemplates: jest.fn(),
  validateMCPAppBinding: jest.fn(),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<number, string>) =>
    key === 'com_ui_mcp_app_frame_title' ? `MCP App: ${values?.[0] ?? ''}` : key,
}));

const mockPreviewLimit = jest.fn((): number | undefined => undefined);

jest.mock('~/Providers', () => ({
  useOptionalMessagesOperations: () => ({ ask: mockAsk }),
  useIsMessagesViewReadOnly: jest.fn(() => false),
  useMCPAppsPolicy: () => ({
    enabled: true,
    legacyHtmlEnabled: true,
    cspLimits: { maxSourcesPerDirective: 32, maxSerializedLength: 4096 },
    maxActionPreviewChars: mockPreviewLimit(),
  }),
}));

const { AppBridge } = jest.requireMock('@modelcontextprotocol/ext-apps/app-bridge') as {
  AppBridge: jest.Mock;
};
const mockFetchHtml = fetchMCPResourceHtml as jest.MockedFunction<typeof fetchMCPResourceHtml>;
const mockCallTool = callMCPAppTool as jest.MockedFunction<typeof callMCPAppTool>;
const mockReadResource = readMCPResource as jest.MockedFunction<typeof readMCPResource>;
const mockListResources = listMCPResources as jest.MockedFunction<typeof listMCPResources>;
const mockListTemplates = listMCPResourceTemplates as jest.MockedFunction<
  typeof listMCPResourceTemplates
>;
const mockValidateBinding = validateMCPAppBinding as jest.MockedFunction<
  typeof validateMCPAppBinding
>;
const mockReadOnly = useIsMessagesViewReadOnly as jest.MockedFunction<
  typeof useIsMessagesViewReadOnly
>;

const SANDBOX_URL =
  'http://localhost:3080/api/mcp/sandbox?parentOrigin=http%3A%2F%2Flocalhost%3A3080';

const enabledConfig = {
  mcpApps: { enabled: true, legacyHtmlEnabled: true },
} as TStartupConfig;

const makeResource = (overrides: Partial<UIResource> = {}): UIResource =>
  ({
    resourceId: 'r1',
    uri: 'ui://app/main',
    mimeType: 'text/html;profile=mcp-app',
    toolName: 'render',
    serverName: 'demo',
    serverBinding: 'binding-demo',
    ...overrides,
  }) as UIResource;

function BridgeFrameHarness({ resource, userId }: { resource: UIResource; userId: string }) {
  const frame = useMCPAppFrame(resource, { defaultHeight: 320, toolArgs: { q: 1 } });
  useAppBridge({
    iframeRef: frame.iframeRef,
    resource,
    toolArgs: frame.toolArgs,
    toolResult: frame.toolResult,
    userId,
    attempt: frame.attempt,
    active: frame.active,
    onSizeChanged: frame.onSizeChanged,
    onLoaded: frame.onLoaded,
    onTeardown: frame.onTeardown,
    onFailed: frame.onFailed,
  });

  return (
    <div data-testid={`surface-${resource.toolName}`} style={{ height: frame.height }}>
      <MCPAppFrame frame={frame} resource={resource} />
    </div>
  );
}

function mountBridge(
  resource: UIResource,
  client: QueryClient,
  callbacks: {
    onFailed?: () => void;
    onTeardown?: () => void;
    userId?: string;
    withoutApproval?: boolean;
  } = {},
) {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('data-sandbox-url', SANDBOX_URL);
  document.body.appendChild(iframe);
  const iframeRef = { current: iframe };
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <RecoilRoot>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </RecoilRoot>
  );
  const view = renderHook(
    () =>
      useAppBridge({
        iframeRef,
        resource,
        toolArgs: { q: 1 },
        toolResult: { content: [] },
        userId: callbacks.userId,
        onRequestAction: callbacks.withoutApproval ? undefined : mockApproveAction,
        attempt: 0,
        onSizeChanged: jest.fn(),
        onLoaded: jest.fn(),
        onTeardown: callbacks.onTeardown ?? jest.fn(),
        onFailed: callbacks.onFailed ?? jest.fn(),
      }),
    { wrapper },
  );
  return { iframe, view };
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const latest = () => FakeAppBridge.instances[FakeAppBridge.instances.length - 1];

describe('useAppBridge', () => {
  let client: QueryClient;

  beforeEach(() => {
    FakeAppBridge.instances = [];
    AppBridge.mockImplementation(
      (t: unknown, i: unknown, c: Record<string, unknown>, o: unknown) =>
        new FakeAppBridge(t, i, c, o),
    );
    mockReadOnly.mockReturnValue(false);
    mockAsk.mockReset();
    mockApproveAction.mockReset().mockResolvedValue(true);
    mockPreviewLimit.mockReturnValue(undefined);
    mockFetchHtml.mockResolvedValue({ html: '<p>app</p>' });
    mockValidateBinding.mockResolvedValue();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    document.body.innerHTML = '';
    document.documentElement.className = '';
  });

  describe('ordering', () => {
    it('retries one failed View through a fresh bridge without replacing its iframe or sibling', async () => {
      const target = makeResource({
        resourceId: 'target',
        uri: 'ui://app/target',
        toolName: 'target',
      });
      const sibling = makeResource({
        resourceId: 'sibling',
        uri: 'ui://app/sibling',
        toolName: 'sibling',
      });
      let targetReads = 0;
      mockFetchHtml.mockImplementation(async (_server, _binding, uri) => {
        if (uri === target.uri && targetReads++ === 0) {
          throw new Error('temporary read failure');
        }
        return { html: `<p>${uri}</p>` };
      });
      const lifecycle: string[] = [];
      let bridgeIndex = 0;
      AppBridge.mockImplementation(
        (
          transport: unknown,
          info: unknown,
          capabilities: Record<string, unknown>,
          options: unknown,
        ) => {
          const current = bridgeIndex++;
          const bridge = new FakeAppBridge(transport, info, capabilities, options);
          if (current === 0) {
            const close = bridge.close.bind(bridge);
            bridge.close = () => {
              lifecycle.push('old-close');
              close();
            };
          } else if (current === 2) {
            const connect = bridge.connect.bind(bridge);
            bridge.connect = async (nextTransport: unknown) => {
              lifecycle.push('new-connect');
              await connect(nextTransport);
            };
          }
          return bridge;
        },
      );

      render(
        <RecoilRoot>
          <QueryClientProvider client={client}>
            <MCPAppsPolicyProvider startupConfig={enabledConfig} ready userId="user-1">
              <BridgeFrameHarness resource={target} userId="user-1" />
              <BridgeFrameHarness resource={sibling} userId="user-1" />
            </MCPAppsPolicyProvider>
          </QueryClientProvider>
        </RecoilRoot>,
      );
      await flush();

      const firstTargetBridge = FakeAppBridge.instances[0];
      const siblingBridge = FakeAppBridge.instances[1];
      const targetFrame = screen.getByTitle('MCP App: target');
      const siblingFrame = screen.getByTitle('MCP App: sibling');
      expect(targetFrame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
      targetFrame.dataset.retryAnchor = 'target';
      siblingFrame.dataset.retryAnchor = 'sibling';
      expect(screen.getByRole('button', { name: 'com_ui_retry' })).toBeVisible();

      fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
      await flush();

      const replacement = FakeAppBridge.instances[2];
      expect(lifecycle).toEqual(['old-close', 'new-connect']);
      expect(firstTargetBridge.closed).toBe(true);
      expect(siblingBridge.closed).toBe(false);
      expect(screen.getByTitle('MCP App: target')).toBe(targetFrame);
      expect(screen.getByTitle('MCP App: sibling')).toBe(siblingFrame);
      expect(targetFrame.dataset.retryAnchor).toBe('target');
      expect(siblingFrame.dataset.retryAnchor).toBe('sibling');

      await act(async () => replacement.emit('sandboxready'));
      await flush();
      await act(async () => replacement.oninitialized?.());
      await flush();

      expect(replacement.toolInput).toEqual([{ arguments: { q: 1 } }]);
      expect(replacement.toolResults).toEqual([{ content: [] }]);
      expect(screen.queryByRole('button', { name: 'com_ui_retry' })).not.toBeInTheDocument();
      expect(screen.getByTestId('surface-target')).toHaveStyle({ height: '320px' });

      await act(async () => firstTargetBridge.oninitialized?.());
      act(() => firstTargetBridge.emit('sizechange', { height: 999 }));
      expect(firstTargetBridge.toolInput).toHaveLength(0);
      expect(screen.getByTestId('surface-target')).toHaveStyle({ height: '320px' });

      act(() => replacement.emit('sizechange', { height: 260 }));
      expect(screen.getByTestId('surface-target')).toHaveStyle({ height: '260px' });
      expect(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.queryKey)
          .filter((key) => key[0] === 'mcpAppResourceHtml' && key[3] === target.uri)
          .map((key) => key.at(-1)),
      ).toEqual([0, 1]);
    });

    it('tears down an initialized bridge before replacing its host identity', async () => {
      const iframe = document.createElement('iframe');
      iframe.setAttribute('data-sandbox-url', SANDBOX_URL);
      document.body.appendChild(iframe);
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <RecoilRoot>
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        </RecoilRoot>
      );
      const view = renderHook(
        ({ userId }: { userId: string }) =>
          useAppBridge({
            iframeRef: { current: iframe },
            resource: makeResource(),
            toolArgs: { q: 1 },
            toolResult: { content: [] },
            userId,
            attempt: 0,
            onSizeChanged: jest.fn(),
          }),
        { wrapper, initialProps: { userId: 'user-alpha' } },
      );
      await flush();
      const first = latest();
      await act(async () => first.oninitialized?.());
      const lifecycle: string[] = [];
      const closeFirst = first.close.bind(first);
      first.close = () => {
        lifecycle.push('old-close');
        closeFirst();
      };
      AppBridge.mockImplementationOnce(
        (t: unknown, i: unknown, c: Record<string, unknown>, o: unknown) => {
          const replacement = new FakeAppBridge(t, i, c, o);
          const connectReplacement = replacement.connect.bind(replacement);
          replacement.connect = async (transport: unknown) => {
            lifecycle.push('new-connect');
            await connectReplacement(transport);
          };
          return replacement;
        },
      );

      view.rerender({ userId: 'user-beta' });
      await flush();

      expect(first.teardowns).toBe(1);
      expect(first.closed).toBe(true);
      expect(FakeAppBridge.instances).toHaveLength(2);
      expect(mockFetchHtml).toHaveBeenCalledTimes(2);
      expect(lifecycle).toEqual(['old-close', 'new-connect']);
      expect(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.queryKey)
          .filter((key) => key[0] === 'mcpAppResourceHtml')
          .map((key) => key[5]),
      ).toEqual(['user-alpha', 'user-beta']);
    });

    it('connects the transport before the sandbox document is requested', async () => {
      let resolveHtml: (value: { html: string }) => void = () => {};
      mockFetchHtml.mockReturnValue(
        new Promise((resolve) => {
          resolveHtml = resolve;
        }) as ReturnType<typeof fetchMCPResourceHtml>,
      );
      const { iframe } = mountBridge(makeResource(), client);
      await flush();

      expect(latest().connected).not.toBeNull();
      expect(iframe.getAttribute('src')).toBeNull();

      await act(async () => {
        resolveHtml({ html: '<p>app</p>' });
        await Promise.resolve();
      });
      await flush();
      expect(iframe.src).toContain('/api/mcp/sandbox');
    });

    it('validates persisted inline html before assigning or sending it', async () => {
      let resolveValidation: () => void = () => {};
      mockValidateBinding.mockReturnValue(
        new Promise<void>((resolve) => {
          resolveValidation = resolve;
        }),
      );
      const { iframe } = mountBridge(makeResource({ text: '<p>persisted</p>' }), client);
      await flush();

      expect(latest().connected).not.toBeNull();
      expect(iframe.getAttribute('src')).toBeNull();
      expect(latest().resourceReady).toHaveLength(0);
      expect(mockValidateBinding).toHaveBeenCalledWith(
        'demo',
        'binding-demo',
        expect.any(AbortSignal),
      );

      await act(async () => {
        resolveValidation();
        await Promise.resolve();
      });
      await flush();
      expect(iframe.src).toContain('/api/mcp/sandbox');

      await act(async () => latest().emit('sandboxready'));
      await flush();
      expect(latest().resourceReady[0].html).toBe('<p>persisted</p>');
    });

    it('keeps unbound persisted html inert', async () => {
      const onFailed = jest.fn();
      const { iframe } = mountBridge(
        makeResource({ serverBinding: undefined, text: '<p>old app</p>' }),
        client,
        { onFailed },
      );
      await flush();

      expect(onFailed).toHaveBeenCalledTimes(1);
      expect(FakeAppBridge.instances).toHaveLength(0);
      expect(mockValidateBinding).not.toHaveBeenCalled();
      expect(iframe.getAttribute('src')).toBeNull();
      expect(iframe.getAttribute('allow')).toBeNull();
    });

    it('cancels an inline binding validation without loading late html', async () => {
      let resolveValidation: () => void = () => {};
      mockValidateBinding.mockReturnValue(
        new Promise<void>((resolve) => {
          resolveValidation = resolve;
        }),
      );
      const { iframe, view } = mountBridge(makeResource({ text: '<p>persisted</p>' }), client);
      await flush();
      const requestSignal = mockValidateBinding.mock.calls[0][2];

      act(() => view.unmount());
      await flush();
      expect(requestSignal?.aborted).toBe(true);

      await act(async () => {
        resolveValidation();
        await Promise.resolve();
      });
      expect(iframe.getAttribute('src')).toBeNull();
      expect(latest().resourceReady).toHaveLength(0);
    });

    it('unloads an old document while a replacement binding is validated', async () => {
      let resolveReplacement: () => void = () => {};
      mockValidateBinding.mockResolvedValueOnce().mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveReplacement = resolve;
        }),
      );
      const iframe = document.createElement('iframe');
      iframe.setAttribute('data-sandbox-url', SANDBOX_URL);
      document.body.appendChild(iframe);
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <RecoilRoot>
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        </RecoilRoot>
      );
      const view = renderHook(
        ({ resource }: { resource: UIResource }) =>
          useAppBridge({
            iframeRef: { current: iframe },
            resource,
            toolArgs: undefined,
            toolResult: undefined,
            attempt: 0,
            onSizeChanged: jest.fn(),
          }),
        {
          wrapper,
          initialProps: {
            resource: makeResource({ serverBinding: 'binding-old', text: '<p>old</p>' }),
          },
        },
      );
      await flush();
      expect(iframe.src).toContain('/api/mcp/sandbox');
      const oldBridge = latest();

      view.rerender({
        resource: makeResource({ serverBinding: 'binding-new', text: '<p>new</p>' }),
      });
      await flush();

      expect(oldBridge.closed).toBe(true);
      expect(iframe.getAttribute('src')).toBeNull();
      expect(mockValidateBinding).toHaveBeenLastCalledWith(
        'demo',
        'binding-new',
        expect.any(AbortSignal),
      );

      await act(async () => {
        resolveReplacement();
        await Promise.resolve();
      });
      await flush();
      expect(iframe.src).toContain('/api/mcp/sandbox');
    });

    it('carries the resolved csp to the sandbox response boundary', async () => {
      mockFetchHtml.mockResolvedValue({
        html: '<p>app</p>',
        csp: { connectDomains: ['https://api.example.com'] },
      });
      const { iframe } = mountBridge(makeResource(), client);
      await flush();

      const csp = new URL(iframe.src).searchParams.get('csp');
      expect(JSON.parse(csp as string)).toEqual({ connectDomains: ['https://api.example.com'] });
    });

    it('forwards only permissions supported by the opaque inner frame', async () => {
      mockFetchHtml.mockResolvedValue({
        html: '<p>app</p>',
        permissions: {
          camera: {},
          microphone: {},
          geolocation: {},
          clipboardWrite: {},
        },
      });
      const { iframe } = mountBridge(makeResource(), client);
      await flush();

      expect(iframe.getAttribute('allow')).toBe('geolocation; clipboard-write');
      await act(async () => latest().emit('sandboxready'));
      await flush();
      expect(latest().resourceReady[0].permissions).toEqual({
        geolocation: {},
        clipboardWrite: {},
      });
    });

    it('removes an ineffective media-only allow attribute', async () => {
      mockFetchHtml.mockResolvedValue({
        html: '<p>app</p>',
        permissions: { camera: {}, microphone: {} },
      });
      const { iframe } = mountBridge(makeResource(), client);
      iframe.setAttribute('allow', 'camera; microphone');
      await flush();

      expect(iframe.getAttribute('allow')).toBeNull();
    });

    it('sends the resource once even when the proxy announces twice', async () => {
      mountBridge(makeResource(), client);
      await flush();

      await act(async () => {
        latest().emit('sandboxready');
        latest().emit('sandboxready');
      });
      await flush();
      expect(latest().resourceReady).toHaveLength(1);
      expect(latest().resourceReady[0].html).toBe('<p>app</p>');
    });

    it('attaches no bridge and no src when cancelled mid-fetch', async () => {
      let resolveHtml: (value: { html: string }) => void = () => {};
      mockFetchHtml.mockReturnValue(
        new Promise((resolve) => {
          resolveHtml = resolve;
        }) as ReturnType<typeof fetchMCPResourceHtml>,
      );
      const { iframe, view } = mountBridge(makeResource(), client);
      await flush();
      const requestSignal = mockFetchHtml.mock.calls[0][3];
      act(() => view.unmount());
      await flush();

      expect(requestSignal?.aborted).toBe(true);
      await act(async () => {
        resolveHtml({ html: '<p>app</p>' });
        await Promise.resolve();
      });
      expect(iframe.getAttribute('src')).toBeNull();
      expect(latest().closed).toBe(true);
    });
  });

  describe('refetching changed html (3745939818)', () => {
    it('reads again on a later mount instead of serving a stale document', async () => {
      mockFetchHtml.mockResolvedValueOnce({ html: '<p>v1</p>' });
      const first = mountBridge(makeResource(), client);
      await flush();
      await act(async () => latest().emit('sandboxready'));
      await flush();
      expect(latest().resourceReady[0].html).toBe('<p>v1</p>');
      first.view.unmount();

      mockFetchHtml.mockResolvedValueOnce({ html: '<p>v2</p>' });
      mountBridge(makeResource(), client);
      await flush();
      await act(async () => latest().emit('sandboxready'));
      await flush();

      expect(mockFetchHtml).toHaveBeenCalledTimes(2);
      expect(latest().resourceReady[0].html).toBe('<p>v2</p>');
    });

    it('cancels only the leaving View when peers read the same resource', async () => {
      const requests: Array<{
        signal?: AbortSignal;
        resolve: (value: { html: string }) => void;
      }> = [];
      mockFetchHtml.mockImplementation(
        (_server, _binding, _uri, signal) =>
          new Promise((resolve) => requests.push({ signal, resolve })) as ReturnType<
            typeof fetchMCPResourceHtml
          >,
      );
      const first = mountBridge(makeResource(), client);
      const second = mountBridge(makeResource(), client);
      await flush();
      expect(requests).toHaveLength(2);

      act(() => first.view.unmount());
      await flush();
      expect(requests[0].signal?.aborted).toBe(true);
      expect(requests[1].signal?.aborted).toBe(false);

      await act(async () => requests[1].resolve({ html: '<p>peer survives</p>' }));
      await flush();
      expect(second.iframe.src).toContain('/api/mcp/sandbox');
    });

    it('does not report an old read failure into a replacement View', async () => {
      let rejectFirst: (reason: Error) => void = () => {};
      mockFetchHtml
        .mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              rejectFirst = reject;
            }) as ReturnType<typeof fetchMCPResourceHtml>,
        )
        .mockResolvedValueOnce({ html: '<p>replacement</p>' });
      const iframe = document.createElement('iframe');
      iframe.setAttribute('data-sandbox-url', SANDBOX_URL);
      document.body.appendChild(iframe);
      const firstFailed = jest.fn();
      const replacementFailed = jest.fn();
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <RecoilRoot>
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        </RecoilRoot>
      );
      const view = renderHook(
        ({ resource, onFailed }: { resource: UIResource; onFailed: () => void }) =>
          useAppBridge({
            iframeRef: { current: iframe },
            resource,
            toolArgs: undefined,
            toolResult: undefined,
            attempt: 0,
            onSizeChanged: jest.fn(),
            onFailed,
          }),
        {
          wrapper,
          initialProps: { resource: makeResource(), onFailed: firstFailed },
        },
      );
      await flush();

      view.rerender({
        resource: makeResource({ resourceId: 'r2', uri: 'ui://app/replacement' }),
        onFailed: replacementFailed,
      });
      await flush();
      rejectFirst(new Error('old read failed'));
      await flush();

      expect(firstFailed).not.toHaveBeenCalled();
      expect(replacementFailed).not.toHaveBeenCalled();
      expect(iframe.src).toContain('/api/mcp/sandbox');
    });
  });

  describe('failure handling', () => {
    it('retries on the next proxy announcement instead of latching', async () => {
      mockFetchHtml.mockRejectedValueOnce(new Error('boom'));
      mountBridge(makeResource(), client);
      await flush();
      expect(latest().resourceReady).toHaveLength(0);

      mockFetchHtml.mockResolvedValueOnce({ html: '<p>after retry</p>' });
      await act(async () => latest().emit('sandboxready'));
      await flush();
      await act(async () => latest().emit('sandboxready'));
      await flush();

      expect(latest().resourceReady).toHaveLength(1);
      expect(latest().resourceReady[0].html).toBe('<p>after retry</p>');
    });

    it('treats empty html as a failure', async () => {
      mockFetchHtml.mockResolvedValue({ html: '' });
      const onFailed = jest.fn();
      const iframe = document.createElement('iframe');
      iframe.setAttribute('data-sandbox-url', SANDBOX_URL);
      document.body.appendChild(iframe);
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <RecoilRoot>
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        </RecoilRoot>
      );
      renderHook(
        () =>
          useAppBridge({
            iframeRef: { current: iframe },
            resource: makeResource(),
            toolArgs: undefined,
            toolResult: undefined,
            attempt: 0,
            onSizeChanged: jest.fn(),
            onFailed,
          }),
        { wrapper },
      );
      await flush();
      await act(async () => latest().emit('sandboxready'));
      await flush();

      expect(latest().resourceReady).toHaveLength(0);
      expect(onFailed).toHaveBeenCalled();
    });
  });

  describe('read-only views', () => {
    it('never resolves app html from the viewer server for a resourceUri-only app', async () => {
      mockReadOnly.mockReturnValue(true);
      const { iframe } = mountBridge(makeResource(), client);
      await flush();
      await act(async () => latest().emit('sandboxready'));
      await flush();

      expect(mockFetchHtml).not.toHaveBeenCalled();
      expect(iframe.getAttribute('src')).toBeNull();
      expect(latest().resourceReady).toHaveLength(0);
    });

    it('runs inline html with no host-bound capabilities', async () => {
      mockReadOnly.mockReturnValue(true);
      mountBridge(makeResource({ text: '<p>inline</p>' }), client);
      await flush();
      await act(async () => latest().emit('sandboxready'));
      await flush();

      expect(mockFetchHtml).not.toHaveBeenCalled();
      expect(mockValidateBinding).toHaveBeenCalledWith(
        'demo',
        'binding-demo',
        expect.any(AbortSignal),
      );
      expect(latest().resourceReady[0].html).toBe('<p>inline</p>');
      expect(latest().capabilities.serverTools).toBeUndefined();
      expect(latest().capabilities.openLinks).toEqual({});
    });
  });

  describe('openLink authorization', () => {
    let openSpy: jest.SpyInstance;

    beforeEach(() => {
      openSpy = jest.spyOn(window, 'open').mockImplementation(() => null);
    });

    it('denies a link before the sandbox document has any policy', async () => {
      let resolveHtml: (value: { html: string }) => void = () => {};
      mockFetchHtml.mockReturnValue(
        new Promise((resolve) => {
          resolveHtml = resolve;
        }) as ReturnType<typeof fetchMCPResourceHtml>,
      );
      mountBridge(
        makeResource({
          csp: { connectDomains: ['https://api.example.com'] },
        } as Partial<UIResource>),
        client,
      );
      await flush();

      await act(async () => {
        await latest().onopenlink?.({ url: 'https://api.example.com/x' }, requestExtra());
      });
      expect(openSpy).not.toHaveBeenCalled();
      await act(async () => {
        resolveHtml({ html: '<p>app</p>' });
        await Promise.resolve();
      });
    });

    it('refuses a link the tool-result copy grants but the delivered policy does not', async () => {
      mockFetchHtml.mockResolvedValue({
        html: '<p>app</p>',
        csp: { connectDomains: ['https://other.example'] },
      });
      mountBridge(
        makeResource({
          csp: { connectDomains: ['https://api.example.com'] },
        } as Partial<UIResource>),
        client,
      );
      await flush();

      let result: unknown;
      await act(async () => {
        result = await latest().onopenlink?.({ url: 'https://api.example.com/x' }, requestExtra());
      });
      expect(result).toEqual({ isError: true });
      expect(openSpy).not.toHaveBeenCalled();

      await act(async () => {
        result = await latest().onopenlink?.({ url: 'https://other.example/x' }, requestExtra());
      });
      expect(result).toEqual({});
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(openSpy).toHaveBeenCalledWith(
        'https://other.example/x',
        '_blank',
        'noopener,noreferrer',
      );
    });

    it('uses the same capped declaration for the sandbox and host link decisions', async () => {
      const connectDomains = Array.from(
        { length: 400 },
        (_unused, index) => `https://host${index}.example.com`,
      );
      mockFetchHtml.mockResolvedValue({ html: '<p>app</p>', csp: { connectDomains } });
      const { iframe } = mountBridge(makeResource(), client);
      await flush();

      const csp = JSON.parse(new URL(iframe.src).searchParams.get('csp') as string);
      expect(csp.connectDomains).toHaveLength(32);
      await act(async () => {
        await latest().onopenlink?.({ url: 'https://host0.example.com/x' }, requestExtra());
      });
      expect(openSpy).toHaveBeenCalledTimes(1);
      await act(async () => {
        await latest().onopenlink?.({ url: 'https://host399.example.com/x' }, requestExtra());
      });
      expect(openSpy).toHaveBeenCalledTimes(1);
    });

    it('denies every link after a failed read', async () => {
      mockFetchHtml.mockRejectedValue(new Error('boom'));
      mountBridge(
        makeResource({
          csp: { connectDomains: ['https://api.example.com'] },
        } as Partial<UIResource>),
        client,
      );
      await flush();

      await act(async () => {
        await latest().onopenlink?.({ url: 'https://api.example.com/x' }, requestExtra());
      });
      expect(openSpy).not.toHaveBeenCalled();
    });

    it('refuses an otherwise allowed link after View disposal', async () => {
      mockFetchHtml.mockResolvedValue({
        html: '<p>app</p>',
        csp: { connectDomains: ['https://api.example.com'] },
      });
      const { view } = mountBridge(makeResource(), client);
      await flush();
      const bridge = latest();
      view.unmount();
      await expect(
        bridge.onopenlink?.({ url: 'https://api.example.com/x' }, requestExtra()),
      ).resolves.toEqual({ isError: true });
      expect(openSpy).not.toHaveBeenCalled();
    });

    it('reports cancellation and thrown browser failures', async () => {
      mockFetchHtml.mockResolvedValue({
        html: '<p>app</p>',
        csp: { connectDomains: ['https://api.example.com'] },
      });
      mountBridge(makeResource(), client);
      await flush();
      const controller = new AbortController();
      controller.abort();

      await expect(
        latest().onopenlink?.({ url: 'https://api.example.com/x' }, { signal: controller.signal }),
      ).resolves.toEqual({ isError: true });
      openSpy.mockImplementationOnce(() => {
        throw new Error('browser failure');
      });
      await expect(
        latest().onopenlink?.({ url: 'https://api.example.com/x' }, requestExtra()),
      ).resolves.toEqual({ isError: true });
    });
  });

  describe('host request forwarding', () => {
    it('propagates each SDK request signal to the matching server operation', async () => {
      mockCallTool.mockResolvedValue({ content: [] });
      mockReadResource.mockResolvedValue({ contents: [] });
      mockListResources.mockResolvedValue({ resources: [] });
      mockListTemplates.mockResolvedValue({ resourceTemplates: [] });
      mountBridge(makeResource(), client);
      await flush();
      const extra = requestExtra();

      await latest().oncalltool?.({ name: 'next', arguments: { q: 2 } }, extra);
      await latest().onreadresource?.({ uri: 'ui://detail' }, extra);
      await latest().onlistresources?.({ cursor: 'a' }, extra);
      await latest().onlistresourcetemplates?.({ cursor: 'b' }, extra);

      expect(mockCallTool).toHaveBeenCalledWith(
        'demo',
        'binding-demo',
        'next',
        { q: 2 },
        expect.any(AbortSignal),
      );
      expect(mockReadResource).toHaveBeenCalledWith(
        'demo',
        'binding-demo',
        'ui://detail',
        expect.any(AbortSignal),
      );
      expect(mockListResources).toHaveBeenCalledWith(
        'demo',
        'binding-demo',
        'a',
        expect.any(AbortSignal),
      );
      expect(mockListTemplates).toHaveBeenCalledWith(
        'demo',
        'binding-demo',
        'b',
        expect.any(AbortSignal),
      );
    });

    it('aborts active resource operations and denies new requests after View disposal', async () => {
      mockReadResource.mockResolvedValue({ contents: [] });
      mockListResources.mockResolvedValue({ resources: [] });
      mockListTemplates.mockResolvedValue({ resourceTemplates: [] });
      const { view } = mountBridge(makeResource(), client);
      await flush();
      const bridge = latest();
      await bridge.onreadresource?.({ uri: 'ui://detail' }, requestExtra());
      await bridge.onlistresources?.({ cursor: 'a' }, requestExtra());
      await bridge.onlistresourcetemplates?.({ cursor: 'b' }, requestExtra());
      const readSignal = mockReadResource.mock.calls[0][3];
      const resourcesSignal = mockListResources.mock.calls[0][3];
      const templatesSignal = mockListTemplates.mock.calls[0][3];
      expect(readSignal?.aborted).toBe(false);
      view.unmount();
      expect(readSignal?.aborted).toBe(true);
      expect(resourcesSignal?.aborted).toBe(true);
      expect(templatesSignal?.aborted).toBe(true);
      await expect(
        bridge.onreadresource?.({ uri: 'ui://detail' }, requestExtra()),
      ).rejects.toMatchObject({ name: 'AbortError' });
      await expect(bridge.onlistresources?.({ cursor: 'a' }, requestExtra())).rejects.toMatchObject(
        { name: 'AbortError' },
      );
      await expect(
        bridge.onlistresourcetemplates?.({ cursor: 'b' }, requestExtra()),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(mockReadResource).toHaveBeenCalledTimes(1);
      expect(mockListResources).toHaveBeenCalledTimes(1);
      expect(mockListTemplates).toHaveBeenCalledTimes(1);
    });

    it('denies App tool and message actions without a host approval control', async () => {
      const view = mountBridge(makeResource(), client, { withoutApproval: true });
      await flush();
      // A caller outside an active host View has no approval authority.
      const bridge = latest();
      expect(await bridge.oncalltool?.({ name: 'next', arguments: {} }, requestExtra())).toEqual({
        content: [],
        isError: true,
      });
      expect(
        await bridge.onmessage?.({ content: [{ type: 'text', text: 'submit' }] }, requestExtra()),
      ).toEqual({ isError: true });
      expect(mockApproveAction).not.toHaveBeenCalled();
      expect(mockCallTool).not.toHaveBeenCalled();
      expect(mockAsk).not.toHaveBeenCalled();
      view.view.unmount();
    });

    it('submits only approved App text without draining staged composer context', async () => {
      let grant: ((allowed: boolean) => void) | undefined;
      mockApproveAction.mockImplementation(
        () =>
          new Promise((resolve) => {
            grant = resolve;
          }),
      );
      const { view } = mountBridge(makeResource(), client);
      await flush();
      const pending = latest().onmessage?.(
        {
          content: [
            { type: 'text', text: 'approved' },
            { type: 'text', text: 'message' },
          ],
        },
        requestExtra(),
      );
      await flush();
      expect(mockApproveAction).toHaveBeenCalledWith(
        { kind: 'message', serverName: 'demo', text: 'approved\nmessage' },
        expect.any(AbortSignal),
      );
      expect(mockAsk).not.toHaveBeenCalled();
      grant?.(true);
      await expect(pending).resolves.toEqual({});
      expect(mockAsk).toHaveBeenCalledTimes(1);
      expect(mockAsk).toHaveBeenCalledWith(
        { text: 'approved\nmessage' },
        {
          overrideFiles: [],
          overrideManualSkills: [],
          overrideQuotes: [],
          overrideReasoning: null,
        },
      );
      view.unmount();
    });

    it('acknowledges an accepted turn even when the App aborts immediately afterward', async () => {
      const { view } = mountBridge(makeResource(), client);
      await flush();
      const controller = new AbortController();
      mockAsk.mockImplementationOnce(() => {
        controller.abort();
        return undefined;
      });
      const result = await latest().onmessage?.(
        { content: [{ type: 'text', text: 'approved turn' }] },
        { signal: controller.signal },
      );
      expect(mockApproveAction).toHaveBeenCalledTimes(1);
      expect(mockAsk).toHaveBeenCalledTimes(1);
      expect(result).toEqual({});
      view.unmount();
    });

    it('does not ask for approval for a whitespace-only App message', async () => {
      const { view } = mountBridge(makeResource(), client);
      await flush();
      const result = await latest().onmessage?.(
        { content: [{ type: 'text', text: '  ' }] },
        requestExtra(),
      );
      expect(result).toEqual({ isError: true });
      expect(mockApproveAction).not.toHaveBeenCalled();
      expect(mockAsk).not.toHaveBeenCalled();
      view.unmount();
    });

    it('uses the published preview limit for both tool arguments and chat messages', async () => {
      mockCallTool.mockResolvedValue({ content: [] });
      mockPreviewLimit.mockReturnValue(10);
      const { view } = mountBridge(makeResource(), client);
      await flush();
      const bridge = latest();
      expect(
        await bridge.oncalltool?.({ name: 'next', arguments: { query: 42 } }, requestExtra()),
      ).toEqual({ content: [], isError: true });
      expect(
        await bridge.onmessage?.(
          { content: [{ type: 'text', text: 'more than ten' }] },
          requestExtra(),
        ),
      ).toEqual({ isError: true });
      expect(mockApproveAction).not.toHaveBeenCalled();
      await bridge.oncalltool?.({ name: 'next', arguments: { q: 2 } }, requestExtra());
      await bridge.onmessage?.({ content: [{ type: 'text', text: 'ten chars!' }] }, requestExtra());
      expect(mockApproveAction).toHaveBeenCalledTimes(2);
      expect(mockCallTool).toHaveBeenCalledTimes(1);
      expect(mockAsk).toHaveBeenCalledTimes(1);
      view.unmount();
    });

    it('waits for permission and executes the exact arguments shown to the host once', async () => {
      let grant: ((allowed: boolean) => void) | undefined;
      mockApproveAction.mockImplementation(
        () =>
          new Promise((resolve) => {
            grant = resolve;
          }),
      );
      const { view } = mountBridge(makeResource(), client);
      await flush();
      const args = { q: 2 };
      const request = latest().oncalltool?.({ name: 'next', arguments: args }, requestExtra());
      await flush();
      expect(mockApproveAction).toHaveBeenCalledWith(
        { kind: 'tool', serverName: 'demo', toolName: 'next', argumentsText: '{"q":2}' },
        expect.any(AbortSignal),
      );
      args.q = 42;
      expect(mockCallTool).not.toHaveBeenCalled();
      grant?.(true);
      await request;
      expect(mockCallTool).toHaveBeenCalledWith(
        'demo',
        'binding-demo',
        'next',
        { q: 2 },
        expect.any(AbortSignal),
      );
      view.unmount();
    });

    it('does not run a tool if approval settles after View disposal', async () => {
      let grant: ((allowed: boolean) => void) | undefined;
      mockApproveAction.mockImplementation(
        () =>
          new Promise((resolve) => {
            grant = resolve;
          }),
      );
      const { view } = mountBridge(makeResource(), client);
      await flush();
      const request = latest().oncalltool?.({ name: 'next', arguments: {} }, requestExtra());
      await flush();
      view.unmount();
      grant?.(true);
      await expect(request).resolves.toEqual({ content: [], isError: true });
      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('reports unsupported or rejected message delivery as an error', async () => {
      mountBridge(makeResource(), client);
      await flush();
      const bridge = latest();

      await expect(
        bridge.onmessage?.({ content: [{ type: 'image' }] }, requestExtra()),
      ).resolves.toEqual({ isError: true });
      mockAsk.mockReturnValueOnce(false);
      await expect(
        bridge.onmessage?.({ content: [{ type: 'text', text: 'hello' }] }, requestExtra()),
      ).resolves.toEqual({ isError: true });
    });
  });

  describe('teardown', () => {
    it('revokes pending tool approval before awaiting App-controlled teardown', async () => {
      let grant: ((allowed: boolean) => void) | undefined;
      let finishTeardown: (() => void) | undefined;
      mockApproveAction.mockImplementation(
        () =>
          new Promise((resolve) => {
            grant = resolve;
          }),
      );
      const { view } = mountBridge(makeResource(), client);
      await flush();
      const bridge = latest();
      await bridge.oninitialized?.();
      bridge.teardownResource = jest.fn(
        () =>
          new Promise<Record<string, never>>((resolve) => {
            finishTeardown = () => resolve({});
          }),
      );
      const pending = bridge.oncalltool?.({ name: 'next', arguments: { id: 1 } }, requestExtra());
      await flush();
      bridge.emit('requestteardown');
      grant?.(true);
      await expect(pending).resolves.toEqual({ content: [], isError: true });
      expect(mockCallTool).not.toHaveBeenCalled();
      finishTeardown?.();
      await flush();
      view.unmount();
    });

    it('does not deliver an awaited teardown completion after the View was disposed', async () => {
      const onTeardown = jest.fn();
      const mounted = mountBridge(makeResource(), client, { onTeardown });
      await flush();
      const bridge = latest();
      await bridge.oninitialized?.();
      let finishTeardown: () => void = () => {};
      bridge.teardownResource = jest.fn(
        () => new Promise<Record<string, never>>((resolve) => (finishTeardown = () => resolve({}))),
      );

      act(() => bridge.emit('requestteardown'));
      act(() => mounted.view.unmount());
      finishTeardown();
      await flush();

      expect(onTeardown).not.toHaveBeenCalled();
    });

    it('disposes the bridge and the theme observer on requestteardown', async () => {
      const onTeardown = jest.fn();
      const iframe = document.createElement('iframe');
      iframe.setAttribute('data-sandbox-url', SANDBOX_URL);
      document.body.appendChild(iframe);
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <RecoilRoot>
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        </RecoilRoot>
      );
      renderHook(
        () =>
          useAppBridge({
            iframeRef: { current: iframe },
            resource: makeResource(),
            toolArgs: undefined,
            toolResult: undefined,
            attempt: 0,
            onSizeChanged: jest.fn(),
            onTeardown,
          }),
        { wrapper },
      );
      await flush();

      const bridge = latest();
      await act(async () => bridge.oninitialized?.());
      await act(async () => bridge.emit('requestteardown'));
      await flush();

      expect(bridge.teardowns).toBeGreaterThan(0);
      expect(bridge.closed).toBe(true);
      expect(onTeardown).toHaveBeenCalled();

      await act(async () => {
        document.documentElement.classList.add('dark');
        await Promise.resolve();
      });
      expect(bridge.hostContextChanges).toHaveLength(0);
    });

    it('pushes theme changes to a live bridge', async () => {
      mountBridge(makeResource(), client);
      await flush();

      await act(async () => {
        document.documentElement.classList.add('dark');
        await Promise.resolve();
      });
      expect(latest().hostContextChanges).toHaveLength(1);
    });
  });

  describe('handshake payloads', () => {
    it('sends tool input before the tool result on initialize', async () => {
      mountBridge(makeResource(), client);
      await flush();
      await act(async () => {
        await latest().oninitialized?.();
      });
      expect(latest().toolInput).toEqual([{ arguments: { q: 1 } }]);
      expect(latest().toolResults).toEqual([{ content: [] }]);
    });

    it('sends tool lifecycle data only once if initialized repeats', async () => {
      mountBridge(makeResource(), client);
      await flush();
      await latest().oninitialized?.();
      await latest().oninitialized?.();
      expect(latest().toolInput).toHaveLength(1);
      expect(latest().toolResults).toHaveLength(1);
    });
  });
});

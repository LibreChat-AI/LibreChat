import { useEffect, useId, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import { QueryKeys, DEFAULT_MCP_APP_ACTION_PREVIEW_CHARS } from 'librechat-data-provider';
import { AppBridge, buildAllowAttribute } from '@modelcontextprotocol/ext-apps/app-bridge';
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpUiStyles, McpUiStyleVariableKey } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';
import type { UIResource } from 'librechat-data-provider';
import type { AppToolResult } from '~/utils/mcpApps';
import type { MCPAppAction } from './approval';
import {
  callMCPAppTool,
  fetchMCPResourceHtml,
  readMCPResource,
  listMCPResources,
  listMCPResourceTemplates,
  validateMCPAppBinding,
  getSupportedMCPAppPermissions,
  getInlineResourceHtml,
  isAllowedAppLink,
  withSandboxCsp,
} from '~/utils/mcpApps';
import {
  useOptionalMessagesOperations,
  useIsMessagesViewReadOnly,
  useMCPAppsPolicy,
} from '~/Providers';
import { logger } from '~/utils';

type MessageContentBlock = { type?: string; text?: string };

type SizeParams = { width?: number; height?: number };

type ResolvedResource = {
  html: string;
  csp: UIResource['csp'];
  permissions: UIResource['permissions'];
};

/** A source- and origin-validated transport that resolves the live iframe WindowProxy per event. */
class IframePostMessageTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
  sessionId?: string;
  setProtocolVersion?: (version: string) => void;

  constructor(private readonly getIframe: () => HTMLIFrameElement | null) {}

  private getTarget(): { window: Window; origin: string } | null {
    const iframe = this.getIframe();
    const target = iframe?.contentWindow;
    const src = iframe?.getAttribute('src');
    if (!target || !src) {
      return null;
    }
    try {
      return { window: target, origin: new URL(src, window.location.href).origin };
    } catch {
      return null;
    }
  }

  private readonly messageListener = (event: MessageEvent) => {
    const target = this.getTarget();
    if (!target || event.source !== target.window || event.origin !== target.origin) {
      return;
    }
    const parsed = JSONRPCMessageSchema.safeParse(event.data);
    if (parsed.success) {
      this.onmessage?.(parsed.data);
    } else if (event.data?.jsonrpc === '2.0') {
      this.onerror?.(new Error(`Invalid JSON-RPC message received: ${parsed.error.message}`));
    }
  };

  async start(): Promise<void> {
    window.addEventListener('message', this.messageListener);
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    const target = this.getTarget();
    if (!target) {
      throw new Error('MCP App iframe is unavailable');
    }
    target.window.postMessage(message, target.origin);
  }

  async close(): Promise<void> {
    window.removeEventListener('message', this.messageListener);
    this.onclose?.();
  }
}

export type UseAppBridgeParams = {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  resource: UIResource;
  toolArgs: Record<string, unknown> | undefined;
  toolResult: AppToolResult | undefined;
  userId?: string;
  /** Only a host-owned approval control may resolve this; missing control denies actions. */
  onRequestAction?: (action: MCPAppAction, signal: AbortSignal) => Promise<boolean>;
  onCancelAction?: () => void;
  /** View-owned retry generation. Each attempt gets an isolated bridge and resource query. */
  attempt: number;
  onSizeChanged: (params: SizeParams) => void;
  /** False once the app requested teardown, so the effect disposes instead of re-mounting a bridge. */
  active?: boolean;
  onLoaded?: () => void;
  onTeardown?: () => void;
  onFailed?: () => void;
};

/** Maps the MCP Apps standard host style tokens onto LibreChat's theme CSS variables. Apps keep
 * their own fallbacks for anything omitted, so a partial set is intentional. */
const HOST_STYLE_VAR_MAP: Partial<Record<McpUiStyleVariableKey, string>> = {
  '--color-background-primary': '--surface-primary',
  '--color-background-secondary': '--surface-secondary',
  '--color-background-tertiary': '--surface-tertiary',
  '--color-background-danger': '--surface-destructive',
  '--color-text-primary': '--text-primary',
  '--color-text-secondary': '--text-secondary',
  '--color-text-tertiary': '--text-tertiary',
  '--color-text-danger': '--text-destructive',
  '--color-text-warning': '--text-warning',
  '--color-border-primary': '--border-medium',
  '--color-border-secondary': '--border-light',
  '--color-border-danger': '--border-destructive',
};

function readHostTheme(): 'light' | 'dark' {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

function buildHostStyleVariables(): McpUiStyles {
  const computed = getComputedStyle(document.documentElement);
  const variables: Partial<Record<McpUiStyleVariableKey, string>> = {};
  for (const [specVar, lcVar] of Object.entries(HOST_STYLE_VAR_MAP)) {
    const value = computed.getPropertyValue(lcVar).trim();
    if (value) {
      variables[specVar as McpUiStyleVariableKey] = value;
    }
  }
  // The token record is optional/partial by design (apps fall back on any we omit); the generated
  // type requires every key, so assert the mapped subset.
  return variables as McpUiStyles;
}

export function useAppBridge({
  iframeRef,
  resource,
  toolArgs,
  toolResult,
  userId,
  onRequestAction,
  onCancelAction,
  attempt,
  onSizeChanged,
  active = true,
  onLoaded,
  onTeardown,
  onFailed,
}: UseAppBridgeParams) {
  const { ask } = useOptionalMessagesOperations();
  // Read-only views (shared transcripts, /search) must not let the embedded app proxy tool calls
  // or resource reads against the viewer's MCP servers with the viewer's auth.
  const readOnly = useIsMessagesViewReadOnly();
  const { cspLimits, maxActionPreviewChars } = useMCPAppsPolicy();
  const queryClient = useQueryClient();
  const viewId = useId();
  const effectGenerationRef = useRef(0);
  const activeEffectRef = useRef<{ generation: number; queryKey: string } | null>(null);
  // The csp actually delivered to the sandbox document, which is what bounds the app's own egress.
  // Host-opened links are authorized against this rather than the tool-result copy, so the host can
  // never open a link the sandbox policy did not grant.
  const effectiveCspRef = useRef<UIResource['csp']>(undefined);
  // The bridge mounts once per resource and reads these only inside its handlers, so a changed
  // callback or tool-call snapshot never tears down the live AppBridge. Synced at render time
  // (idempotent under Strict Mode) rather than via an effect that would only mirror props.
  const askRef = useRef(ask);
  const requestActionRef = useRef(onRequestAction);
  const cancelActionRef = useRef(onCancelAction);
  const maxActionPreviewCharsRef = useRef(maxActionPreviewChars);
  const onSizeChangedRef = useRef(onSizeChanged);
  const onLoadedRef = useRef(onLoaded);
  const onTeardownRef = useRef(onTeardown);
  const onFailedRef = useRef(onFailed);
  askRef.current = ask;
  requestActionRef.current = onRequestAction;
  cancelActionRef.current = onCancelAction;
  maxActionPreviewCharsRef.current = maxActionPreviewChars;
  onSizeChangedRef.current = onSizeChanged;
  onLoadedRef.current = onLoaded;
  onTeardownRef.current = onTeardown;
  onFailedRef.current = onFailed;
  useEffect(() => {
    const iframe = iframeRef.current;
    const serverName = resource.serverName;
    if (!iframe || !serverName || !active) return;
    const serverBinding = resource.serverBinding;
    if (!serverBinding) {
      iframe.removeAttribute('src');
      iframe.removeAttribute('allow');
      onFailedRef.current?.();
      return;
    }
    // A retry or binding change must unload the prior document before validating its replacement.
    // Do not remove a missing src from a freshly mounted iframe: Chromium may emit a synthetic
    // about:blank load for that mutation. On fast inline resources, that load can consume the
    // one-shot sandbox listener before the cross-origin sandbox document finishes navigating.
    if (iframe.hasAttribute('src')) {
      iframe.removeAttribute('src');
    }
    iframe.removeAttribute('allow');
    effectiveCspRef.current = undefined;
    // Unmount, a resource switch, or a teardown can run cleanup while a read or bridge.connect() is
    // still pending; this flag stops the pending continuation from touching a disposed bridge.
    let cancelled = false;
    const viewAbort = new AbortController();
    let resourceSent = false;
    let sendingResource = false;
    let initialized = false;
    let resolved: ResolvedResource | null = null;
    let srcCsp: UIResource['csp'] = undefined;
    const resourceQueryKey = [
      QueryKeys.mcpAppResourceHtml,
      serverName,
      serverBinding,
      resource.uri,
      resource.resourceId,
      userId,
      viewId,
      attempt,
    ] as const;
    const effectGeneration = ++effectGenerationRef.current;
    const resourceQueryKeyIdentity = JSON.stringify(resourceQueryKey);
    activeEffectRef.current = {
      generation: effectGeneration,
      queryKey: resourceQueryKeyIdentity,
    };

    const assignSandboxSrc = (csp: UIResource['csp']) => {
      const { url, applied } = withSandboxCsp(
        iframe.getAttribute('data-sandbox-url') ?? '',
        csp,
        cspLimits,
      );
      // srcCsp records what was requested (it guards against reloading the document in a loop);
      // effectiveCspRef records what the sandbox response was actually given.
      srcCsp = csp;
      effectiveCspRef.current = applied;
      if (csp && !applied) {
        logger.warn('[MCP App] Declared csp could not be delivered to the sandbox response');
      }
      iframe.src = url;
    };

    const applyOuterPermissions = (permissions: UIResource['permissions']) => {
      const allowAttr = buildAllowAttribute(
        permissions as Parameters<typeof buildAllowAttribute>[0],
      );
      if (allowAttr) {
        iframe.setAttribute('allow', allowAttr);
      } else {
        iframe.removeAttribute('allow');
      }
    };

    const { locale, timeZone } = Intl.DateTimeFormat().resolvedOptions();
    const bridge = new AppBridge(
      null,
      { name: 'LibreChat', version: '1.0.0' },
      {
        openLinks: {},
        logging: {},
        // Display-only views advertise no host-bound action capabilities so a well-behaved app
        // disables those affordances rather than issuing calls the host ignores.
        ...(!readOnly
          ? {
              serverTools: {},
              serverResources: {},
              message: { text: {} },
            }
          : {}),
      },
      {
        hostContext: {
          theme: readHostTheme(),
          platform: 'web',
          locale,
          timeZone,
          displayMode: 'inline',
          availableDisplayModes: ['inline'],
          styles: { variables: buildHostStyleVariables() },
        },
      },
    );

    let lastTheme = readHostTheme();
    const themeObserver = new MutationObserver(() => {
      if (cancelled) {
        return;
      }
      const nextTheme = readHostTheme();
      if (nextTheme === lastTheme) {
        return;
      }
      lastTheme = nextTheme;
      Promise.resolve(
        bridge.sendHostContextChange({
          theme: nextTheme,
          styles: { variables: buildHostStyleVariables() },
        }),
      ).catch((err: unknown) => logger.error('[MCP App] sendHostContextChange failed', err));
    });

    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      cancelled = true;
      viewAbort.abort();
      cancelActionRef.current?.();
      themeObserver.disconnect();
      bridge.close();
      // React Strict Mode immediately replays effects in development. Let an equivalent successor
      // share the in-flight resource read instead of cancelling the query it has just joined. A real
      // unmount, retry, or resource change has no same-key successor and still cancels promptly.
      queueMicrotask(() => {
        const successor = activeEffectRef.current;
        const isEquivalentReplay =
          successor != null &&
          successor.generation !== effectGeneration &&
          successor.queryKey === resourceQueryKeyIdentity;
        if (!isEquivalentReplay) {
          void queryClient.cancelQueries({ queryKey: resourceQueryKey, exact: true });
        }
      });
    };

    const interactive = !readOnly;
    // SDK callbacks may already be queued when a View closes or a peer starts teardown.
    // Deny new work and propagate View disposal to in-flight authenticated reads/lists.
    const liveRequestSignal = (signal: AbortSignal): AbortSignal => {
      if (cancelled || viewAbort.signal.aborted || signal.aborted) {
        throw new DOMException('MCP App View is closed', 'AbortError');
      }
      return AbortSignal.any([signal, viewAbort.signal]);
    };

    bridge.onopenlink = async ({ url }, { signal }) => {
      if (signal.aborted || viewAbort.signal.aborted || cancelled) {
        return { isError: true };
      }
      if (!isAllowedAppLink(url, effectiveCspRef.current, cspLimits)) {
        logger.warn('[MCP App] Blocked open-link outside the declared egress domains');
        return { isError: true };
      }
      try {
        window.open(url, '_blank', 'noopener,noreferrer');
        return {};
      } catch (error) {
        logger.error('[MCP App] Failed to open link', error);
        return { isError: true };
      }
    };

    // Host-bound actions (tool calls, resource reads/lists, model messages) run with the viewer's
    // auth, so they are only wired in interactive views, never in shared transcripts or /search.
    if (interactive) {
      bridge.oncalltool = async (params, { signal }) => {
        if (signal.aborted || viewAbort.signal.aborted || cancelled || !requestActionRef.current)
          return { content: [], isError: true };
        // Snapshot the arguments shown to the user: the App must not mutate them while waiting.
        let argumentsText: string;
        let args: Record<string, unknown>;
        try {
          argumentsText = JSON.stringify(params.arguments ?? {});
          if (
            !argumentsText ||
            argumentsText.length >
              (maxActionPreviewCharsRef.current ?? DEFAULT_MCP_APP_ACTION_PREVIEW_CHARS)
          )
            return { content: [], isError: true };
          args = JSON.parse(argumentsText) as Record<string, unknown>;
          if (!args || typeof args !== 'object' || Array.isArray(args))
            return { content: [], isError: true };
        } catch {
          return { content: [], isError: true };
        }
        const toolName = params.name;
        try {
          const actionSignal = AbortSignal.any([signal, viewAbort.signal]);
          const allowed = await requestActionRef.current(
            { kind: 'tool', serverName, toolName, argumentsText },
            actionSignal,
          );
          if (!allowed || actionSignal.aborted || cancelled) return { content: [], isError: true };
          return await callMCPAppTool(serverName, serverBinding, toolName, args, actionSignal);
        } catch (error) {
          logger.error('[MCP App] Tool action failed', error);
          return { content: [], isError: true };
        }
      };

      bridge.onreadresource = async (params, { signal }) =>
        readMCPResource(serverName, serverBinding, params.uri, liveRequestSignal(signal));

      bridge.onlistresources = async (params, { signal }) =>
        listMCPResources(serverName, serverBinding, params?.cursor, liveRequestSignal(signal));

      bridge.onlistresourcetemplates = async (params, { signal }) =>
        listMCPResourceTemplates(
          serverName,
          serverBinding,
          params?.cursor,
          liveRequestSignal(signal),
        );

      bridge.onmessage = async ({ content }, { signal }) => {
        const text = (content as MessageContentBlock[])
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n');
        if (
          !text.trim() ||
          text.length >
            (maxActionPreviewCharsRef.current ?? DEFAULT_MCP_APP_ACTION_PREVIEW_CHARS) ||
          signal.aborted ||
          viewAbort.signal.aborted ||
          cancelled ||
          !requestActionRef.current
        ) {
          return { isError: true };
        }
        try {
          const actionSignal = AbortSignal.any([signal, viewAbort.signal]);
          const allowed = await requestActionRef.current(
            { kind: 'message', serverName, text },
            actionSignal,
          );
          if (!allowed || actionSignal.aborted || cancelled) return { isError: true };
          // The selected agent and MCP servers belong to the conversation. Only the
          // next composer's staged files, manual skill picks, quotes and reasoning
          // level are excluded.
          const accepted = askRef.current(
            { text },
            {
              overrideFiles: [],
              overrideManualSkills: [],
              overrideQuotes: [],
              overrideReasoning: null,
            },
          );
          if (accepted === false) {
            return { isError: true };
          }
          // ask accepted the turn synchronously. A later App abort cannot undo it;
          // claiming failure here encourages the App to retry and duplicate the turn.
          return {};
        } catch (error) {
          logger.error('[MCP App] Failed to deliver message', error);
          return { isError: true };
        }
      };
    }

    const resolveResource = async (): Promise<ResolvedResource | null> => {
      const inlineHtml = getInlineResourceHtml(resource);
      // Inline mcp-app resources already carry their HTML, so use it directly instead of a
      // resources/read round trip, but validate their persisted server binding before loading it.
      if (inlineHtml) {
        await queryClient.fetchQuery({
          queryKey: resourceQueryKey,
          queryFn: async ({ signal }) => {
            await validateMCPAppBinding(serverName, serverBinding, signal);
            return true;
          },
          staleTime: 0,
        });
        return {
          html: inlineHtml,
          csp: resource.csp,
          permissions: getSupportedMCPAppPermissions(resource.permissions),
        };
      }
      // Read-only views must not resolve app HTML from the viewer's MCP server.
      if (readOnly) {
        logger.debug(
          '[MCP App] Read-only view: skipping server HTML fetch for resourceUri-only app',
        );
        return null;
      }
      const fetched = await queryClient.fetchQuery({
        // The same ui:// URI can carry revised HTML on a later turn, and nothing invalidates this
        // cache entry. The View ID owns cancellation, while the remaining fields retain server,
        // resource, persisted-call, and user scope; zero stale time makes every later mount re-read.
        queryKey: resourceQueryKey,
        queryFn: ({ signal }) =>
          fetchMCPResourceHtml(serverName, serverBinding, resource.uri, signal),
        staleTime: 0,
      });
      return {
        html: fetched.html,
        csp: fetched.csp,
        permissions: getSupportedMCPAppPermissions(fetched.permissions),
      };
    };

    const sendResource = async () => {
      if (resourceSent || sendingResource || cancelled) {
        return;
      }
      sendingResource = true;
      try {
        const next = resolved ?? (await resolveResource());
        if (cancelled || !next) {
          return;
        }
        if (!next.html) {
          throw new Error('Resource returned no HTML');
        }
        resolved = next;
        applyOuterPermissions(next.permissions);
        // A retry that resolved a csp the current sandbox document was not served with would run the
        // app under the restrictive default policy; reload the document with the declared domains
        // and let its own announcement deliver the resource.
        if (next.csp && next.csp !== srcCsp) {
          assignSandboxSrc(next.csp);
          return;
        }
        resourceSent = true;
        await bridge.sendSandboxResourceReady({
          html: next.html,
          csp: next.csp as never,
          permissions: next.permissions as never,
          sandbox: 'allow-scripts allow-forms',
        });
      } catch (err) {
        resourceSent = false;
        logger.error('[MCP App] Failed to send sandbox resource', err);
        if (!cancelled) {
          onFailedRef.current?.();
        }
      } finally {
        sendingResource = false;
      }
    };

    // The proxy re-announces itself until it receives a resource, which is the only retry signal a
    // failed read gets; a latch here strands the frame behind the spinner forever.
    bridge.addEventListener('sandboxready', () => {
      void sendResource();
    });

    bridge.oninitialized = async () => {
      if (cancelled || initialized) {
        return;
      }
      initialized = true;
      // The app handshake completed: treat this as the load signal so apps that never emit a
      // size-change (auto-resize disabled) are still revealed instead of stuck behind the spinner.
      onLoadedRef.current?.();
      // MCP Apps expect tool input exactly once before the result, even for no-argument tools,
      // so apps that initialize from ontoolinput always receive it.
      await bridge
        .sendToolInput({ arguments: toolArgs ?? {} })
        .catch((err: unknown) => logger.error('[MCP App] sendToolInput failed', err));
      if (toolResult && !cancelled) {
        await bridge
          .sendToolResult(toolResult as never)
          .catch((err: unknown) => logger.error('[MCP App] sendToolResult failed', err));
      }
    };

    bridge.addEventListener('sizechange', (params) => {
      if (!cancelled) {
        onSizeChangedRef.current(params);
      }
    });

    bridge.addEventListener('requestteardown', async () => {
      if (cancelled) return;
      // A peer-controlled teardown handshake can stall. Revoke action authority before awaiting it.
      viewAbort.abort();
      cancelActionRef.current?.();
      if (initialized) {
        await bridge.teardownResource({}).catch(() => {});
      }
      if (cancelled) {
        return;
      }
      dispose();
      onTeardownRef.current?.();
    });

    bridge.addEventListener('loggingmessage', (event) => {
      const { level, data } = event as { level: string; data: unknown };
      logger.debug('[MCP App]', level, data);
    });

    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    const start = async () => {
      // Both sandbox policies are built from this URL before the document loads. The content-level
      // _meta.ui.csp is authoritative, which requires resolving the resource before navigation.
      const next = await resolveResource().catch((err: unknown) => {
        logger.error('[MCP App] Failed to read app resource', err);
        if (!cancelled) {
          onFailedRef.current?.();
        }
        return null;
      });
      if (cancelled) {
        return;
      }
      resolved = next;
      applyOuterPermissions(next?.permissions);
      // A failed read still loads the sandbox document: its re-announcements are the only retry
      // signal, and a later resolve reloads it with the declared domains.
      if (next || !readOnly) {
        // Start listening before navigation so a fresh iframe's synthetic about:blank load cannot
        // consume or race a one-shot load handler. The transport resolves and validates the live
        // iframe WindowProxy and exact sandbox origin for every message, so cross-origin navigation
        // cannot leave it bound to a stale window.
        await bridge
          .connect(new IframePostMessageTransport(() => iframeRef.current))
          .catch((err) => {
            logger.error('[MCP App] bridge.connect failed', err);
            if (!cancelled) {
              onFailedRef.current?.();
            }
            dispose();
          });
        if (cancelled) {
          return;
        }
        assignSandboxSrc(next?.csp);
      }
    };
    void start();

    return () => {
      cancelled = true;
      cancelActionRef.current?.();
      if (initialized) {
        bridge.teardownResource({}).catch(() => {});
      }
      dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    resource.resourceId,
    resource.serverBinding,
    resource.uri,
    resource.serverName,
    active,
    readOnly,
    userId,
    viewId,
    attempt,
    cspLimits?.maxSourcesPerDirective,
    cspLimits?.maxSerializedLength,
  ]);
}

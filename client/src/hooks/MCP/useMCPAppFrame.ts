import { useRef, useMemo, useState, useEffect, useCallback } from 'react';
import type { UIResource } from 'librechat-data-provider';
import type { AppToolResult } from '~/utils/mcpApps';
import {
  getMCPSandboxUrl,
  getResourceKey,
  buildAppToolResult,
  isMcpAppResource,
  getInlineResourceHtml,
  clampAppViewHeight,
} from '~/utils/mcpApps';
import { useMCPAppsPolicy } from '~/Providers/MCPAppsPolicyContext';
import { useIsMessagesViewReadOnly } from '~/Providers';

/** `timedOut` and `failed` are separate only because the user-facing copy differs: one is the reveal
 * budget expiring, the other is a resource read that came back unusable. */
export type MCPAppFrameStatus = 'loading' | 'ready' | 'timedOut' | 'failed' | 'tornDown';

/**
 * `app` runs the App Bridge handshake, `static` is inert srcDoc HTML, `unavailable` is a read-only
 * view of an app whose HTML only the viewer's own server could resolve, and `empty` has nothing to
 * render.
 */
export type MCPAppFrameKind = 'app' | 'static' | 'unavailable' | 'empty';

export type MCPAppFrameOptions = {
  /** Applied when the app has not reported a size, so the iframe's `height:100%` always resolves. */
  defaultHeight: number;
  maxHeight?: number;
  toolArgs?: string | Record<string, unknown>;
  onHeightChange?: (height: number) => void;
  onTornDown?: () => void;
};

export type MCPAppFrameState = {
  iframeRef: React.RefObject<HTMLIFrameElement>;
  status: MCPAppFrameStatus;
  kind: MCPAppFrameKind;
  height: number;
  attempt: number;
  canRetry: boolean;
  sandboxUrl?: string;
  inlineHtml?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: AppToolResult;
  active: boolean;
  onSizeChanged: (params: { height?: number; width?: number }) => void;
  onLoaded: () => void;
  onTeardown: () => void;
  onFailed: () => void;
  onRetry: () => void;
};

/**
 * Budget for the whole reveal path: the `resources/read`, the sandbox document, and the App Bridge
 * handshake. The read moved ahead of the document load so the per-resource CSP can be delivered as a
 * sandbox request, which put server latency inside this window.
 */
export const APP_REVEAL_TIMEOUT_MS = 20_000;

function parseToolArgs(
  args?: string | Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (args == null) {
    return undefined;
  }
  if (typeof args !== 'string') {
    return args;
  }
  try {
    return JSON.parse(args) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Render state for one MCP App view, shared by every surface that hosts one. A single status keeps
 * the mutually exclusive states (loaded and timed out, torn down and timed out) unreachable, and
 * scopes the reveal timer to app-backed views so static and placeholder renders never arm it.
 */
export function useMCPAppFrame(
  resource: UIResource | undefined,
  options: MCPAppFrameOptions,
): MCPAppFrameState {
  const { defaultHeight, maxHeight, toolArgs, onHeightChange, onTornDown } = options;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const readOnly = useIsMessagesViewReadOnly();
  const { enabled: mcpAppsEnabled, sandboxUrl: configuredSandboxUrl } = useMCPAppsPolicy();
  const [status, setStatus] = useState<MCPAppFrameStatus>('loading');
  const [height, setHeight] = useState<number | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const sandboxUrl = useMemo(() => getMCPSandboxUrl(configuredSandboxUrl), [configuredSandboxUrl]);
  const inlineHtml = useMemo(
    () => (resource ? getInlineResourceHtml(resource) : undefined),
    [resource],
  );
  const resourceKey = resource ? getResourceKey(resource) : '';

  // A revised document at a reused resource identity must render from a clean state, or the new HTML
  // is revealed at the previous revision's height.
  useEffect(() => {
    setStatus('loading');
    setHeight(undefined);
  }, [resourceKey, inlineHtml, resource?.serverBinding]);

  const kind: MCPAppFrameKind = useMemo(() => {
    if (!mcpAppsEnabled || !resource) {
      return 'empty';
    }
    if (isMcpAppResource(resource)) {
      return !inlineHtml && readOnly ? 'unavailable' : 'app';
    }
    return inlineHtml ? 'static' : 'empty';
  }, [mcpAppsEnabled, resource, inlineHtml, readOnly]);

  useEffect(() => {
    if (kind === 'app' && !sandboxUrl) {
      setStatus('failed');
    }
  }, [kind, sandboxUrl]);

  useEffect(() => {
    if (kind !== 'app' || status !== 'loading' || !sandboxUrl) {
      return;
    }
    const timer = setTimeout(() => setStatus('timedOut'), APP_REVEAL_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [kind, sandboxUrl, status]);

  const onSizeChanged = useCallback(
    (params: { height?: number; width?: number }) => {
      const clamped = clampAppViewHeight(params.height, { max: maxHeight });
      if (clamped == null) {
        return;
      }
      setHeight(clamped);
      setStatus((prev) => (prev === 'tornDown' ? prev : 'ready'));
      onHeightChange?.(clamped);
    },
    [maxHeight, onHeightChange],
  );

  const onLoaded = useCallback(
    () => setStatus((prev) => (prev === 'tornDown' ? prev : 'ready')),
    [],
  );

  const onFailed = useCallback(
    () => setStatus((prev) => (prev === 'loading' ? 'failed' : prev)),
    [],
  );

  const canRetry =
    kind === 'app' && sandboxUrl != null && (status === 'failed' || status === 'timedOut');
  const canRetryRef = useRef(canRetry);
  canRetryRef.current = canRetry;
  const onRetry = useCallback(() => {
    if (!canRetryRef.current) {
      return;
    }
    canRetryRef.current = false;
    setStatus('loading');
    setHeight(undefined);
    setAttempt((current) => current + 1);
  }, []);

  // One-way: a teardown must not be undone by a late load or size report, which would re-mount a
  // bridge onto a resource the app has already released.
  const onTeardown = useCallback(() => {
    canRetryRef.current = false;
    setStatus('tornDown');
    onTornDown?.();
  }, [onTornDown]);

  const resolvedToolArgs = useMemo(
    () => parseToolArgs(toolArgs ?? (resource?.toolArgs as Record<string, unknown> | undefined)),
    [toolArgs, resource?.toolArgs],
  );
  const toolResult = useMemo(
    () => (resource ? buildAppToolResult(resource) : undefined),
    [resource],
  );

  return {
    iframeRef,
    status,
    kind,
    height: height ?? defaultHeight,
    attempt,
    canRetry,
    sandboxUrl: mcpAppsEnabled ? sandboxUrl : undefined,
    inlineHtml,
    toolArgs: resolvedToolArgs,
    toolResult,
    active: mcpAppsEnabled && kind === 'app' && status !== 'tornDown',
    onSizeChanged,
    onLoaded,
    onTeardown,
    onFailed,
    onRetry,
  };
}

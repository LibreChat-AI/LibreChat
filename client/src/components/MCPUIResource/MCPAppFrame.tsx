import React from 'react';
import { Button, Spinner } from '@librechat/client';
import type { UIResource } from 'librechat-data-provider';
import type { MCPAppFrameState } from '~/hooks/MCP';
import { useLocalize } from '~/hooks';

const OVERLAY_CLASS =
  'absolute inset-0 flex items-center gap-2 rounded-lg border border-border-light bg-surface-secondary px-4 py-3 text-sm text-text-secondary';

/**
 * The bridge iframe for one MCP App view plus its loading and failure overlays. The surface owns the
 * positioned container (and its definite height); this owns everything that must stay identical
 * across surfaces, including the sandbox tokens and the reveal rule.
 */
export function MCPAppFrame({
  frame,
  resource,
  centered = false,
  spinner = false,
}: {
  frame: MCPAppFrameState;
  resource: UIResource;
  centered?: boolean;
  spinner?: boolean;
}) {
  const localize = useLocalize();
  const overlayClass = centered ? `${OVERLAY_CLASS} justify-center` : OVERLAY_CLASS;

  if (frame.kind !== 'app') {
    return null;
  }

  return (
    <>
      {frame.status === 'loading' && (
        <div className={overlayClass} role="status">
          {spinner && <Spinner className="size-4" aria-hidden="true" />}
          {localize('com_ui_loading_interactive_view')}
        </div>
      )}
      {(frame.status === 'timedOut' || frame.status === 'failed') && (
        <div className={overlayClass} role="alert">
          <span>
            {localize(
              frame.status === 'failed'
                ? 'com_ui_mcp_app_load_error'
                : 'com_ui_mcp_app_failed_to_load',
            )}
          </span>
          {frame.canRetry && (
            <Button type="button" variant="outline" size="sm" onClick={frame.onRetry}>
              {localize('com_ui_retry')}
            </Button>
          )}
        </div>
      )}
      {frame.sandboxUrl && (
        <iframe
          ref={frame.iframeRef}
          data-sandbox-url={frame.sandboxUrl}
          sandbox="allow-scripts allow-same-origin allow-forms"
          className={
            frame.status === 'ready' ? 'visible size-full border-0' : 'invisible size-full border-0'
          }
          title={localize('com_ui_mcp_app_frame_title', { 0: resource.toolName ?? '' })}
        />
      )}
    </>
  );
}

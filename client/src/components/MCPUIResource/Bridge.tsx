import React from 'react';
import type { UIResource } from 'librechat-data-provider';
import { MCPAppApproval, useMCPAppApproval } from '~/hooks/MCP/approval';
import { useMCPAppsHost } from '~/Providers/MCPAppsPolicyContext';
import { useAppBridge } from '~/hooks/MCP/useAppBridge';
import { useMCPAppFrame } from '~/hooks/MCP';
import { MCPAppFrame } from './MCPAppFrame';
import { useLocalize } from '~/hooks';

/**
 * An opened App view: its frame state, the App Bridge, and the approval dialog. This is the only
 * module that imports `useAppBridge`, so the bridge SDK downloads when a viewer opens an App
 * instead of with the entry page. It stays one component, so its hooks run in the order they
 * always did.
 */
export default function BridgedAppFrame({
  app,
  userId,
  close,
  closeButtonRef,
  openButtonRef,
  defaultHeight,
}: {
  app: UIResource;
  userId: string;
  close: (restoreFocus?: boolean) => void;
  closeButtonRef: React.RefObject<HTMLButtonElement>;
  openButtonRef: React.RefObject<HTMLButtonElement>;
  defaultHeight: number;
}) {
  const localize = useLocalize();
  const { policy } = useMCPAppsHost();
  // Reuse the deployment operation limit to bound requests awaiting consent in this View.
  const approval = useMCPAppApproval(policy.operationLimits?.maxActive);
  const frame = useMCPAppFrame(app, {
    defaultHeight,
    toolArgs: app.toolArgs,
  });
  useAppBridge({
    iframeRef: frame.iframeRef,
    resource: app,
    toolArgs: frame.toolArgs,
    toolResult: frame.toolResult,
    userId,
    onRequestAction: approval.request,
    onCancelAction: approval.cancel,
    attempt: frame.attempt,
    active: frame.active,
    onSizeChanged: frame.onSizeChanged,
    onLoaded: frame.onLoaded,
    onTeardown: () => {
      // A peer can tear down while the user is in its frame or approval dialog. Restore
      // their place without stealing focus if they have already moved elsewhere.
      const focusedInView =
        closeButtonRef.current?.parentElement?.contains(document.activeElement) ?? false;
      const focusedInApproval =
        approval.pending !== null &&
        document.activeElement?.closest('[role="alertdialog"]') != null;
      approval.cancel();
      close(focusedInView || focusedInApproval);
    },
    onFailed: frame.onFailed,
  });

  let body: React.ReactNode = null;
  if (frame.kind === 'unavailable') {
    body = (
      <div className="border-border-light bg-surface-secondary text-text-secondary my-2 flex items-center gap-2 rounded-lg border px-4 py-3 text-sm">
        {localize('com_ui_mcp_app_shared_unavailable')}
      </div>
    );
  } else if (frame.status !== 'tornDown') {
    body = (
      <div
        className="relative my-2 overflow-hidden"
        style={{ height: frame.height, width: frame.width, maxWidth: '100%' }}
      >
        <MCPAppFrame frame={frame} resource={app} spinner />
      </div>
    );
  }
  return (
    <>
      {body}
      <MCPAppApproval
        action={approval.pending}
        approve={approval.approve}
        cancel={approval.cancel}
        close={() => {
          approval.cancel();
          close();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          // The dialog has no persistent trigger. Return focus to the host View control.
          (openButtonRef.current ?? closeButtonRef.current)?.focus();
        }}
      />
    </>
  );
}

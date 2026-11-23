import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_MCP_APP_OPERATION_LIMITS } from 'librechat-data-provider';
import {
  AlertDialog,
  Button,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@librechat/client';
import type { ComponentProps } from 'react';
import { useLocalize } from '~/hooks';

export type MCPAppAction =
  | { kind: 'tool'; serverName: string; toolName: string; argumentsText: string }
  | { kind: 'message'; serverName: string; text: string };

type Pending = {
  action: MCPAppAction;
  settle: (allowed: boolean, notify?: boolean) => void;
};

/** An App can request an action but only a host-controlled button can grant it. */
export function useMCPAppApproval(maxPending = DEFAULT_MCP_APP_OPERATION_LIMITS.maxActive) {
  const [pending, setPending] = useState<Pending | null>(null);
  const queueRef = useRef<Pending[]>([]);
  const suspendedRef = useRef(false);
  const pause = useCallback((notify = true) => {
    suspendedRef.current = true;
    for (const entry of [...queueRef.current]) entry.settle(false, false);
    if (notify) setPending(null);
  }, []);
  const request = useCallback(
    (action: MCPAppAction, signal: AbortSignal): Promise<boolean> => {
      if (signal.aborted || suspendedRef.current || queueRef.current.length >= maxPending) {
        return Promise.resolve(false);
      }
      return new Promise<boolean>((resolve) => {
        const settle = (allowed: boolean, notify = true) => {
          const index = queueRef.current.indexOf(entry);
          if (index < 0) return;
          queueRef.current.splice(index, 1);
          signal.removeEventListener('abort', abort);
          if (notify) setPending(queueRef.current[0] ?? null);
          resolve(allowed && !signal.aborted);
        };
        const abort = () => {
          // A cancelled queued request is removed without disrupting the visible approval.
          // Cancelling the displayed request pauses the View to prevent prompt storms.
          if (queueRef.current[0] === entry) pause();
          else settle(false);
        };
        const entry: Pending = { action, settle };
        queueRef.current.push(entry);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        else setPending(queueRef.current[0]);
      });
    },
    [maxPending, pause],
  );
  const cancel = useCallback(() => {
    if (queueRef.current.length > 0) pause();
  }, [pause]);
  useEffect(() => {
    suspendedRef.current = false;
    return () => pause(false);
  }, [pause]);
  return {
    pending: pending?.action ?? null,
    request,
    cancel,
    approve: () => pending?.settle(true),
  };
}

export function MCPAppApproval({
  action,
  approve,
  cancel,
  close,
  onCloseAutoFocus,
}: {
  action: MCPAppAction | null;
  approve: () => void;
  cancel: () => void;
  close?: () => void;
  onCloseAutoFocus?: ComponentProps<typeof AlertDialogContent>['onCloseAutoFocus'];
}) {
  const localize = useLocalize();
  return (
    <AlertDialog
      open={action != null}
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
    >
      <AlertDialogContent className="w-11/12 max-w-lg" onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {localize(
              action?.kind === 'tool'
                ? 'com_ui_mcp_app_confirm_tool'
                : 'com_ui_mcp_app_confirm_message',
            )}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {localize('com_ui_mcp_app_action_warning')}{' '}
            {action?.kind === 'message' && <>{localize('com_ui_mcp_app_message_tool_context')} </>}
            {localize('com_ui_mcp_app_cancel_pauses')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {action && (
          <div className="text-text-primary max-h-64 overflow-auto text-sm">
            <p className="font-semibold">
              {action.serverName}
              {action.kind === 'tool' ? ` / ${action.toolName}` : ''}
            </p>
            <pre className="mt-2 break-all whitespace-pre-wrap">
              {action.kind === 'tool' ? action.argumentsText : action.text}
            </pre>
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel onClick={cancel}>{localize('com_ui_cancel')}</AlertDialogCancel>
          {close && (
            <AlertDialogCancel onClick={close}>{localize('com_ui_mcp_app_stop')}</AlertDialogCancel>
          )}
          <Button onClick={approve}>
            {localize(
              action?.kind === 'tool' ? 'com_ui_mcp_app_run_tool' : 'com_ui_mcp_app_send_message',
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MutationKeys, QueryKeys, dataService } from 'librechat-data-provider';
import { Button, Chip, OGDialog, OGDialogTemplate, Spinner } from '@librechat/client';
import type { SlackWorkspace } from 'librechat-data-provider';
import { watchOAuthSettlements } from '~/data-provider/PullRequest/signIn';
import { useSlackWorkspaces } from './useSlackWorkspaces';
import { channelErrorLabel } from '~/utils/channelErrors';
import { useAuthContext, useLocalize } from '~/hooks';
import Apps from './Apps';

function workspaceStatusLabel(workspace: SlackWorkspace, configured?: boolean) {
  if (workspace.status === 'disconnected') return 'com_ui_slack_workspaces_disconnected';
  if (configured) return 'com_ui_slack_workspaces_active';
  return 'com_ui_slack_workspaces_unavailable';
}

/** Org installations and personal identity links deliberately have separate ownership. */
export default function Workspaces() {
  const { user } = useAuthContext();
  if (!user) return null;
  const principalKey = JSON.stringify([user.tenantId ?? '_', user.id]);
  return <OwnedWorkspaces key={principalKey} principalKey={principalKey} />;
}

function OwnedWorkspaces({ principalKey }: { principalKey: string }) {
  const localize = useLocalize();
  const id = useId();
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [confirm, setConfirm] = useState<SlackWorkspace | null>(null);
  const actionRef = useRef<HTMLButtonElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const settingsRef = useRef<HTMLElement | null>(null);
  const flow = useRef<string | null>(null);
  const deadline = useRef<ReturnType<typeof setTimeout>>();
  const mounted = useRef(true);
  const refresh = useCallback(
    () =>
      Promise.all([
        client.invalidateQueries([QueryKeys.slackWorkspaces, principalKey]),
        client.invalidateQueries([QueryKeys.slackApps, principalKey]),
        client.invalidateQueries([QueryKeys.agentChannels]),
      ]),
    [client, principalKey],
  );
  const status = useSlackWorkspaces(principalKey);
  const connect = useMutation({
    mutationKey: [MutationKeys.slackWorkspaces, principalKey, 'connect'],
    mutationFn: (input: { workspaceId?: string; appId?: string }) =>
      dataService.connectSlackWorkspace(input.workspaceId, input.appId),
  });
  const retire = useMutation({
    mutationKey: [MutationKeys.slackWorkspaces, principalKey, 'retire'],
    mutationFn: (workspace: SlackWorkspace) =>
      workspace.status === 'disconnected'
        ? dataService.removeSlackWorkspace(workspace.workspaceId, workspace.revision)
        : dataService.disconnectSlackWorkspace(workspace.workspaceId, workspace.revision),
    onSettled: async () => {
      try {
        await refresh();
      } finally {
        setConfirm(null);
      }
    },
  });
  const cancel = useMutation({
    mutationKey: [MutationKeys.slackWorkspaces, principalKey, 'cancel'],
    mutationFn: (flowId: string) => dataService.cancelSlackWorkspaceInstall(flowId),
    onSuccess: async (_result, flowId) => {
      if (flow.current === flowId) {
        flow.current = null;
        clearTimeout(deadline.current);
        setPending(false);
      }
      await refresh();
    },
  });

  useEffect(() => {
    mounted.current = true;
    const stopSettlements = watchOAuthSettlements((data) => {
      if (!flow.current || data.flowId !== flow.current) return;
      flow.current = null;
      clearTimeout(deadline.current);
      setPending(false);
      setFailed(data.outcome === 'failed');
      void client.cancelQueries([QueryKeys.slackWorkspaces, principalKey]).then(() => refresh());
    });
    return () => {
      mounted.current = false;
      clearTimeout(deadline.current);
      stopSettlements();
      const pendingFlow = flow.current;
      flow.current = null;
      if (pendingFlow) void dataService.cancelSlackWorkspaceInstall(pendingFlow).catch(() => {});
    };
  }, [client, principalKey, refresh]);

  const start = (workspaceId?: string, appId?: string) => {
    setFailed(false);
    const popup = window.open('', '_blank');
    if (!popup) {
      setFailed(true);
      return;
    }
    popup.opener = null;
    connect.mutateAsync({ workspaceId, appId }).then(
      (result) => {
        if (!mounted.current || popup.closed) {
          popup.close();
          void dataService.cancelSlackWorkspaceInstall(result.flowId).catch(() => {});
          return;
        }
        let destination: URL;
        try {
          destination = new URL(result.url);
        } catch {
          popup.close();
          void dataService.cancelSlackWorkspaceInstall(result.flowId).catch(() => {});
          setFailed(true);
          return;
        }
        if (
          destination.origin !== 'https://slack.com' ||
          destination.pathname !== '/oauth/v2/authorize'
        ) {
          popup.close();
          void dataService.cancelSlackWorkspaceInstall(result.flowId).catch(() => {});
          setFailed(true);
          return;
        }
        flow.current = result.flowId;
        setPending(true);
        deadline.current = setTimeout(() => {
          flow.current = null;
          setPending(false);
          setFailed(true);
          void refresh();
        }, result.expiresInSeconds * 1000);
        popup.location.href = result.url;
      },
      () => {
        popup.close();
        if (mounted.current) setFailed(true);
      },
    );
  };

  const first = status.data?.pages[0];
  const workspaces = status.data?.pages.flatMap((page) => page.workspaces) ?? [];
  const activeTone = first?.configured ? 'success' : 'warning';
  if (first && !first.configured && workspaces.length === 0) return null;
  const confirmLabel =
    confirm?.status === 'disconnected'
      ? 'com_ui_slack_workspaces_remove_confirm'
      : 'com_ui_slack_workspaces_confirm';
  const confirmAction =
    confirm?.status === 'disconnected'
      ? 'com_ui_slack_workspaces_remove'
      : 'com_ui_slack_workspaces_disconnect';
  const busy = pending || connect.isLoading || retire.isLoading || cancel.isLoading;
  return (
    <section className="space-y-4" aria-labelledby={`${id}-title`}>
      <h2 ref={headingRef} tabIndex={-1} id={`${id}-title`} className="font-medium">
        {localize('com_ui_slack_workspaces_title')}
      </h2>
      <p className="text-text-secondary">{localize('com_ui_slack_workspaces_description')}</p>
      {status.isLoading && <Spinner />}
      {(status.isError || failed || retire.isError || cancel.isError) && (
        <div role="alert" className="space-y-2">
          <p>
            {localize(
              channelErrorLabel(
                connect.error ?? retire.error ?? cancel.error ?? status.error,
                'com_ui_slack_workspaces_error',
              ),
            )}
          </p>
          <Button
            variant="outline"
            onClick={() => {
              setFailed(false);
              connect.reset();
              retire.reset();
              cancel.reset();
              void status.refetch();
            }}
          >
            {localize('com_ui_retry')}
          </Button>
        </div>
      )}
      {pending && (
        <div className="space-y-2">
          <p role="status">{localize('com_ui_slack_workspaces_waiting')}</p>
          <Button
            variant="outline"
            disabled={cancel.isLoading}
            onClick={() => {
              if (flow.current) cancel.mutate(flow.current);
            }}
          >
            {localize('com_ui_cancel')}
          </Button>
        </div>
      )}
      {first?.configured && first.canManage && (
        <Apps
          principalKey={principalKey}
          busy={busy}
          onInstall={(appId) => start(undefined, appId)}
        />
      )}
      {first && !first.canManage && <p>{localize('com_ui_slack_workspaces_admin')}</p>}
      {first && workspaces.length === 0 && <p>{localize('com_ui_slack_workspaces_empty')}</p>}
      {workspaces.map((workspace) => (
        <div
          key={workspace.workspaceId}
          className="border-border-light space-y-2 rounded-lg border p-3"
        >
          <div className="flex items-start justify-between gap-3">
            <p className="min-w-0 font-medium break-words">{workspace.teamName}</p>
            <Chip
              tone={workspace.status === 'disconnected' ? 'neutral' : activeTone}
              className="shrink-0"
            >
              {localize(workspaceStatusLabel(workspace, first?.configured))}
            </Chip>
          </div>
          {first?.canManage && (
            <div className="flex flex-wrap gap-2">
              {first.configured && workspace.status === 'active' && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => start(workspace.workspaceId)}
                >
                  {localize('com_ui_slack_workspaces_reconnect')}
                </Button>
              )}
              <Button
                variant="outline"
                disabled={busy}
                onClick={(event) => {
                  actionRef.current = event.currentTarget;
                  settingsRef.current = event.currentTarget.closest<HTMLElement>('[role="dialog"]');
                  setConfirm(workspace);
                }}
              >
                {localize(
                  workspace.status === 'disconnected'
                    ? 'com_ui_slack_workspaces_remove'
                    : 'com_ui_slack_workspaces_disconnect',
                )}
              </Button>
            </div>
          )}
        </div>
      ))}
      {status.hasNextPage && (
        <Button
          variant="outline"
          disabled={status.isFetchingNextPage}
          onClick={() => void status.fetchNextPage()}
        >
          {localize('com_ui_slack_workspaces_more')}
        </Button>
      )}
      <OGDialog
        open={confirm !== null && first?.canManage === true}
        onOpenChange={(open) => {
          if (!open && !retire.isLoading) setConfirm(null);
        }}
      >
        <OGDialogTemplate
          className="max-w-md"
          footerClassName="sm:justify-between"
          title={localize(confirmAction)}
          description={confirm?.teamName}
          main={<p className="text-text-secondary text-sm">{localize(confirmLabel)}</p>}
          cancelDisabled={retire.isLoading}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (actionRef.current?.isConnected) actionRef.current.focus();
            else if (headingRef.current?.isConnected) headingRef.current.focus();
            else settingsRef.current?.focus();
          }}
          selection={
            <Button
              type="button"
              variant="destructive"
              disabled={busy || !confirm || first?.canManage !== true}
              aria-busy={retire.isLoading}
              onClick={() => {
                if (confirm) retire.mutate(confirm);
              }}
            >
              {retire.isLoading && <Spinner className="size-4" aria-hidden="true" />}
              {localize(confirmAction)}
            </Button>
          }
        />
      </OGDialog>
    </section>
  );
}

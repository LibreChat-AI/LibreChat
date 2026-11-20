import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link2Off, RotateCw, Trash2 } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MutationKeys, QueryKeys, dataService } from 'librechat-data-provider';
import {
  Alert,
  Button,
  Chip,
  IconButton,
  OGDialog,
  OGDialogTemplate,
  SlackIcon,
  Spinner,
  TooltipAnchor,
} from '@librechat/client';
import type { SlackWorkspace } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { watchOAuthSettlements } from '~/data-provider/PullRequest/signIn';
import { useSlackWorkspaces } from './useSlackWorkspaces';
import { channelErrorLabel } from '~/utils/channelErrors';
import { useAuthContext, useLocalize } from '~/hooks';
import BotManagers from './BotManagers';
import Loading from './Loading';
import Apps from './Apps';

function workspaceStatusLabel(workspace: SlackWorkspace, configured?: boolean) {
  if (workspace.status === 'disconnected') return 'com_ui_slack_workspaces_disconnected';
  if (configured) return 'com_ui_slack_workspaces_active';
  return 'com_ui_slack_workspaces_unavailable';
}

type ConnectionAttempt = {
  workspaceId?: string;
  appId?: string;
  popup: Window | null;
  retryPopup?: Window;
  flowId?: string;
  cancelling: boolean;
};

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
  const [connection, setConnection] = useState<'pending' | 'failed' | 'cancelling' | null>(null);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<SlackWorkspace | null>(null);
  const actionRef = useRef<HTMLElement | null>(null);
  const manageRef = useRef<HTMLButtonElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const settingsRef = useRef<HTMLElement | null>(null);
  const attempt = useRef<ConnectionAttempt | null>(null);
  const popupBlocked = useRef(false);
  const connectionTrigger = useRef<HTMLElement | null>(null);
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
  });

  const finish = () => {
    clearTimeout(deadline.current);
    attempt.current?.popup?.close();
    attempt.current?.retryPopup?.close();
    attempt.current = null;
    setConnection(null);
  };

  const retireAttempt = async (current: ConnectionAttempt) => {
    current.cancelling = true;
    current.popup?.close();
    clearTimeout(deadline.current);
    setConnection('cancelling');
    if (!current.flowId) return false;
    try {
      await cancel.mutateAsync(current.flowId);
      if (!mounted.current || attempt.current !== current) return false;
      current.flowId = undefined;
      return true;
    } catch {
      if (mounted.current && attempt.current === current) {
        current.cancelling = false;
        setConnection('failed');
      }
      return false;
    }
  };

  const failAttempt = async (current: ConnectionAttempt) => {
    await retireAttempt(current);
    if (mounted.current && attempt.current === current) {
      current.cancelling = false;
      setConnection('failed');
    }
  };

  useEffect(() => {
    mounted.current = true;
    const stopSettlements = watchOAuthSettlements((data) => {
      const current = attempt.current;
      if (!current?.flowId || data.flowId !== current.flowId) return;
      clearTimeout(deadline.current);
      current.flowId = undefined;
      current.popup?.close();
      if (data.outcome === 'failed') setConnection('failed');
      else {
        attempt.current = null;
        setConnection(null);
      }
      void client.cancelQueries([QueryKeys.slackWorkspaces, principalKey]).then(() => refresh());
    });
    return () => {
      mounted.current = false;
      clearTimeout(deadline.current);
      stopSettlements();
      const current = attempt.current;
      attempt.current = null;
      current?.popup?.close();
      current?.retryPopup?.close();
      if (current?.flowId)
        void dataService.cancelSlackWorkspaceInstall(current.flowId).catch(() => {});
    };
  }, [client, principalKey, refresh]);

  const start = (workspaceId?: string, appId?: string, retry = false, retryPopup?: Window) => {
    if (!retry) connectionTrigger.current = document.activeElement as HTMLElement | null;
    connect.reset();
    cancel.reset();
    setConnection('pending');
    const current: ConnectionAttempt = {
      workspaceId,
      appId,
      popup: retryPopup ?? window.open('', '_blank'),
      cancelling: false,
    };
    attempt.current = current;
    popupBlocked.current = !current.popup;
    if (!current.popup) {
      setConnection('failed');
      return;
    }
    current.popup.opener = null;
    connect.mutateAsync({ workspaceId, appId }).then(
      async (result) => {
        if (!mounted.current || attempt.current !== current) {
          current.popup?.close();
          void dataService.cancelSlackWorkspaceInstall(result.flowId).catch(() => {});
          return;
        }
        current.flowId = result.flowId;
        if (current.cancelling) {
          if (await retireAttempt(current)) {
            finish();
            void refresh();
          }
          return;
        }
        let destination: URL | undefined;
        try {
          destination = new URL(result.url);
        } catch {
          // Treat malformed and foreign destinations as failed attempts.
        }
        if (
          current.popup?.closed ||
          destination?.origin !== 'https://slack.com' ||
          destination?.pathname !== '/oauth/v2/authorize'
        ) {
          void failAttempt(current);
          return;
        }
        deadline.current = setTimeout(() => {
          if (attempt.current !== current) return;
          void failAttempt(current);
          void refresh();
        }, result.expiresInSeconds * 1000);
        if (current.popup) current.popup.location.href = result.url;
      },
      () => {
        current.popup?.close();
        if (!mounted.current || attempt.current !== current) return;
        if (current.cancelling) finish();
        else setConnection('failed');
      },
    );
  };

  const dismissConnection = async () => {
    const current = attempt.current;
    if (!current || connection === 'cancelling') return;
    if (!current.flowId && !connect.isLoading) finish();
    else if (await retireAttempt(current)) {
      finish();
      void refresh();
    }
  };

  const retryConnection = async () => {
    const current = attempt.current;
    if (!current || connection !== 'failed') return;
    // Open during the click so server retirement cannot consume browser user activation.
    const popup = window.open('', '_blank');
    if (!popup) return;
    popup.opener = null;
    current.retryPopup = popup;
    if (current.flowId && !(await retireAttempt(current))) {
      popup.close();
      current.retryPopup = undefined;
      return;
    }
    if (!mounted.current || attempt.current !== current) {
      popup.close();
      return;
    }
    current.retryPopup = undefined;
    start(current.workspaceId, current.appId, true, popup);
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
  const busy = connection !== null || connect.isLoading || retire.isLoading || cancel.isLoading;
  const workspaceRow = (workspace: SlackWorkspace, settings?: ReactNode) => {
    const nameId = `${id}-${workspace.workspaceId}-name`;
    const target = `${workspace.teamName} (${workspace.workspaceId})`;
    const disconnected = workspace.status === 'disconnected';
    const retireLabel = localize(
      disconnected ? 'com_ui_slack_workspaces_remove' : 'com_ui_slack_workspaces_disconnect',
    );
    return (
      <div
        key={workspace.workspaceId}
        role="group"
        aria-labelledby={nameId}
        className="flex items-center gap-3 py-2"
      >
        <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
          <p id={nameId} className="text-sm font-medium break-words">
            {workspace.teamName}
          </p>
          <Chip tone={disconnected ? 'neutral' : activeTone}>
            {localize(workspaceStatusLabel(workspace, first?.configured))}
          </Chip>
        </div>
        {first?.canManage && (
          <div className="flex shrink-0 items-center gap-1">
            {first.configured && !disconnected && (
              <BotManagers workspace={workspace} principalKey={principalKey} disabled={busy} />
            )}
            {settings}
            {first.configured && !disconnected && (
              <TooltipAnchor
                description={localize('com_ui_slack_workspaces_reconnect')}
                render={
                  <IconButton
                    label={localize('com_ui_slack_reconnect_named', { 0: target })}
                    variant="ghost"
                    size="sm"
                    shape="control"
                    disabled={busy}
                    onClick={() => start(workspace.workspaceId)}
                  >
                    <RotateCw className="size-4" aria-hidden="true" />
                  </IconButton>
                }
              />
            )}
            <TooltipAnchor
              description={retireLabel}
              render={
                <IconButton
                  label={localize(
                    disconnected
                      ? 'com_ui_slack_workspace_remove_named'
                      : 'com_ui_slack_disconnect_named',
                    { 0: target },
                  )}
                  variant="ghost"
                  size="sm"
                  shape="control"
                  disabled={busy}
                  onClick={(event) => {
                    actionRef.current = event.currentTarget;
                    settingsRef.current =
                      event.currentTarget.closest<HTMLElement>('[role="dialog"]');
                    setConfirm(workspace);
                  }}
                >
                  {disconnected ? (
                    <Trash2 className="size-4" aria-hidden="true" />
                  ) : (
                    <Link2Off className="size-4" aria-hidden="true" />
                  )}
                </IconButton>
              }
            />
          </div>
        )}
      </div>
    );
  };
  const count = new Set(
    workspaces
      .filter((workspace) => workspace.status === 'active')
      .map((workspace) => workspace.teamId),
  ).size;
  let description = localize('com_ui_loading');
  if (first) description = localize('com_ui_slack_row_description');
  if (count > 0)
    description = localize(
      status.hasNextPage ? 'com_ui_slack_connected_partial' : 'com_ui_slack_connected_count',
      { count },
    );
  return (
    <section aria-labelledby={`${id}-title`}>
      <div className="flex items-center gap-3">
        <span
          className="border-border-light bg-surface-secondary text-text-primary flex size-10 shrink-0 items-center justify-center rounded-lg border"
          aria-hidden="true"
        >
          <SlackIcon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3
            ref={headingRef}
            tabIndex={-1}
            id={`${id}-title`}
            className="text-text-primary text-sm font-medium"
          >
            {localize('com_ui_slack_workspaces_title')}
          </h3>
          <p className="text-text-secondary mt-0.5 text-xs">{description}</p>
        </div>
        <Button
          ref={manageRef}
          variant="outline"
          disabled={status.isLoading}
          onClick={() => setOpen(true)}
        >
          {localize(count > 0 || !first?.configured ? 'com_ui_manage' : 'com_ui_slack_setup')}
        </Button>
      </div>
      {status.isError && (
        <Alert variant="error">
          <p>{localize('com_ui_slack_workspaces_error')}</p>
          <Button variant="outline" onClick={() => void status.refetch()}>
            {localize('com_ui_retry')}
          </Button>
        </Alert>
      )}
      <OGDialog open={open} onOpenChange={setOpen} triggerRef={manageRef}>
        <OGDialogTemplate
          className="max-w-2xl"
          title={localize('com_ui_slack_manage_title')}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            manageRef.current?.focus();
          }}
          showCancelButton={false}
          selection={
            <Button variant="outline" onClick={() => setOpen(false)}>
              {localize('com_ui_close')}
            </Button>
          }
          main={
            <div className="space-y-4">
              {status.isLoading && <Loading />}
              {(status.isError || retire.isError) && (
                <div className="flex flex-col items-start gap-2">
                  <Alert variant="error">
                    {localize(
                      channelErrorLabel(
                        retire.error ?? status.error,
                        'com_ui_slack_workspaces_error',
                      ),
                    )}
                  </Alert>
                  <Button
                    variant="outline"
                    onClick={() => {
                      retire.reset();
                      void status.refetch();
                    }}
                  >
                    {localize('com_ui_retry')}
                  </Button>
                </div>
              )}
              {first && (
                <Apps
                  principalKey={principalKey}
                  busy={busy}
                  onInstall={(appId) => start(undefined, appId)}
                  canManage={first.canManage}
                  configured={first.configured}
                  hasMoreWorkspaces={status.hasNextPage}
                  workspaces={workspaces}
                  renderWorkspace={workspaceRow}
                />
              )}
              {first && !first.canManage && (
                <p className="text-text-secondary text-xs">
                  {localize('com_ui_slack_workspaces_admin')}
                </p>
              )}
              {status.hasNextPage && (
                <p className="text-text-secondary text-xs">
                  {localize('com_ui_slack_more_description')}
                </p>
              )}
              {status.hasNextPage && (
                <Button
                  variant="outline"
                  disabled={status.isFetchingNextPage}
                  onClick={() => void status.fetchNextPage()}
                >
                  {localize('com_ui_slack_workspaces_more')}
                </Button>
              )}
            </div>
          }
        />
        <OGDialog open={connection !== null} onOpenChange={() => {}} triggerRef={connectionTrigger}>
          <OGDialogTemplate
            className="max-w-md"
            title={localize(
              connection === 'failed'
                ? 'com_ui_slack_connection_failed'
                : 'com_ui_slack_connecting',
            )}
            showCloseButton={false}
            showCancelButton={false}
            onEscapeKeyDown={(event) => event.preventDefault()}
            onInteractOutside={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (connectionTrigger.current?.isConnected) connectionTrigger.current.focus();
              else manageRef.current?.focus();
            }}
            main={
              connection === 'failed' ? (
                <Alert variant="error">
                  {localize(
                    popupBlocked.current
                      ? 'com_ui_slack_popup_blocked'
                      : channelErrorLabel(
                          cancel.error ?? connect.error,
                          'com_ui_slack_workspaces_error',
                        ),
                  )}
                </Alert>
              ) : (
                <div role="status" className="text-text-secondary flex items-center gap-3 text-sm">
                  <Spinner className="size-5 shrink-0" aria-hidden="true" />
                  <p>
                    {localize(
                      connection === 'cancelling'
                        ? 'com_ui_slack_connection_cancelling'
                        : 'com_ui_slack_workspaces_waiting',
                    )}
                  </p>
                </div>
              )
            }
            selection={
              <>
                <Button
                  variant="outline"
                  disabled={connection === 'cancelling'}
                  onClick={() => void dismissConnection()}
                >
                  {localize('com_ui_cancel')}
                </Button>
                {connection === 'failed' && (
                  <Button onClick={() => void retryConnection()}>{localize('com_ui_retry')}</Button>
                )}
              </>
            }
          />
        </OGDialog>
      </OGDialog>
      <OGDialog
        triggerRef={actionRef}
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
            else if (settingsRef.current?.isConnected) settingsRef.current.focus();
            else headingRef.current?.focus();
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

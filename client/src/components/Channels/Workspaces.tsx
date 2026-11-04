import { useEffect, useId, useRef, useState } from 'react';
import { Button, Spinner } from '@librechat/client';
import { MutationKeys, QueryKeys, dataService } from 'librechat-data-provider';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { SlackWorkspace } from 'librechat-data-provider';
import { OAUTH_SETTLED_CHANNEL } from '~/data-provider/PullRequest/signIn';
import { useAuthContext, useLocalize } from '~/hooks';

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
  const key = [QueryKeys.slackWorkspaces, principalKey];
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [confirm, setConfirm] = useState<SlackWorkspace | null>(null);
  const flow = useRef<string | null>(null);
  const deadline = useRef<ReturnType<typeof setTimeout>>();
  const mounted = useRef(true);
  const status = useInfiniteQuery(
    key,
    ({ pageParam }: { pageParam?: string }) => dataService.getSlackWorkspaces(pageParam),
    {
      retry: false,
      cacheTime: 0,
      getNextPageParam: (page) => page.next,
    },
  );
  const connect = useMutation({
    mutationKey: [MutationKeys.slackWorkspaces, principalKey, 'connect'],
    mutationFn: (workspaceId?: string) => dataService.connectSlackWorkspace(workspaceId),
  });
  const disconnect = useMutation({
    mutationKey: [MutationKeys.slackWorkspaces, principalKey, 'disconnect'],
    mutationFn: (workspaceId: string) => dataService.disconnectSlackWorkspace(workspaceId),
    onSuccess: async () => {
      setConfirm(null);
      await client.invalidateQueries(key);
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
      await client.invalidateQueries(key);
    },
  });

  useEffect(() => {
    mounted.current = true;
    const channel =
      typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(OAUTH_SETTLED_CHANNEL);
    if (channel)
      channel.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (
          typeof data !== 'object' ||
          data === null ||
          !('flowId' in data) ||
          data.flowId !== flow.current ||
          !('outcome' in data) ||
          !['succeeded', 'failed'].includes(String(data.outcome))
        )
          return;
        flow.current = null;
        clearTimeout(deadline.current);
        setPending(false);
        setFailed(data.outcome === 'failed');
        void client
          .cancelQueries([QueryKeys.slackWorkspaces, principalKey])
          .then(() => client.invalidateQueries([QueryKeys.slackWorkspaces, principalKey]));
      };
    return () => {
      mounted.current = false;
      clearTimeout(deadline.current);
      channel?.close();
    };
  }, [client, principalKey]);

  const start = (workspaceId?: string) => {
    setFailed(false);
    const popup = window.open('', '_blank');
    if (!popup) {
      setFailed(true);
      return;
    }
    popup.opener = null;
    connect.mutateAsync(workspaceId).then(
      (result) => {
        if (!mounted.current || popup.closed) {
          popup.close();
          return;
        }
        let destination: URL;
        try {
          destination = new URL(result.url);
        } catch {
          popup.close();
          setFailed(true);
          return;
        }
        if (
          destination.origin !== 'https://slack.com' ||
          destination.pathname !== '/oauth/v2/authorize'
        ) {
          popup.close();
          setFailed(true);
          return;
        }
        flow.current = result.flowId;
        setPending(true);
        deadline.current = setTimeout(() => {
          flow.current = null;
          setPending(false);
          void client.invalidateQueries(key);
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
  if (first && !first.configured && workspaces.length === 0) return null;
  const busy = pending || connect.isLoading || disconnect.isLoading || cancel.isLoading;
  return (
    <section className="space-y-4" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="font-medium">
        {localize('com_ui_slack_workspaces_title')}
      </h2>
      <p className="text-text-secondary">{localize('com_ui_slack_workspaces_description')}</p>
      {status.isLoading && <Spinner />}
      {(status.isError || failed || disconnect.isError || cancel.isError) && (
        <div role="alert" className="space-y-2">
          <p>{localize('com_ui_slack_workspaces_error')}</p>
          <Button
            variant="outline"
            onClick={() => {
              setFailed(false);
              connect.reset();
              disconnect.reset();
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
        <Button disabled={busy} onClick={() => start()}>
          {localize('com_ui_slack_workspaces_connect')}
        </Button>
      )}
      {first && !first.canManage && <p>{localize('com_ui_slack_workspaces_admin')}</p>}
      {first && workspaces.length === 0 && <p>{localize('com_ui_slack_workspaces_empty')}</p>}
      {workspaces.map((workspace) => (
        <div
          key={workspace.workspaceId}
          className="border-border-light space-y-2 rounded-lg border p-3"
        >
          <p className="font-medium break-words">{workspace.teamName}</p>
          <p>
            {localize(
              workspace.status === 'active'
                ? 'com_ui_slack_workspaces_active'
                : 'com_ui_slack_workspaces_disconnected',
            )}
          </p>
          {first?.canManage && (
            <div className="flex flex-wrap gap-2">
              {first.configured && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => start(workspace.workspaceId)}
                >
                  {localize('com_ui_slack_workspaces_reconnect')}
                </Button>
              )}
              {workspace.status === 'active' && (
                <Button variant="outline" disabled={busy} onClick={() => setConfirm(workspace)}>
                  {localize('com_ui_slack_workspaces_disconnect')}
                </Button>
              )}
            </div>
          )}
          {confirm?.workspaceId === workspace.workspaceId && (
            <div
              role="group"
              aria-label={localize('com_ui_slack_workspaces_confirm')}
              className="space-y-2"
            >
              <p>{localize('com_ui_slack_workspaces_confirm')}</p>
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() => disconnect.mutate(workspace.workspaceId)}
                >
                  {localize('com_ui_slack_workspaces_disconnect')}
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => setConfirm(null)}>
                  {localize('com_ui_cancel')}
                </Button>
              </div>
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
    </section>
  );
}

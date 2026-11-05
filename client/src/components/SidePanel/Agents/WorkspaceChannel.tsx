import { useEffect, useId, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { dataService, QueryKeys, MutationKeys } from 'librechat-data-provider';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Checkbox,
  Input,
  Label,
  OGDialogFooter,
  Separator,
  Tag,
} from '@librechat/client';
import type { AgentChannel, SlackWorkspaceRouteTarget } from 'librechat-data-provider';
import { channelErrorLabel } from '~/utils/channelErrors';
import { useLocalize, useDebounce } from '~/hooks';
import ChannelStatus from './ChannelStatus';

type Action =
  | { kind: 'assign' }
  | { kind: 'remove'; target: SlackWorkspaceRouteTarget }
  | { kind: 'disable' | 'delete' };

/** Installation credentials never enter Agent Builder; only routing and personal-link consent do. */
export default function WorkspaceChannel({
  agentId,
  channel,
  userId,
  tenantId,
  enabled,
  onClose,
}: {
  agentId: string;
  channel: AgentChannel;
  userId: string;
  tenantId?: string;
  enabled: boolean;
  onClose: () => void;
}) {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const id = useId();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const principalKey = JSON.stringify([tenantId ?? '_', userId]);
  const routesKey = [
    QueryKeys.agentChannelWorkspaceRoutes,
    principalKey,
    agentId,
    channel.channelId,
  ];
  const [specific, setSpecific] = useState(false);
  const [externalChannel, setExternalChannel] = useState('');
  const [replace, setReplace] = useState(false);
  const [confirm, setConfirm] = useState<
    { kind: 'delete' } | { kind: 'remove'; target: SlackWorkspaceRouteTarget } | null
  >(null);
  const workspace = useQuery(
    [QueryKeys.slackWorkspaces, principalKey, channel.workspaceId],
    () => dataService.getSlackWorkspace(channel.workspaceId!),
    { retry: false },
  );
  const ownsChannel = channel.createdBy === userId;
  const available = Boolean(
    workspace.data?.configured && workspace.data.workspace.status === 'active',
  );
  const mayRoute = enabled && ownsChannel && available && channel.status !== 'deleting';
  const routes = useInfiniteQuery(
    routesKey,
    ({ pageParam }: { pageParam?: string }) =>
      dataService.getAgentChannelWorkspaceRoutes(agentId, channel.channelId, pageParam),
    {
      enabled: enabled && ownsChannel,
      retry: false,
      getNextPageParam: (page) => page.next,
    },
  );
  const debouncedChannel = useDebounce(externalChannel.trim(), 250);
  const settledInput = !specific || debouncedChannel === externalChannel.trim();
  const targetId = specific ? debouncedChannel : undefined;
  const validTarget = !specific || /^[CDG][A-Z0-9]{1,127}$/.test(targetId ?? '');
  const targetKey = [
    QueryKeys.agentChannelWorkspaceTarget,
    principalKey,
    agentId,
    channel.channelId,
    targetId ?? 'default',
  ];
  const target = useQuery(
    targetKey,
    () => dataService.getAgentChannelWorkspaceTarget(agentId, channel.channelId, targetId),
    { enabled: mayRoute && validTarget && settledInput, retry: false },
  );
  useEffect(() => setReplace(false), [target.data?.revision, targetId]);
  const mutation = useMutation({
    mutationKey: [
      MutationKeys.agentChannelWorkspaceRoutes,
      principalKey,
      agentId,
      channel.channelId,
    ],
    mutationFn: async (action: Action) => {
      if (!mounted.current || !enabled || channel.createdBy !== userId)
        throw new Error('Connection unavailable');
      if (action.kind === 'disable')
        return dataService.disableAgentChannel(agentId, channel.channelId);
      if (action.kind === 'delete')
        return dataService.deleteAgentChannel(agentId, channel.channelId);
      if (action.kind === 'remove')
        return dataService.removeAgentChannelWorkspaceRoute(agentId, channel.channelId, {
          externalChannelId: action.target.externalChannelId,
          expectedRevision: action.target.revision,
        });
      if (
        !mayRoute ||
        !validTarget ||
        !settledInput ||
        !target.isSuccess ||
        target.isFetching ||
        (target.data.occupied &&
          !target.data.assignedToThisChannel &&
          (!target.data.canReplace || !replace))
      )
        throw new Error('Route changed');
      return dataService.setAgentChannelWorkspaceRoute(agentId, channel.channelId, {
        channelRevision: channel.revision,
        externalChannelId: targetId,
        expectedRevision: target.data.revision,
      });
    },
    onSuccess: (_result, action) => {
      if (mounted.current) {
        setConfirm(null);
        if (action.kind !== 'remove') onClose();
      }
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries([QueryKeys.agentChannels, userId, tenantId, agentId]),
        queryClient.invalidateQueries(routesKey),
        queryClient.invalidateQueries([
          QueryKeys.agentChannelWorkspaceTarget,
          principalKey,
          agentId,
          channel.channelId,
        ]),
        queryClient.invalidateQueries([
          QueryKeys.slackWorkspaces,
          principalKey,
          channel.workspaceId,
        ]),
      ]);
    },
  });
  const busy = !enabled || mutation.isLoading || channel.status === 'deleting';
  const entries = routes.data?.pages.flatMap((page) => page.routes) ?? [];
  const replacesOther = settledInput && target.data?.occupied && !target.data.assignedToThisChannel;
  const blocked = replacesOther && target.data?.canReplace !== true;
  const replaceAssignmentLabel = specific
    ? 'com_ui_channels_workspace_replace_channel_assignment'
    : 'com_ui_channels_workspace_replace_assignment';
  const alreadyAssigned =
    settledInput &&
    target.isSuccess &&
    !target.isFetching &&
    target.data.assignedToThisChannel &&
    channel.status === 'active';
  return (
    <>
      <div className="min-h-0 space-y-4 overflow-y-auto px-6 pb-6 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 flex-1 font-medium break-words">
            {workspace.data?.workspace.teamName ?? localize('com_ui_channels_org_workspace')}
          </span>
          <ChannelStatus
            status={channel.status}
            pendingLabel="com_ui_channels_workspace_not_assigned"
          />
        </div>
        {workspace.data && (
          <a
            href={`https://slack.com/app_redirect?app=${encodeURIComponent(workspace.data.workspace.appId)}&team=${encodeURIComponent(workspace.data.workspace.teamId)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-text-secondary hover:text-text-primary inline-flex items-center gap-1 underline underline-offset-2"
          >
            {localize('com_ui_channels_workspace_open_bot')}
            <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        )}
        <p className="text-text-secondary">{localize('com_ui_channels_workspace_identity')}</p>
        {workspace.isLoading && <p role="status">{localize('com_ui_channels_loading')}</p>}
        {workspace.isError && (
          <div role="alert">
            <p>{localize('com_ui_slack_workspaces_error')}</p>
            <Button type="button" variant="outline" onClick={() => void workspace.refetch()}>
              {localize('com_ui_retry')}
            </Button>
          </div>
        )}
        {workspace.data && !available && (
          <p role="status">{localize('com_ui_channels_workspace_unavailable')}</p>
        )}
        {!ownsChannel && <p>{localize('com_ui_channels_read_only')}</p>}
        {mutation.isError && (
          <p role="alert">
            {localize(channelErrorLabel(mutation.error, 'com_ui_channels_workspace_route_error'))}
          </p>
        )}
        {ownsChannel && (
          <section className="space-y-2" aria-labelledby={`${id}-routes`}>
            <h4 id={`${id}-routes`} className="font-medium">
              {localize('com_ui_channels_workspace_routes')}
            </h4>
            {routes.isLoading && <p role="status">{localize('com_ui_channels_loading')}</p>}
            {routes.isError && (
              <div role="alert">
                <p>{localize('com_ui_channels_workspace_route_error')}</p>
                <Button type="button" variant="outline" onClick={() => void routes.refetch()}>
                  {localize('com_ui_retry')}
                </Button>
              </div>
            )}
            {routes.isSuccess && entries.length === 0 && (
              <p className="text-text-secondary">
                {localize('com_ui_channels_workspace_no_routes')}
              </p>
            )}
            {entries.map((entry) => (
              <div
                key={entry.externalChannelId ?? 'default'}
                className="border-border-light flex items-center justify-between gap-2 rounded-lg border p-3"
              >
                <span className="min-w-0 flex-1 break-all">
                  {entry.externalChannelId ?? localize('com_ui_channels_workspace_default')}
                </span>
                <Button
                  type="button"
                  variant="section-action"
                  size="compact"
                  disabled={busy}
                  onClick={() => setConfirm({ kind: 'remove', target: entry })}
                >
                  {localize('com_ui_channels_workspace_remove_route')}
                </Button>
              </div>
            ))}
            {routes.hasNextPage && (
              <Button
                type="button"
                variant="outline"
                disabled={routes.isFetchingNextPage}
                onClick={() => void routes.fetchNextPage()}
              >
                {localize('com_ui_channels_workspace_more_routes')}
              </Button>
            )}
          </section>
        )}
        {mayRoute && (
          <section className="space-y-3" aria-labelledby={`${id}-target`}>
            <div className="flex items-center justify-between gap-2">
              <h4 id={`${id}-target`} className="min-w-0 font-medium">
                {localize('com_ui_channels_workspace_target')}
              </h4>
              {alreadyAssigned && (
                <Tag
                  role="status"
                  className="shrink-0"
                  variant="success"
                  label={localize('com_ui_channels_workspace_assigned')}
                />
              )}
            </div>
            <div
              role="group"
              aria-label={localize('com_ui_channels_workspace_target')}
              className="flex flex-wrap gap-2"
            >
              <Button
                type="button"
                variant="outline-toggle"
                aria-pressed={!specific}
                disabled={busy}
                onClick={() => {
                  setSpecific(false);
                  setReplace(false);
                }}
              >
                {localize('com_ui_channels_workspace_default')}
              </Button>
              <Button
                type="button"
                variant="outline-toggle"
                aria-pressed={specific}
                disabled={busy}
                onClick={() => {
                  setSpecific(true);
                  setReplace(false);
                }}
              >
                {localize('com_ui_channels_workspace_specific')}
              </Button>
            </div>
            <p className="text-text-secondary">
              {localize(
                specific
                  ? 'com_ui_channels_workspace_channel_help'
                  : 'com_ui_channels_workspace_default_help',
              )}
            </p>
            {specific && (
              <div className="space-y-1">
                <Label htmlFor={`${id}-channel`}>
                  {localize('com_ui_channels_workspace_channel_id')}
                </Label>
                <Input
                  id={`${id}-channel`}
                  value={externalChannel}
                  maxLength={128}
                  autoComplete="off"
                  placeholder="C0123456789"
                  disabled={busy}
                  onChange={(event) => {
                    setExternalChannel(event.target.value);
                    setReplace(false);
                  }}
                />
              </div>
            )}
            {validTarget && target.isLoading && (
              <p role="status">{localize('com_ui_channels_loading')}</p>
            )}
            {settledInput && target.isError && (
              <div role="alert">
                <p>{localize('com_ui_channels_workspace_route_error')}</p>
                <Button type="button" variant="outline" onClick={() => void target.refetch()}>
                  {localize('com_ui_retry')}
                </Button>
              </div>
            )}
            {blocked && (
              <Alert variant="warning">{localize('com_ui_channels_workspace_route_owned')}</Alert>
            )}
            {replacesOther && !blocked && (
              <div className="border-border-medium space-y-2 rounded-lg border p-3">
                <p>
                  {localize(
                    specific
                      ? 'com_ui_channels_workspace_replace_channel_help'
                      : 'com_ui_channels_workspace_replace_help',
                  )}
                </p>
                <div className="flex items-center gap-2">
                  <Checkbox
                    aria-label={localize(
                      specific
                        ? 'com_ui_channels_workspace_replace_channel'
                        : 'com_ui_channels_workspace_replace',
                    )}
                    id={`${id}-replace`}
                    checked={replace}
                    disabled={busy}
                    onCheckedChange={(value) => setReplace(value === true)}
                  />
                  <Label htmlFor={`${id}-replace`}>
                    {localize(
                      specific
                        ? 'com_ui_channels_workspace_replace_channel'
                        : 'com_ui_channels_workspace_replace',
                    )}
                  </Label>
                </div>
              </div>
            )}
            {!alreadyAssigned && (
              <Button
                type="button"
                disabled={
                  busy ||
                  !validTarget ||
                  !settledInput ||
                  !target.isSuccess ||
                  target.isFetching ||
                  Boolean(replacesOther && (blocked || !replace))
                }
                onClick={() => mutation.mutate({ kind: 'assign' })}
              >
                {localize(
                  replacesOther ? replaceAssignmentLabel : 'com_ui_channels_workspace_assign',
                )}
              </Button>
            )}
          </section>
        )}
        {confirm && (
          <div
            role="group"
            aria-label={localize('com_ui_channels_workspace_confirm_title')}
            className="border-border-medium space-y-3 rounded-lg border p-3"
          >
            <p>
              {localize(
                confirm.kind === 'delete'
                  ? 'com_ui_channels_workspace_delete_confirm'
                  : 'com_ui_channels_workspace_remove_confirm',
              )}
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="destructive"
                disabled={busy}
                onClick={() => mutation.mutate(confirm)}
              >
                {localize('com_ui_confirm')}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setConfirm(null)}
              >
                {localize('com_ui_cancel')}
              </Button>
            </div>
          </div>
        )}
      </div>
      <Separator />
      <OGDialogFooter className="flex-wrap gap-2 px-6 py-4 sm:justify-between">
        <Button
          type="button"
          variant="destructive-soft"
          disabled={busy}
          onClick={() => setConfirm({ kind: 'delete' })}
        >
          {localize('com_ui_delete')}
        </Button>
        {channel.status === 'active' && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => mutation.mutate({ kind: 'disable' })}
          >
            {localize('com_ui_channels_disable')}
          </Button>
        )}
      </OGDialogFooter>
    </>
  );
}

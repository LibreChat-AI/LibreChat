import { useEffect, useId, useRef, useState } from 'react';
import { isAxiosError } from 'axios';
import { Trans } from 'react-i18next';
import { ExternalLink, Info, Plus } from 'lucide-react';
import { dataService, QueryKeys, MutationKeys } from 'librechat-data-provider';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Input,
  InfoHoverCard,
  Label,
  OGDialog,
  OGDialogTemplate,
  OGDialogFooter,
  Radio,
  Separator,
  Tag,
} from '@librechat/client';
import type { AgentChannel, SlackWorkspaceRouteTarget } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { channelErrorLabel } from '~/utils/channelErrors';
import { useLocalize, useDebounce } from '~/hooks';
import ChannelStatus from './ChannelStatus';

type Action =
  | { kind: 'assign'; replacementRevision?: string }
  | { kind: 'remove'; target: SlackWorkspaceRouteTarget }
  | { kind: 'disable' }
  | { kind: 'delete' };

/** Installation credentials never enter Agent Builder; only routing and personal-link consent do. */
export default function WorkspaceChannel({
  agentId,
  initialSetup,
  channel,
  userId,
  tenantId,
  enabled,
  onClose,
}: {
  agentId: string;
  initialSetup: boolean;
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
  const [editing, setEditing] = useState(initialSetup);
  const actionRef = useRef<HTMLButtonElement | null>(null);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const [confirm, setConfirm] = useState<
    | { kind: 'delete' }
    | { kind: 'remove'; target: SlackWorkspaceRouteTarget }
    | { kind: 'assign'; replacementRevision: string }
    | null
  >(null);
  const workspace = useQuery(
    [QueryKeys.slackWorkspaces, principalKey, channel.workspaceId],
    () => dataService.getSlackWorkspace(channel.workspaceId!),
    { retry: false },
  );
  const ownsChannel = channel.createdBy === userId;
  const status = isAxiosError(workspace.error) ? workspace.error.response?.status : undefined;
  const unavailable =
    status === 404 ||
    status === 410 ||
    (!workspace.isError &&
      workspace.isSuccess &&
      (!workspace.data.configured || workspace.data.workspace.status !== 'active'));
  const accessDenied = status === 401 || status === 403;
  const available = Boolean(
    !workspace.isError &&
      workspace.data?.configured &&
      workspace.data.workspace.status === 'active',
  );
  const mayRoute =
    enabled &&
    ownsChannel &&
    available &&
    workspace.data?.workspace.canManageBot === true &&
    channel.status !== 'deleting';
  const routes = useInfiniteQuery(
    routesKey,
    ({ pageParam }: { pageParam?: string }) =>
      dataService.getAgentChannelWorkspaceRoutes(agentId, channel.channelId, pageParam),
    {
      enabled: enabled && ownsChannel && available,
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
    { enabled: editing && mayRoute && validTarget && settledInput, retry: false },
  );
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
          (!target.data.canReplace || action.replacementRevision !== target.data.revision))
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
        if (action.kind === 'remove') actionRef.current = addRef.current;
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
  const assignmentDisabled =
    busy ||
    !mayRoute ||
    !validTarget ||
    !settledInput ||
    !target.isSuccess ||
    target.isFetching ||
    Boolean(blocked) ||
    Boolean(replacesOther && !target.data?.revision);
  let confirmationTitle: TranslationKeys = 'com_ui_channels_workspace_delete_connection';
  let confirmationHelp: TranslationKeys = 'com_ui_channels_workspace_delete_confirm';
  if (confirm?.kind === 'remove') {
    confirmationTitle = 'com_ui_channels_workspace_remove_assignment';
    confirmationHelp = 'com_ui_channels_workspace_remove_confirm';
  } else if (confirm?.kind === 'assign') {
    confirmationTitle = replaceAssignmentLabel;
    confirmationHelp = specific
      ? 'com_ui_channels_workspace_replace_channel_help'
      : 'com_ui_channels_workspace_replace_help';
  }
  return (
    <>
      <div className="min-h-0 space-y-4 overflow-y-auto px-6 pb-6 text-sm">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 font-medium break-words">
              {workspace.data?.workspace.appName ??
                workspace.data?.workspace.teamName ??
                localize('com_ui_channels_slack_connection')}
            </span>
            {unavailable && (
              <InfoHoverCard text={localize('com_ui_channels_workspace_reconnect_help')}>
                <Info className="text-text-tertiary size-4" aria-hidden="true" />
              </InfoHoverCard>
            )}
          </div>
          {unavailable && (
            <Tag
              variant="warning"
              label={localize('com_ui_channels_workspace_unavailable_status')}
            />
          )}
          {available && (
            <ChannelStatus
              status={channel.status}
              pendingLabel="com_ui_channels_workspace_not_assigned"
            />
          )}
        </div>
        {available && workspace.data && (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            {workspace.data.workspace.appName && (
              <span className="text-text-secondary">{workspace.data.workspace.teamName}</span>
            )}
            <a
              href={`https://slack.com/app_redirect?app=${encodeURIComponent(workspace.data.workspace.appId)}&team=${encodeURIComponent(workspace.data.workspace.teamId)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-text-secondary hover:text-text-primary inline-flex items-center gap-1 underline underline-offset-2"
            >
              {localize('com_ui_channels_workspace_open_bot')}
              <ExternalLink className="size-3" aria-hidden="true" />
            </a>
          </div>
        )}

        {workspace.isLoading && <p role="status">{localize('com_ui_channels_loading')}</p>}
        {workspace.isError && !unavailable && !accessDenied && (
          <Alert variant="error">
            <p>{localize('com_ui_channels_workspace_load_error')}</p>
            <Button type="button" variant="outline" onClick={() => void workspace.refetch()}>
              {localize('com_ui_retry')}
            </Button>
          </Alert>
        )}
        {unavailable && (
          <Alert variant="warning">{localize('com_ui_channels_workspace_unavailable')}</Alert>
        )}
        {accessDenied && (
          <Alert variant="warning">{localize('com_ui_channels_workspace_access_denied')}</Alert>
        )}
        {!ownsChannel && <p>{localize('com_ui_channels_read_only')}</p>}
        {ownsChannel && available && workspace.data?.workspace.canManageBot !== true && (
          <Alert variant="info">{localize('com_ui_channels_bot_access_required')}</Alert>
        )}
        {mutation.isError && (
          <p role="alert">
            {localize(channelErrorLabel(mutation.error, 'com_ui_channels_workspace_route_error'))}
          </p>
        )}
        {!editing && ownsChannel && available && (
          <section
            className="space-y-2"
            aria-labelledby={entries.length > 0 ? `${id}-routes` : undefined}
            aria-label={
              entries.length === 0
                ? localize('com_ui_channels_workspace_add_assignment')
                : undefined
            }
          >
            {entries.length > 0 && (
              <h4 id={`${id}-routes`} className="font-medium">
                {localize('com_ui_channels_workspace_routes')}
              </h4>
            )}
            {routes.isLoading && <p role="status">{localize('com_ui_channels_loading')}</p>}
            {routes.isError && (
              <div role="alert">
                <p>{localize('com_ui_channels_workspace_route_error')}</p>
                <Button type="button" variant="outline" onClick={() => void routes.refetch()}>
                  {localize('com_ui_retry')}
                </Button>
              </div>
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
                  onClick={(event) => {
                    actionRef.current = event.currentTarget;
                    setConfirm({ kind: 'remove', target: entry });
                  }}
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
            {mayRoute &&
              (channel.status !== 'active' ||
                !entries.some((entry) => !entry.externalChannelId)) && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || !routes.isSuccess}
                  ref={addRef}
                  onClick={() => {
                    mutation.reset();
                    const target =
                      channel.status === 'disabled'
                        ? (entries.find((entry) => !entry.externalChannelId) ?? entries[0])
                        : undefined;
                    setSpecific(Boolean(target?.externalChannelId));
                    setExternalChannel(target?.externalChannelId ?? '');
                    setEditing(true);
                  }}
                >
                  <Plus className="size-4" aria-hidden="true" />
                  {localize(
                    channel.status === 'disabled' && entries.length > 0
                      ? 'com_ui_channels_activate'
                      : 'com_ui_channels_workspace_add_assignment',
                  )}
                </Button>
              )}
          </section>
        )}
        {editing && mayRoute && (
          <section className="space-y-3" aria-labelledby={`${id}-target`}>
            <span id={`${id}-target`} className="sr-only">
              {localize('com_ui_channels_workspace_target')}
            </span>
            {alreadyAssigned && (
              <Tag
                role="status"
                variant="success"
                label={localize('com_ui_channels_workspace_assigned')}
              />
            )}
            <Radio
              fullWidth
              wrap
              aria-labelledby={`${id}-target`}
              value={specific ? 'channel' : 'default'}
              onChange={(value) => setSpecific(value === 'channel')}
              disabled={busy}
              options={[
                { value: 'default', label: localize('com_ui_channels_workspace_default') },
                { value: 'channel', label: localize('com_ui_channels_workspace_specific') },
              ]}
            />
            <p className="text-text-secondary">
              <Trans
                i18nKey={
                  specific
                    ? 'com_ui_channels_workspace_channel_help'
                    : 'com_ui_channels_workspace_default_help'
                }
                values={{
                  botName:
                    workspace.data?.workspace.appName ??
                    localize('com_ui_channels_slack_app_fallback', {
                      0: workspace.data?.workspace.appId ?? '',
                    }),
                  workspaceName: workspace.data?.workspace.teamName ?? '',
                }}
                components={{ strong: <strong className="font-semibold" /> }}
              />
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
              <Alert variant="warning">{localize('com_ui_channels_bot_access_required')}</Alert>
            )}
            {replacesOther && !blocked && (
              <Alert variant="warning">
                {target.data?.assignedAgentName
                  ? localize('com_ui_channels_workspace_occupied_named', {
                      0: target.data.assignedAgentName,
                    })
                  : localize('com_ui_channels_workspace_occupied')}
              </Alert>
            )}
          </section>
        )}
      </div>
      <Separator />
      <OGDialogFooter className="flex-wrap gap-2 px-6 py-4 sm:justify-between">
        {editing && mayRoute ? (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={mutation.isLoading}
              onClick={() => {
                mutation.reset();
                if (initialSetup) onClose();
                else setEditing(false);
              }}
            >
              {localize('com_ui_cancel')}
            </Button>
            {!alreadyAssigned && (
              <Button
                type="button"
                disabled={assignmentDisabled}
                aria-busy={mutation.isLoading}
                onClick={(event) => {
                  if (replacesOther && target.data?.revision) {
                    actionRef.current = event.currentTarget;
                    setConfirm({ kind: 'assign', replacementRevision: target.data.revision });
                  } else mutation.mutate({ kind: 'assign' });
                }}
              >
                {localize(
                  replacesOther ? replaceAssignmentLabel : 'com_ui_channels_workspace_assign',
                )}
              </Button>
            )}
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="destructive-soft"
              disabled={busy || !ownsChannel}
              onClick={(event) => {
                actionRef.current = event.currentTarget;
                setConfirm({ kind: 'delete' });
              }}
            >
              {localize('com_ui_channels_workspace_delete_connection')}
            </Button>
            <div className="flex items-center gap-2">
              {available && channel.status === 'active' && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => mutation.mutate({ kind: 'disable' })}
                >
                  {localize('com_ui_channels_disable')}
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                disabled={mutation.isLoading}
                onClick={onClose}
              >
                {localize('com_ui_close')}
              </Button>
            </div>
          </>
        )}
      </OGDialogFooter>
      <OGDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !mutation.isLoading) setConfirm(null);
        }}
      >
        <OGDialogTemplate
          className="max-w-md"
          footerClassName="sm:justify-between"
          title={
            confirm?.kind === 'assign' && target.data?.assignedAgentName
              ? localize('com_ui_channels_workspace_replace_named', {
                  0: target.data.assignedAgentName,
                })
              : localize(confirmationTitle)
          }
          description={workspace.data?.workspace.teamName}
          cancelDisabled={mutation.isLoading}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (actionRef.current?.isConnected) actionRef.current.focus();
            else addRef.current?.focus();
          }}
          main={
            <div className="space-y-3 text-sm">
              <p className="text-text-secondary">{localize(confirmationHelp)}</p>
              {confirm?.kind === 'assign' &&
                target.data?.revision !== confirm.replacementRevision && (
                  <Alert variant="warning">
                    {localize('com_ui_channels_workspace_replacement_changed')}
                  </Alert>
                )}
              {mutation.isError && (
                <Alert variant="error">
                  {localize(
                    channelErrorLabel(mutation.error, 'com_ui_channels_workspace_route_error'),
                  )}
                </Alert>
              )}
            </div>
          }
          selection={
            <Button
              type="button"
              variant={confirm?.kind === 'assign' ? 'default' : 'destructive'}
              disabled={
                busy ||
                !confirm ||
                (confirm.kind === 'assign' &&
                  (assignmentDisabled || target.data?.revision !== confirm.replacementRevision))
              }
              aria-busy={mutation.isLoading}
              onClick={() => {
                if (confirm) mutation.mutate(confirm);
              }}
            >
              {localize(confirmationTitle)}
            </Button>
          }
        />
      </OGDialog>
    </>
  );
}

import { useId, useRef, useState, useEffect } from 'react';
import { Info, Plus, Power, Trash2 } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { dataService, MutationKeys, QueryKeys } from 'librechat-data-provider';
import {
  Button,
  Input,
  Label,
  Tag,
  Textarea,
  Separator,
  TooltipAnchor,
  OGDialog,
  OGDialogContent,
  OGDialogTitle,
  OGDialogFooter,
} from '@librechat/client';
import type { AgentChannel } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { useLocalize } from '~/hooks';

const statusLabels: Record<AgentChannel['status'], TranslationKeys> = {
  pending_install: 'com_ui_channels_pending',
  active: 'com_ui_channels_active',
  disabled: 'com_ui_channels_disabled',
  deleting: 'com_ui_channels_deleting',
};

const actionLabels: Record<AgentChannel['status'], TranslationKeys> = {
  pending_install: 'com_ui_channels_setup',
  active: 'com_ui_channels_manage',
  disabled: 'com_ui_channels_manage',
  deleting: 'com_ui_channels_manage',
};

const statusColors: Record<AgentChannel['status'], string> = {
  pending_install: 'bg-status-warning',
  active: 'bg-status-success',
  disabled: 'bg-status-neutral',
  deleting: 'bg-status-info',
};

function ChannelStatus({ status }: { status: AgentChannel['status'] }) {
  const localize = useLocalize();
  return (
    <span className="text-text-secondary inline-flex shrink-0 items-center gap-1.5 text-xs">
      <span aria-hidden="true" className={`size-1.5 rounded-full ${statusColors[status]}`} />
      {localize(statusLabels[status])}
    </span>
  );
}

function Channel({
  agentId,
  channel,
  onClose,
  userId,
  tenantId,
  enabled,
}: {
  agentId: string;
  channel: AgentChannel;
  onClose: () => void;
  userId: string;
  tenantId?: string;
  enabled: boolean;
}) {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const id = useId();
  const [panel, setPanel] = useState<'setup' | 'delete' | 'mode' | null>(
    channel.status === 'pending_install' ? 'setup' : null,
  );
  const setup = panel === 'setup';
  const [appId, setAppId] = useState(channel.slack?.appId ?? '');
  const [botToken, setBotToken] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const credentials = useRef({ botToken: '', signingSecret: '' });
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      credentials.current = { botToken: '', signingSecret: '' };
    };
  }, []);
  const manifest = useQuery(
    [QueryKeys.agentChannelManifest, userId, tenantId, agentId, channel.channelId],
    () => dataService.getAgentChannelManifest(agentId, channel.channelId),
    { retry: false },
  );
  const needsSigningSecret = manifest.data?.settings.socket_mode_enabled === false;
  let signingLabel: TranslationKeys = 'com_ui_channels_signing_secret';
  if (needsSigningSecret) signingLabel = 'com_ui_channels_signing_secret_required';
  else if (manifest.data?.settings.socket_mode_enabled === true)
    signingLabel = 'com_ui_channels_signing_secret_optional';
  const canActivate =
    enabled &&
    manifest.isSuccess &&
    !manifest.isFetching &&
    Boolean(appId.trim() && botToken.trim() && (!needsSigningSecret || signingSecret.trim()));
  const manifestText = manifest.data ? JSON.stringify(manifest.data, null, 2) : '';
  const readiness = useRef({ enabled, canActivate });
  readiness.current = { enabled, canActivate };
  const clearCredentials = () => {
    credentials.current = { botToken: '', signingSecret: '' };
    if (!active.current) return;
    setBotToken('');
    setSigningSecret('');
  };
  const mutation = useMutation({
    mutationKey: [MutationKeys.agentChannels, userId, tenantId, agentId, channel.channelId],
    // Cached callbacks retain only a revocable holder, never render snapshots of secrets.
    mutationFn: async (action: 'activate' | 'disable' | 'delete' | 'mode') => {
      try {
        if (!active.current || !readiness.current.enabled || channel.createdBy !== userId)
          throw new Error('Channel unavailable');
        if (action === 'mode') {
          if (!channel.revision || channel.status !== 'disabled')
            throw new Error('Channel mode changed');
          return await dataService.changeAgentChannelMode(
            agentId,
            channel.channelId,
            channel.credentialMode === 'shared' ? 'per_user' : 'shared',
            channel.revision,
          );
        }
        if (action === 'activate') {
          const token = credentials.current.botToken.trim();
          const secret = credentials.current.signingSecret.trim();
          if (!readiness.current.canActivate || !token || (needsSigningSecret && !secret))
            throw new Error('Channel activation unavailable');
          const slack = {
            appId: appId.trim(),
            botToken: token,
            ...(secret ? { signingSecret: secret } : {}),
          };
          // Consume the form before dispatch; only the pending HTTP invocation owns its payload.
          clearCredentials();
          return await dataService.activateAgentChannel(agentId, channel.channelId, { slack });
        }
        if (action === 'disable')
          return await dataService.disableAgentChannel(agentId, channel.channelId);
        await dataService.deleteAgentChannel(agentId, channel.channelId);
      } finally {
        clearCredentials();
      }
    },
    onSuccess: async () => {
      onClose();
      await queryClient.invalidateQueries([QueryKeys.agentChannels, userId, tenantId, agentId]);
      await queryClient.invalidateQueries([
        QueryKeys.agentChannelManifest,
        userId,
        tenantId,
        agentId,
        channel.channelId,
      ]);
    },
  });
  const busy = !enabled || mutation.isLoading || channel.status === 'deleting';
  return (
    <>
      <div className="min-h-0 space-y-4 overflow-y-auto px-6 pb-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">{localize('com_ui_channels_slack')}</span>
          <ChannelStatus status={channel.status} />
        </div>
        <dl className="border-border-light bg-surface-secondary space-y-3 rounded-lg border p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-text-secondary">{localize('com_ui_channels_connection_type')}</dt>
            <dd>
              <Tag
                variant="neutral"
                label={localize(
                  channel.credentialMode === 'shared'
                    ? 'com_ui_channel_link_shared'
                    : 'com_ui_channel_link_per_user',
                )}
              />
            </dd>
          </div>
          <div className="flex items-start justify-between gap-4">
            <dt className="text-text-secondary shrink-0">
              {localize('com_ui_channels_connection_id_label')}
            </dt>
            <dd className="text-text-primary min-w-0 text-end font-mono text-xs break-all">
              {channel.channelId}
            </dd>
          </div>
          {channel.slack?.teamId && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <dt className="text-text-secondary">{localize('com_ui_channels_workspace_label')}</dt>
              <dd className="text-text-primary font-mono text-xs">{channel.slack.teamId}</dd>
            </div>
          )}
          {channel.slack?.appId && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <dt className="text-text-secondary">{localize('com_ui_channels_app_id')}</dt>
              <dd className="text-text-primary font-mono text-xs">{channel.slack.appId}</dd>
            </div>
          )}
        </dl>
        {mutation.isError && (
          <p role="alert" className="text-text-primary text-sm">
            {localize('com_ui_channels_action_error')}
          </p>
        )}
        {mutation.isError && mutation.variables === 'activate' && (
          <p className="text-text-secondary text-sm">
            {localize('com_ui_channels_activation_retry')}
          </p>
        )}
        {panel === 'mode' && (
          <div
            role="group"
            aria-label={localize('com_ui_channel_link_mode_confirm')}
            className="space-y-2"
          >
            <p>{localize('com_ui_channel_link_mode_confirm')}</p>
            <p>
              {localize(
                channel.credentialMode === 'shared'
                  ? 'com_ui_channel_link_per_user_notice'
                  : 'com_ui_channels_shared_notice',
              )}
            </p>
            <div className="flex gap-2">
              <Button type="button" disabled={busy} onClick={() => mutation.mutate('mode')}>
                {localize(
                  channel.credentialMode === 'shared'
                    ? 'com_ui_channel_link_switch_per_user'
                    : 'com_ui_channel_link_switch_shared',
                )}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setPanel(null)}
              >
                {localize('com_ui_cancel')}
              </Button>
            </div>
          </div>
        )}
        {panel === 'delete' && (
          <div
            className="space-y-2"
            role="group"
            aria-label={localize('com_ui_channels_delete_confirm')}
          >
            <p className="text-sm">{localize('com_ui_channels_delete_confirm')}</p>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setPanel(null)}
              >
                {localize('com_ui_cancel')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={busy}
                onClick={() => mutation.mutate('delete')}
              >
                {localize('com_ui_delete')}
              </Button>
            </div>
          </div>
        )}
        <div className="space-y-3">
          {setup && (
            <>
              <h4 className="text-sm font-medium">{localize('com_ui_channels_install_step')}</h4>
              <p className="text-text-secondary text-sm">
                {localize('com_ui_channels_instructions')}
              </p>
            </>
          )}
          {manifest.isLoading && <p role="status">{localize('com_ui_channels_loading')}</p>}
          {manifest.isError && (
            <div role="alert" className="space-y-2 text-sm">
              <p>{localize('com_ui_channels_manifest_error')}</p>
              <Button type="button" variant="outline" onClick={() => void manifest.refetch()}>
                {localize('com_ui_channels_retry')}
              </Button>
            </div>
          )}
          {manifest.data && (
            <details open className="space-y-2 text-sm">
              <summary className="cursor-pointer">{localize('com_ui_channels_manifest')}</summary>
              <Label className="sr-only" htmlFor={`${id}-manifest`}>
                {localize('com_ui_channels_manifest')}
              </Label>
              <Textarea id={`${id}-manifest`} rows={8} value={manifestText} readOnly />
            </details>
          )}
        </div>
        {setup && (
          <div id={`${id}-setup`} className="space-y-3">
            <h4 className="text-sm font-medium">{localize('com_ui_channels_credentials_step')}</h4>
            <div className="space-y-1">
              <Label htmlFor={`${id}-app`}>{localize('com_ui_channels_app_id')}</Label>
              <Input
                id={`${id}-app`}
                autoComplete="off"
                value={appId}
                disabled={busy}
                onChange={(event) => setAppId(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-token`}>{localize('com_ui_channels_bot_token')}</Label>
              <Input
                id={`${id}-token`}
                type="password"
                autoComplete="new-password"
                value={botToken}
                disabled={busy}
                onChange={(event) => {
                  credentials.current.botToken = event.target.value;
                  setBotToken(event.target.value);
                }}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-secret`}>{localize(signingLabel)}</Label>
              <Input
                id={`${id}-secret`}
                type="password"
                required={needsSigningSecret}
                aria-required={needsSigningSecret}
                autoComplete="new-password"
                value={signingSecret}
                disabled={busy}
                onChange={(event) => {
                  credentials.current.signingSecret = event.target.value;
                  setSigningSecret(event.target.value);
                }}
              />
            </div>
            <Button
              type="button"
              disabled={busy || channel.status === 'active' || !canActivate}
              onClick={() => mutation.mutate('activate')}
            >
              {localize('com_ui_channels_activate')}
            </Button>
          </div>
        )}
      </div>
      <Separator />
      <OGDialogFooter className="flex-wrap gap-2 px-6 py-4 sm:justify-between">
        <Button
          type="button"
          variant="destructive-soft"
          disabled={busy || panel === 'delete'}
          onClick={() => {
            clearCredentials();
            setPanel('delete');
          }}
        >
          <Trash2 className="size-4" aria-hidden="true" />
          {localize('com_ui_delete')}
        </Button>
        <div className="flex flex-wrap gap-2">
          {channel.status !== 'active' && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              aria-expanded={setup}
              aria-controls={`${id}-setup`}
              onClick={() => {
                clearCredentials();
                mutation.reset();
                setPanel(setup ? null : 'setup');
              }}
            >
              {localize(setup ? 'com_ui_cancel' : 'com_ui_channels_setup')}
            </Button>
          )}
          {channel.status === 'disabled' && channel.revision && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                clearCredentials();
                setPanel('mode');
              }}
            >
              {localize('com_ui_channel_link_change_mode')}
            </Button>
          )}
          {channel.status === 'active' && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => mutation.mutate('disable')}
            >
              <Power className="size-4" aria-hidden="true" />
              {localize('com_ui_channels_disable')}
            </Button>
          )}
        </div>
      </OGDialogFooter>
    </>
  );
}

/** The host controls feature availability and SHARE permission. */
interface ChannelsProps {
  agentId?: string;
  userId: string;
  tenantId?: string;
}
export default function Channels(props: ChannelsProps) {
  return (
    <OwnedChannels key={JSON.stringify([props.userId, props.tenantId, props.agentId])} {...props} />
  );
}
function OwnedChannels({ agentId, userId, tenantId }: ChannelsProps) {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [dialog, setDialog] = useState<string | null>(null);
  const [credentialMode, setCredentialMode] = useState<AgentChannel['credentialMode']>('per_user');
  const channels = useQuery(
    [QueryKeys.agentChannels, userId, tenantId, agentId],
    () => dataService.listAgentChannels(agentId!),
    {
      enabled: Boolean(agentId && userId),
      retry: false,
      // Presentation refresh only; the server owns deletion recovery and its timeouts.
      refetchInterval: (data, query) =>
        query.state.status !== 'error' && data?.some((channel) => channel.status === 'deleting')
          ? 2_000
          : false,
      refetchIntervalInBackground: false,
    },
  );
  const create = useMutation({
    mutationKey: [MutationKeys.agentChannels, userId, tenantId, agentId],
    mutationFn: () => {
      if (!agentId || !userId || !channels.isSuccess) throw new Error('Channel owner unavailable');
      return dataService.createAgentChannel(agentId, credentialMode);
    },
    onSuccess: async (channel) => {
      queryClient.setQueryData<AgentChannel[]>(
        [QueryKeys.agentChannels, userId, tenantId, agentId],
        (current) => [
          ...(current ?? []).filter((entry) => entry.channelId !== channel.channelId),
          channel,
        ],
      );
      setDialog(channel.channelId);
      await queryClient.invalidateQueries([QueryKeys.agentChannels, userId, tenantId, agentId]);
    },
  });
  const selected = channels.data?.find((channel) => channel.channelId === dialog);
  const connectionTitle =
    selected?.status === 'pending_install'
      ? 'com_ui_channels_setup_title'
      : 'com_ui_channels_manage';
  return (
    <section aria-labelledby={`${id}-heading`} className="mb-3 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <h3
            id={`${id}-heading`}
            className="text-text-secondary text-2xs truncate font-medium tracking-wide uppercase"
          >
            {localize('com_ui_channels_title')}
          </h3>
          <TooltipAnchor
            description={localize('com_ui_channels_description')}
            side="top"
            render={
              <button
                type="button"
                aria-label={localize('com_ui_channels_description')}
                className="text-text-tertiary hover:text-text-secondary focus-visible:ring-ring-primary flex size-4 shrink-0 items-center justify-center rounded focus:outline-hidden focus-visible:ring-2"
              >
                <Info className="size-3.5" aria-hidden="true" />
              </button>
            }
          />
        </div>
        <Button
          type="button"
          variant="section-action"
          size="compact"
          disabled={!agentId || !userId || !channels.isSuccess}
          aria-label={localize('com_ui_channels_add')}
          onClick={(event) => {
            triggerRef.current = event.currentTarget;
            create.reset();
            setCredentialMode('per_user');
            setDialog('add');
          }}
        >
          <Plus className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
          {localize('com_ui_add')}
        </Button>
      </div>
      {!agentId && (
        <p className="text-text-secondary text-2xs">{localize('com_ui_channels_save_first')}</p>
      )}
      {agentId && channels.isLoading && (
        <p role="status" className="text-text-secondary text-xs">
          {localize('com_ui_channels_loading')}
        </p>
      )}
      {channels.isError && (
        <div role="alert" className="space-y-2 text-sm">
          <p>{localize('com_ui_channels_list_error')}</p>
          <Button type="button" variant="outline" onClick={() => void channels.refetch()}>
            {localize('com_ui_channels_retry')}
          </Button>
        </div>
      )}
      {channels.data?.map((channel) => (
        <div key={channel.channelId} className="flex items-center justify-between gap-2 text-sm">
          <div className="flex min-w-0 items-center gap-2">
            {localize('com_ui_channels_slack')}
            <ChannelStatus status={channel.status} />
          </div>
          <Button
            type="button"
            variant="section-action"
            size="compact"
            disabled={
              channels.isError || channel.status === 'deleting' || channel.createdBy !== userId
            }
            onClick={(event) => {
              triggerRef.current = event.currentTarget;
              setDialog(channel.channelId);
            }}
          >
            {localize(
              channel.createdBy !== userId
                ? 'com_ui_channels_read_only'
                : actionLabels[channel.status],
            )}
          </Button>
        </div>
      ))}
      <OGDialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !create.isLoading) setDialog(null);
        }}
      >
        <OGDialogContent
          className="w-11/12 max-w-lg gap-0 overflow-hidden p-0"
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
        >
          <div className="flex max-h-[85dvh] flex-col">
            <div className="space-y-1 px-6 pt-6 pb-4">
              <OGDialogTitle>
                {localize(dialog === 'add' ? 'com_ui_channels_add' : connectionTitle)}
              </OGDialogTitle>
            </div>
            <div
              className="flex min-h-0 flex-1 flex-col"
              onKeyDown={(event) => {
                // The builder owns a form; credentials must never submit that form.
                if (event.key === 'Enter' && event.target instanceof HTMLInputElement)
                  event.preventDefault();
              }}
            >
              {dialog === 'add' && (
                <div className="space-y-4 overflow-y-auto px-6 pb-6">
                  <h4 className="text-sm font-medium">{localize('com_ui_channel_link_mode')}</h4>
                  {create.isError && (
                    <p role="alert" className="text-sm">
                      {localize('com_ui_channels_action_error')}
                    </p>
                  )}
                  <div
                    role="group"
                    aria-label={localize('com_ui_channel_link_mode')}
                    className="flex flex-wrap gap-2"
                  >
                    <Button
                      type="button"
                      variant="outline-toggle"
                      disabled={create.isLoading}
                      aria-pressed={credentialMode === 'per_user'}
                      onClick={() => setCredentialMode('per_user')}
                    >
                      {localize('com_ui_channel_link_per_user')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline-toggle"
                      disabled={create.isLoading}
                      aria-pressed={credentialMode === 'shared'}
                      onClick={() => setCredentialMode('shared')}
                    >
                      {localize('com_ui_channel_link_shared')}
                    </Button>
                  </div>
                  <p className="text-text-secondary text-sm">
                    {localize(
                      credentialMode === 'shared'
                        ? 'com_ui_channels_owner_help'
                        : 'com_ui_channels_per_user_help',
                    )}
                  </p>
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={create.isLoading}
                      onClick={() => setDialog(null)}
                    >
                      {localize('com_ui_cancel')}
                    </Button>
                    <Button
                      type="button"
                      disabled={create.isLoading || !channels.isSuccess}
                      onClick={() => create.mutate()}
                    >
                      {localize('com_ui_continue')}
                    </Button>
                  </div>
                </div>
              )}
              {selected && selected.createdBy === userId && agentId && (
                <Channel
                  key={selected.channelId}
                  agentId={agentId}
                  channel={selected}
                  userId={userId}
                  tenantId={tenantId}
                  enabled={channels.isSuccess && !channels.isFetching}
                  onClose={() =>
                    setDialog((current) => (current === selected.channelId ? null : current))
                  }
                />
              )}
              {dialog !== 'add' && !selected && (
                <p role="status">{localize('com_ui_channels_loading')}</p>
              )}
            </div>
          </div>
        </OGDialogContent>
      </OGDialog>
    </section>
  );
}

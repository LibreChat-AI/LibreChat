import { useId, useRef, useState, useEffect, useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { dataService, MutationKeys, QueryKeys } from 'librechat-data-provider';
import { X, Info, Plus, Power, User, Users, Pencil, Settings } from 'lucide-react';
import {
  Alert,
  Button,
  ControlCombobox,
  InfoHoverCard,
  Label,
  OGDialog,
  OGDialogContent,
  OGDialogTitle,
  OGDialogFooter,
  ChoiceCards,
  TooltipAnchor,
} from '@librechat/client';
import type { AgentChannel } from 'librechat-data-provider';
import type { SetupStep } from './ChannelSetup';
import type { TranslationKeys } from '~/hooks';
import { useSlackWorkspaces } from '~/components/Channels/useSlackWorkspaces';
import ChannelSetup, { ManifestView, SetupActions } from './ChannelSetup';
import ChannelStatus, { statusColors } from './ChannelStatus';
import { channelErrorLabel } from '~/utils/channelErrors';
import DeleteChannelDialog from './DeleteChannelDialog';
import { ChannelHeaderIcon } from './ChannelDetails';
import Loading from '~/components/Channels/Loading';
import WorkspaceChannel from './WorkspaceChannel';
import ChannelsDialog from './ChannelsDialog';
import ChannelUsage from './ChannelUsage';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

const actionLabels: Record<AgentChannel['status'], TranslationKeys> = {
  pending_install: 'com_ui_channels_setup',
  active: 'com_ui_channels_manage',
  disabled: 'com_ui_channels_manage',
  deleting: 'com_ui_channels_manage',
};

const modeLabels: Record<AgentChannel['credentialMode'], TranslationKeys> = {
  per_user: 'com_ui_channel_link_per_user',
  shared: 'com_ui_channel_link_shared',
};

function modeOptions(localize: (key: TranslationKeys) => string) {
  return [
    {
      value: 'per_user',
      label: localize('com_ui_channel_link_per_user'),
      description: localize('com_ui_channels_per_user_help'),
      icon: <Users className="size-5" strokeWidth={1.5} />,
    },
    {
      value: 'shared',
      label: localize('com_ui_channel_link_shared'),
      description: localize('com_ui_channels_owner_help'),
      icon: <User className="size-5" strokeWidth={1.5} />,
    },
  ];
}

function channelActionLabel(channel: AgentChannel, userId: string): TranslationKeys {
  if (channel.createdBy !== userId) return 'com_ui_channels_read_only';
  if (channel.workspaceId) return 'com_ui_channels_manage';
  return actionLabels[channel.status];
}

/** Managing is an icon with a tooltip; setting up and read-only stay as words. */
function RowAction({
  label,
  disabled,
  onOpen,
}: {
  label: TranslationKeys;
  disabled: boolean;
  onOpen: (button: HTMLButtonElement) => void;
}) {
  const localize = useLocalize();
  if (label !== 'com_ui_channels_manage') {
    return (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={disabled}
        onClick={(event) => onOpen(event.currentTarget)}
      >
        {localize(label)}
      </Button>
    );
  }
  return (
    <TooltipAnchor
      description={localize(label)}
      render={
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={localize(label)}
          disabled={disabled}
          onClick={(event) => onOpen(event.currentTarget)}
        >
          <Settings className="size-3.5" aria-hidden="true" />
        </Button>
      }
    />
  );
}

function Channel({
  agentId,
  channel,
  onClose,
  userId,
  tenantId,
  enabled,
  isAdmin,
}: {
  agentId: string;
  channel: AgentChannel;
  onClose: () => void;
  userId: string;
  tenantId?: string;
  enabled: boolean;
  isAdmin: boolean;
}) {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const id = useId();
  const [panel, setPanel] = useState<'setup' | 'mode' | null>(
    channel.status === 'pending_install' ? 'setup' : null,
  );
  const setup = panel === 'setup';
  const modeView = panel === 'mode';
  const [disableReason, setDisableReason] = useState<'disable' | 'mode' | null>(null);
  const [modeChoice, setModeChoice] = useState<AgentChannel['credentialMode']>(
    channel.credentialMode,
  );
  const [step, setStep] = useState<SetupStep>(1);
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
  const botName = manifest.data?.features.bot_user.display_name;
  const manifestText = manifest.data ? JSON.stringify(manifest.data, null, 2) : '';
  const [manifestCopied, setManifestCopied] = useState(false);
  const copyManifest = () => {
    void navigator.clipboard?.writeText(manifestText).then(() => {
      if (!active.current) return;
      setManifestCopied(true);
      setTimeout(() => {
        if (active.current) setManifestCopied(false);
      }, 3000);
    });
  };
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
    /** Credentials are cleared after every attempt, so a failed one returns to entering them. */
    onError: () => setStep(2),
    // Cached callbacks retain only a revocable holder, never render snapshots of secrets.
    mutationFn: async (action: 'activate' | 'disable' | 'mode') => {
      try {
        if (!active.current || !readiness.current.enabled || channel.createdBy !== userId)
          throw new Error('Channel unavailable');
        if (action === 'mode') {
          if (!channel.revision || channel.status !== 'disabled')
            throw new Error('Channel mode changed');
          return await dataService.changeAgentChannelMode(
            agentId,
            channel.channelId,
            modeChoice,
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
        return await dataService.disableAgentChannel(agentId, channel.channelId);
      } finally {
        clearCredentials();
      }
    },
    onSuccess: async (_data, action) => {
      // Disabling to change the identity stays in this dialog and lands on the cards.
      const changeMode = action === 'disable' && disableReason === 'mode';
      if (active.current && !changeMode) onClose();
      await queryClient.invalidateQueries([QueryKeys.agentChannels, userId, tenantId, agentId]);
      await queryClient.invalidateQueries([
        QueryKeys.agentChannelManifest,
        userId,
        tenantId,
        agentId,
        channel.channelId,
      ]);
      if (changeMode && active.current) {
        setDisableReason(null);
        setModeChoice(channel.credentialMode);
        setPanel('mode');
      }
    },
  });
  const busy = !enabled || mutation.isLoading || channel.status === 'deleting';
  const manifestProps = {
    loading: manifest.isLoading,
    failed: manifest.isError,
    onRetry: () => void manifest.refetch(),
    text: manifest.data ? manifestText : '',
    copied: manifestCopied,
    onCopy: copyManifest,
  };
  return (
    <>
      <div className="min-h-0 space-y-4 overflow-y-auto px-6 pb-4">
        {mutation.isError && (
          <Alert variant="error">{localize(channelErrorLabel(mutation.error))}</Alert>
        )}
        {mutation.isError && mutation.variables === 'activate' && (
          <p className="text-text-secondary text-sm">
            {localize('com_ui_channels_activation_retry')}
          </p>
        )}
        {modeView && (
          <div className="space-y-3">
            <ChoiceCards
              options={modeOptions(localize)}
              value={modeChoice}
              onChange={(value) => setModeChoice(value as AgentChannel['credentialMode'])}
              disabled={busy}
              aria-label={localize('com_ui_channel_link_mode')}
            />
            <p className="text-text-secondary text-xs">
              {localize('com_ui_channel_link_mode_confirm')}
            </p>
          </div>
        )}
        {!modeView && (
          <>
            {channel.status === 'active' && botName && (
              <ChannelUsage
                name={botName}
                perUser={channel.credentialMode === 'per_user'}
                isAdmin={isAdmin}
              />
            )}
            {setup ? (
              <ChannelSetup
                id={id}
                step={step}
                manifest={manifestProps}
                botName={botName}
                isAdmin={isAdmin}
                appId={appId}
                onAppId={setAppId}
                botToken={botToken}
                onBotToken={(value) => {
                  credentials.current.botToken = value;
                  setBotToken(value);
                }}
                signingSecret={signingSecret}
                onSigningSecret={(value) => {
                  credentials.current.signingSecret = value;
                  setSigningSecret(value);
                }}
                signingLabel={signingLabel}
                needsSigningSecret={needsSigningSecret}
                busy={busy}
              />
            ) : (
              <div className="border-border-light divide-border-light divide-y rounded-xl border empty:hidden">
                {(channel.status === 'active' || channel.status === 'disabled') && (
                  <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
                    <span className="text-text-secondary flex min-w-0 items-center gap-2">
                      {channel.credentialMode === 'shared' ? (
                        <User className="size-4 shrink-0" aria-hidden="true" />
                      ) : (
                        <Users className="size-4 shrink-0" aria-hidden="true" />
                      )}
                      <span className="truncate">
                        {localize(modeLabels[channel.credentialMode])}
                      </span>
                    </span>
                    <div className="-me-1.5">
                      <TooltipAnchor
                        description={localize('com_ui_channel_link_change_mode')}
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            aria-label={localize('com_ui_channel_link_change_mode')}
                            disabled={busy}
                            onClick={() => {
                              clearCredentials();
                              if (channel.status === 'active') {
                                setDisableReason('mode');
                                return;
                              }
                              setModeChoice(channel.credentialMode);
                              setPanel('mode');
                            }}
                          >
                            <Pencil className="size-3.5" aria-hidden="true" />
                          </Button>
                        }
                      />
                    </div>
                  </div>
                )}
                <div className="px-3 py-2 empty:hidden">
                  <ManifestView
                    id={id}
                    {...manifestProps}
                    defaultOpen={false}
                    copyClassName="-me-1.5"
                  />
                </div>
              </div>
            )}
          </>
        )}
      </div>
      <OGDialogFooter className="gap-2 px-6 pt-2 pb-6 sm:justify-end">
        {modeView && (
          <>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setPanel(null)}>
              {localize('com_ui_cancel')}
            </Button>
            <Button
              type="button"
              variant="submit"
              disabled={busy || !channel.revision || modeChoice === channel.credentialMode}
              onClick={() => mutation.mutate('mode')}
            >
              {localize('com_ui_save')}
            </Button>
          </>
        )}
        {setup && (
          <SetupActions
            step={step}
            onStep={setStep}
            busy={busy}
            canActivate={canActivate}
            alreadyActive={channel.status === 'active'}
            onActivate={() => mutation.mutate('activate')}
          />
        )}
        {channel.status !== 'active' && !setup && !modeView && (
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              clearCredentials();
              mutation.reset();
              setStep(1);
              setPanel('setup');
            }}
          >
            {localize('com_ui_channels_setup')}
          </Button>
        )}
        {channel.status === 'active' && !modeView && (
          <Button
            type="button"
            variant="destructive"
            className="me-auto"
            disabled={busy}
            onClick={() => setDisableReason('disable')}
          >
            <Power className="size-4" aria-hidden="true" />
            {localize('com_ui_channels_disable')}
          </Button>
        )}
      </OGDialogFooter>
      <DeleteChannelDialog
        open={disableReason != null}
        onOpenChange={(open) => {
          if (!open && !mutation.isLoading) setDisableReason(null);
        }}
        onConfirm={() => mutation.mutate('disable')}
        loading={mutation.isLoading}
        error={
          mutation.isError && mutation.variables === 'disable'
            ? localize(channelErrorLabel(mutation.error))
            : undefined
        }
        title={
          disableReason === 'mode'
            ? 'com_ui_channels_mode_disable_title'
            : 'com_ui_channels_disable_title'
        }
        description={
          disableReason === 'mode'
            ? 'com_ui_channels_mode_disable_first'
            : 'com_ui_channels_disable_confirm'
        }
        confirmLabel={
          disableReason === 'mode'
            ? 'com_ui_channels_mode_disable_confirm'
            : 'com_ui_channels_disable'
        }
      />
    </>
  );
}

/** The host controls feature availability and SHARE permission. */
interface ChannelsProps {
  agentId?: string;
  userId: string;
  tenantId?: string;
  /** Admins also see what the deployment must run for Slack to reach LibreChat. */
  isAdmin?: boolean;
}
export default function Channels(props: ChannelsProps) {
  return (
    <OwnedChannels key={JSON.stringify([props.userId, props.tenantId, props.agentId])} {...props} />
  );
}
function OwnedChannels({ agentId, userId, tenantId, isAdmin = false }: ChannelsProps) {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [contentElement, setContentElement] = useState<HTMLDivElement | null>(null);
  const setContentRef = useCallback((element: HTMLDivElement | null) => {
    contentRef.current = element;
    setContentElement(element);
  }, []);
  const [dialog, setDialog] = useState<string | null>(null);
  const [newWorkspaceConnection, setNewWorkspaceConnection] = useState<string | null>(null);
  const [credentialMode, setCredentialMode] = useState<AgentChannel['credentialMode']>('per_user');
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [workspaceId, setWorkspaceId] = useState('');
  const workspaces = useSlackWorkspaces(
    JSON.stringify([tenantId ?? '_', userId]),
    Boolean(agentId && userId),
  );
  const workspaceStatus = workspaces.data?.pages[0];
  const availableWorkspaces =
    workspaces.data?.pages
      .flatMap((page) => page.workspaces)
      .filter((workspace) => workspace.status === 'active' && workspace.canManageBot === true) ??
    [];
  const workspaceReady = workspaces.isSuccess && !workspaces.isFetching;
  const useWorkspace = workspaceStatus?.configured === true;
  const botName = (workspace: (typeof availableWorkspaces)[number]) =>
    workspace.appName?.trim() ||
    localize('com_ui_channels_slack_app_fallback', { 0: workspace.appId });
  const selectedWorkspace = availableWorkspaces.find(
    (workspace) => workspace.workspaceId === workspaceId,
  );
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
  const [rowDelete, setRowDelete] = useState<AgentChannel | null>(null);
  const rowDeleteRef = useRef<HTMLButtonElement | null>(null);
  const removeRow = useMutation({
    mutationKey: [MutationKeys.agentChannels, userId, tenantId, agentId, 'delete'],
    mutationFn: (channelId: string) => dataService.deleteAgentChannel(agentId!, channelId),
    onSuccess: async () => {
      setRowDelete(null);
      await queryClient.invalidateQueries([QueryKeys.agentChannels, userId, tenantId, agentId]);
    },
  });
  const create = useMutation({
    mutationKey: [MutationKeys.agentChannels, userId, tenantId, agentId],
    mutationFn: () => {
      if (!agentId || !userId || !channels.isSuccess || !workspaceReady)
        throw new Error('Channel owner unavailable');
      if (useWorkspace) {
        if (!availableWorkspaces.some((workspace) => workspace.workspaceId === workspaceId))
          throw new Error('Workspace unavailable');
        return dataService.createWorkspaceAgentChannel(agentId, workspaceId);
      }
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
      setNewWorkspaceConnection(channel.workspaceId ? channel.channelId : null);
      setDialog(channel.channelId);
      await queryClient.invalidateQueries([QueryKeys.agentChannels, userId, tenantId, agentId]);
    },
  });
  const selected = channels.data?.find((channel) => channel.channelId === dialog);
  const connectionTitle =
    selected?.status === 'pending_install' &&
    (!selected.workspaceId || newWorkspaceConnection === selected.channelId)
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
          <InfoHoverCard text={localize('com_ui_channels_description')}>
            <Info className="text-text-tertiary size-3.5" aria-hidden="true" />
          </InfoHoverCard>
        </div>
        <Button
          type="button"
          variant="section-add"
          disabled={!agentId || !userId || !channels.isSuccess}
          aria-label={localize('com_ui_channels_add')}
          onClick={(event) => {
            triggerRef.current = event.currentTarget;
            setLibraryOpen(true);
          }}
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
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
        <div className="flex flex-col items-start gap-2">
          <Alert variant="error">{localize('com_ui_channels_list_error')}</Alert>
          <Button type="button" variant="outline" onClick={() => void channels.refetch()}>
            {localize('com_ui_channels_retry')}
          </Button>
        </div>
      )}
      {channels.data != null && channels.data.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {channels.data.map((channel) => (
            <li
              key={channel.channelId}
              className="group hover:bg-surface-secondary flex items-center gap-2.5 rounded-lg px-2 py-1.5"
            >
              <span className="relative shrink-0" aria-hidden="true">
                <span className="bg-surface-fixed flex size-7 items-center justify-center overflow-hidden rounded-md">
                  <img src="assets/slack.svg" alt="" className="size-4" />
                </span>
                <span
                  className={cn(
                    'ring-surface-primary absolute -end-0.5 -bottom-0.5 size-2.5 rounded-full ring-2',
                    statusColors[channel.status],
                  )}
                />
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-text-primary truncate text-sm font-medium">
                  {localize('com_ui_channels_slack')}
                </span>
                <ChannelStatus
                  status={channel.status}
                  pendingLabel={
                    channel.workspaceId ? 'com_ui_channels_workspace_not_assigned' : undefined
                  }
                  dot={false}
                  /* An active connection is the quiet default and the dot says it; every other
                     state needs an action, so its name is shown, not left to the dot's color. */
                  className={channel.status === 'active' ? 'sr-only' : undefined}
                />
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <div className="no-touch:opacity-0 flex items-center group-hover:opacity-100 group-has-[:focus-visible]:opacity-100">
                  <RowAction
                    label={channelActionLabel(channel, userId)}
                    disabled={
                      channels.isError ||
                      channel.status === 'deleting' ||
                      channel.createdBy !== userId
                    }
                    onOpen={(button) => {
                      triggerRef.current = button;
                      setNewWorkspaceConnection(null);
                      setDialog(channel.channelId);
                    }}
                  />
                </div>
                {channel.createdBy === userId && channel.status !== 'deleting' && (
                  <div className="no-touch:opacity-0 shrink-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100">
                    <TooltipAnchor
                      description={localize('com_ui_channels_delete_connection')}
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={localize('com_ui_channels_delete_connection')}
                          onClick={(event) => {
                            rowDeleteRef.current = event.currentTarget;
                            removeRow.reset();
                            setRowDelete(channel);
                          }}
                        >
                          <X className="size-3.5" aria-hidden="true" />
                        </Button>
                      }
                    />
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <DeleteChannelDialog
        open={rowDelete != null}
        onOpenChange={(open) => {
          if (!open && !removeRow.isLoading) setRowDelete(null);
        }}
        onConfirm={() => rowDelete && removeRow.mutate(rowDelete.channelId)}
        loading={removeRow.isLoading}
        error={removeRow.isError ? localize(channelErrorLabel(removeRow.error)) : undefined}
        triggerRef={rowDeleteRef}
      />
      <ChannelsDialog
        open={libraryOpen}
        onOpenChange={setLibraryOpen}
        onSelect={() => {
          setLibraryOpen(false);
          create.reset();
          setCredentialMode('per_user');
          setWorkspaceId('');
          setDialog('add');
        }}
      />
      <OGDialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !create.isLoading) setDialog(null);
        }}
      >
        <OGDialogContent
          ref={setContentRef}
          tabIndex={-1}
          className="w-11/12 max-w-2xl gap-0 overflow-visible p-0"
          showCloseButton={dialog !== 'add'}
          focusOutline="hidden"
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            // Focus the dialog itself: the first control is the details icon, and focusing it
            // would open its hover card the moment the dialog appears.
            event.preventDefault();
            contentRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
        >
          <div className="flex max-h-[85dvh] flex-col">
            <div
              className={cn(
                'flex items-center gap-3 px-6 pb-4',
                dialog === 'add' ? 'pt-6' : 'pt-4',
              )}
            >
              {dialog !== 'add' && selected && <ChannelHeaderIcon channel={selected} />}
              <div className="min-w-0 space-y-1">
                <OGDialogTitle>
                  {localize(dialog === 'add' ? 'com_ui_channels_add_slack' : connectionTitle)}
                </OGDialogTitle>
                {dialog === 'add' && workspaces.isSuccess && !useWorkspace && (
                  <p id={`${id}-mode`} className="text-text-secondary text-sm">
                    {localize('com_ui_channel_link_mode')}
                  </p>
                )}
              </div>
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
                  {workspaces.isLoading && <Loading label="com_ui_channels_loading" />}
                  {workspaces.isError && (
                    <Alert variant="error">
                      <p>{localize('com_ui_channels_workspace_load_error')}</p>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void workspaces.refetch()}
                      >
                        {localize('com_ui_retry')}
                      </Button>
                    </Alert>
                  )}
                  {workspaces.isSuccess && useWorkspace && (
                    <div className="space-y-3">
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor={`${id}-bot`} className="w-auto">
                          {localize('com_ui_channels_slack_bot')}
                        </Label>
                        <InfoHoverCard text={localize('com_ui_channels_workspace_identity')}>
                          <Info className="text-text-tertiary size-4" aria-hidden="true" />
                        </InfoHoverCard>
                      </div>
                      {availableWorkspaces.length === 0 ? (
                        <Alert variant="info">
                          {localize('com_ui_channels_workspace_connect_first')}
                        </Alert>
                      ) : (
                        <ControlCombobox
                          selectId={`${id}-bot`}
                          selectedValue={workspaceId}
                          displayValue={selectedWorkspace ? botName(selectedWorkspace) : undefined}
                          selectPlaceholder={localize('com_ui_channels_slack_bot_choose')}
                          searchPlaceholder={localize('com_ui_channels_slack_bot_search')}
                          ariaLabel={localize('com_ui_channels_slack_bot')}
                          setValue={setWorkspaceId}
                          items={availableWorkspaces.map((workspace) => ({
                            value: workspace.workspaceId,
                            label: `${botName(workspace)} · ${workspace.teamName} (${workspace.appId})`,
                          }))}
                          renderOption={(item) => {
                            const workspace = availableWorkspaces.find(
                              (entry) => entry.workspaceId === item.value,
                            );
                            if (!workspace) return item.label;
                            return (
                              <span className="flex min-w-0 flex-col">
                                <span className="truncate">{botName(workspace)}</span>
                                <span className="text-text-secondary truncate text-xs">
                                  {workspace.teamName} · {workspace.appId}
                                </span>
                              </span>
                            );
                          }}
                          variant="field"
                          isCollapsed={false}
                          showCarat
                          disabled={create.isLoading || workspaces.isFetching}
                          optionHeight={52}
                          popoverMaxHeight={300}
                          portalElement={contentElement}
                        />
                      )}
                      {workspaces.hasNextPage && (
                        <Button
                          type="button"
                          variant="outline"
                          disabled={workspaces.isFetchingNextPage}
                          onClick={() => void workspaces.fetchNextPage()}
                        >
                          {localize('com_ui_slack_workspaces_more')}
                        </Button>
                      )}
                    </div>
                  )}
                  {workspaces.isSuccess && !useWorkspace && (
                    <ChoiceCards
                      options={modeOptions(localize)}
                      value={credentialMode}
                      onChange={(value) =>
                        setCredentialMode(value as AgentChannel['credentialMode'])
                      }
                      disabled={create.isLoading}
                      aria-labelledby={`${id}-mode`}
                    />
                  )}
                  {create.isError && (
                    <Alert variant="error">{localize(channelErrorLabel(create.error))}</Alert>
                  )}
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
                      disabled={
                        create.isLoading ||
                        !workspaceReady ||
                        !channels.isSuccess ||
                        (useWorkspace &&
                          !availableWorkspaces.some(
                            (workspace) => workspace.workspaceId === workspaceId,
                          ))
                      }
                      onClick={() => create.mutate()}
                    >
                      {localize('com_ui_continue')}
                    </Button>
                  </div>
                </div>
              )}
              {selected &&
                selected.createdBy === userId &&
                agentId &&
                (selected.workspaceId ? (
                  <WorkspaceChannel
                    key={selected.channelId}
                    agentId={agentId}
                    initialSetup={newWorkspaceConnection === selected.channelId}
                    channel={selected}
                    userId={userId}
                    tenantId={tenantId}
                    enabled={channels.isSuccess && !channels.isFetching}
                    onClose={() =>
                      setDialog((current) => (current === selected.channelId ? null : current))
                    }
                  />
                ) : (
                  <Channel
                    key={selected.channelId}
                    agentId={agentId}
                    channel={selected}
                    userId={userId}
                    tenantId={tenantId}
                    isAdmin={isAdmin}
                    enabled={channels.isSuccess && !channels.isFetching}
                    onClose={() =>
                      setDialog((current) => (current === selected.channelId ? null : current))
                    }
                  />
                ))}
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

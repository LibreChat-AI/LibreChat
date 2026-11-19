import { useCallback, useEffect, useId, useRef } from 'react';
import { useHydrateAtoms } from 'jotai/utils';
import { atom, Provider, useAtom } from 'jotai';
import {
  channelSnowflakeSchema,
  dataService,
  MutationKeys,
  QueryKeys,
} from 'librechat-data-provider';
import {
  useInfiniteQuery,
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  Alert,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  ControlCombobox,
  Input,
  Label,
} from '@librechat/client';
import type { DiscordAgentChannel, DiscordBindingTarget } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { useDebounce, useLocalize } from '~/hooks';

const targetAtom = atom({ installationId: '', externalChannelId: '' });
const uncertainAtom = atom(false);
const confirmationAtom = atom<{
  kind: 'bind' | 'remove';
  target: DiscordBindingTarget;
  revision: string;
} | null>(null);
interface Props {
  agentId: string;
  userId: string;
  tenantId?: string;
  channel?: DiscordAgentChannel;
  enabled: boolean;
  portalElement?: HTMLElement | null;
  onClose: () => void;
}
function label(error: unknown): TranslationKeys {
  if (error instanceof Error) {
    if ('status' in error && error.status === 403) return 'com_ui_discord_binding_forbidden';
    if ('status' in error && error.status === 404) return 'com_ui_discord_disabled';
    if ('code' in error) {
      if (error.code === 'unsupported_channel') return 'com_ui_discord_binding_unsupported';
      if (error.code === 'missing_permissions') return 'com_ui_discord_binding_permissions';
      if (error.code === 'transactions_unavailable') return 'com_ui_channels_transaction_required';
      if (
        [
          'route_changed',
          'application_changed',
          'installation_unavailable',
          'guild_changed',
        ].includes(String(error.code))
      )
        return 'com_ui_discord_changed';
    }
  }
  return 'com_ui_discord_binding_uncertain';
}
/** Account, agent and immutable channel identity each own a fresh feature store. */
export default function DiscordBinding(props: Props) {
  return (
    <Provider
      key={JSON.stringify([props.tenantId, props.userId, props.agentId, props.channel?.channelId])}
    >
      <Binding {...props} />
    </Provider>
  );
}
function Binding({ agentId, userId, tenantId, channel, enabled, portalElement, onClose }: Props) {
  useHydrateAtoms([
    [
      targetAtom,
      {
        installationId: channel?.installationId ?? '',
        externalChannelId: channel?.discord.externalChannelId ?? '',
      },
    ],
  ]);
  const localize = useLocalize();
  const id = useId();
  const client = useQueryClient();
  const [target, setTarget] = useAtom(targetAtom);
  const [uncertain, setUncertain] = useAtom(uncertainAtom);
  const [confirmation, setConfirmation] = useAtom(confirmationAtom);
  const actionRef = useRef<HTMLButtonElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const checkRef = useRef<HTMLButtonElement | null>(null);
  const focusCheck = useRef(false);
  const mounted = useRef(true);
  const nextPageFailed = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const principal = JSON.stringify([tenantId ?? '_', userId]);
  const bindingPrefix = [QueryKeys.discordBindings, principal];
  const guildKey = [QueryKeys.discordGuilds, principal];
  const busy = useIsMutating({ mutationKey: [MutationKeys.discordBindings, principal] }) > 0;
  const guilds = useInfiniteQuery(
    guildKey,
    ({ pageParam }: { pageParam?: string }) => dataService.getDiscordGuilds(pageParam),
    { enabled, retry: false, cacheTime: 0, getNextPageParam: (page) => page.next },
  );
  const installations = guilds.data?.pages.flatMap((page) => page.guilds) ?? [];
  const selected = installations.find((guild) => guild.installationId === target.installationId);
  const guildReady = guilds.isSuccess && !guilds.isFetching;
  const debounced = useDebounce(target.externalChannelId.trim(), 250);
  const valid = channelSnowflakeSchema.safeParse(debounced).success;
  const invalidChannel =
    Boolean(target.externalChannelId.trim()) &&
    !channelSnowflakeSchema.safeParse(target.externalChannelId.trim()).success;
  const settled = debounced === target.externalChannelId.trim();
  const input = { agentId, installationId: target.installationId, externalChannelId: debounced };
  const status = useQuery(
    [...bindingPrefix, agentId, target.installationId, debounced],
    () => dataService.getDiscordBinding(input),
    {
      enabled: enabled && guildReady && Boolean(selected) && valid && settled,
      retry: false,
      cacheTime: 0,
    },
  );
  const cancelReads = useCallback(async () => {
    await Promise.all([
      client.cancelQueries([QueryKeys.discordBindings, principal]),
      client.cancelQueries([QueryKeys.discordGuilds, principal]),
      client.cancelQueries([QueryKeys.agentChannels]),
    ]);
  }, [client, principal]);
  const reconcile = useCallback(async () => {
    nextPageFailed.current = false;
    // Replacement affects the predecessor's agent too, so every Channels reader must reconcile.
    await Promise.all([
      client.invalidateQueries([QueryKeys.discordBindings, principal]),
      client.invalidateQueries([QueryKeys.discordGuilds, principal]),
      client.invalidateQueries([QueryKeys.agentChannels]),
    ]);
  }, [client, principal]);
  const mutation = useMutation({
    mutationKey: [MutationKeys.discordBindings, principal, agentId],
    retry: false,
    mutationFn: async (action: {
      kind: 'bind' | 'remove';
      input: DiscordBindingTarget;
      revision?: string;
    }) => {
      if (
        !mounted.current ||
        !enabled ||
        uncertain ||
        !guildReady ||
        !status.isSuccess ||
        status.isFetching ||
        !settled ||
        !valid ||
        action.input.installationId !== target.installationId ||
        action.input.externalChannelId !== debounced ||
        action.revision !== status.data.revision
      )
        throw new Error('Discord binding changed');
      if (action.kind === 'remove') {
        if (!status.data.assignedToThisAgent || !action.revision)
          throw new Error('Discord binding unavailable');
        return dataService.removeDiscordBinding({
          ...action.input,
          expectedRevision: action.revision,
        });
      }
      if (selected?.status !== 'active' || !status.data.canReplace)
        throw new Error('Discord binding unavailable');
      return dataService.bindDiscordChannel({
        ...action.input,
        ...(action.revision ? { expectedRevision: action.revision } : {}),
      });
    },
    onMutate: cancelReads,
    onError: async () => {
      if (mounted.current) {
        focusCheck.current = true;
        setUncertain(true);
      }
      await cancelReads();
    },
    onSuccess: () => {
      if (!mounted.current) return;
      setConfirmation(null);
      onClose();
    },
    onSettled: async (_data, error) => {
      await reconcile();
      if (error && mounted.current) setConfirmation(null);
    },
  });
  useEffect(() => {
    if (
      focusCheck.current &&
      uncertain &&
      !confirmation &&
      !busy &&
      !status.isFetching &&
      !guilds.isFetching
    ) {
      checkRef.current?.focus();
      focusCheck.current = false;
    }
  }, [uncertain, confirmation, busy, status.isFetching, guilds.isFetching]);
  const ready =
    enabled &&
    guildReady &&
    status.isSuccess &&
    !status.isFetching &&
    settled &&
    valid &&
    Boolean(selected) &&
    !busy &&
    !uncertain;
  const canBind = ready && selected?.status === 'active' && status.data?.canReplace === true;
  const immutable = Boolean(channel);
  const choose = (installationId: string, externalChannelId = target.externalChannelId) => {
    mutation.reset();
    setTarget({ installationId, externalChannelId });
  };
  const check = async () => {
    nextPageFailed.current = false;
    const [freshGuilds, freshStatus] = await Promise.all([guilds.refetch(), status.refetch()]);
    if (mounted.current && !freshGuilds.isError && !freshStatus.isError) {
      setUncertain(false);
      mutation.reset();
    }
  };
  const confirmReady =
    ready &&
    confirmation?.revision === status.data?.revision &&
    confirmation?.target.installationId === target.installationId &&
    confirmation?.target.externalChannelId === debounced &&
    (confirmation?.kind === 'bind' ? canBind : status.data?.assignedToThisAgent);
  let statusText = localize('com_ui_discord_binding_available');
  if (status.data?.occupied)
    statusText = status.data.assignedAgentName
      ? localize('com_ui_discord_binding_collision_named', { 0: status.data.assignedAgentName })
      : localize('com_ui_discord_binding_collision');
  if (status.data?.assignedToThisAgent) statusText = localize('com_ui_discord_binding_assigned');
  return (
    <div className="space-y-4 text-sm">
      <p className="text-text-secondary">{localize('com_ui_discord_binding_help')}</p>
      {guilds.isLoading && <p role="status">{localize('com_ui_channels_loading')}</p>}
      {guilds.isError && (
        <Alert variant="error">
          {localize(label(guilds.error))}
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              if (nextPageFailed.current)
                void guilds.fetchNextPage().then((result) => {
                  nextPageFailed.current = result.isError;
                });
              else void guilds.refetch();
            }}
          >
            {localize('com_ui_retry')}
          </Button>
        </Alert>
      )}
      {guildReady &&
        !guilds.hasNextPage &&
        !installations.some((guild) => guild.status === 'active') && (
          <Alert variant="warning">{localize('com_ui_discord_binding_empty')}</Alert>
        )}
      {guildReady && immutable && !selected && !guilds.hasNextPage && (
        <Alert variant="warning">{localize('com_ui_discord_binding_missing')}</Alert>
      )}
      <div>
        <Label htmlFor={`${id}-server`}>{localize('com_ui_discord_binding_server')}</Label>
        <ControlCombobox
          selectId={`${id}-server`}
          ariaLabel={localize('com_ui_discord_binding_server')}
          searchPlaceholder={localize('com_ui_search')}
          selectedValue={target.installationId}
          displayValue={
            selected
              ? localize('com_ui_discord_binding_server_named', {
                  0: selected.guildName,
                  1: selected.applicationId,
                })
              : undefined
          }
          setValue={(value) => choose(value)}
          items={installations
            .filter(
              (guild) =>
                guild.status === 'active' || guild.installationId === target.installationId,
            )
            .map((guild) => ({
              value: guild.installationId,
              label: localize('com_ui_discord_binding_server_named', {
                0: guild.guildName,
                1: guild.applicationId,
              }),
            }))}
          isCollapsed={false}
          variant="field"
          portal={Boolean(portalElement)}
          portalElement={portalElement ?? undefined}
          disabled={
            immutable || busy || uncertain || !enabled || !guildReady || Boolean(confirmation)
          }
          selectPlaceholder={localize('com_ui_select')}
        />
      </div>
      {guilds.hasNextPage && (
        <Button
          type="button"
          variant="outline"
          disabled={busy || guilds.isFetching || uncertain}
          onClick={() => {
            nextPageFailed.current = true;
            void guilds.fetchNextPage().then((result) => {
              nextPageFailed.current = result.isError;
            });
          }}
        >
          {localize('com_ui_discord_more_guilds')}
        </Button>
      )}
      <div>
        <Label htmlFor={`${id}-channel`}>{localize('com_ui_discord_binding_channel')}</Label>
        <Input
          id={`${id}-channel`}
          value={target.externalChannelId}
          readOnly={immutable}
          disabled={busy || uncertain || !enabled || Boolean(confirmation)}
          inputMode="numeric"
          maxLength={20}
          autoComplete="off"
          aria-invalid={invalidChannel}
          aria-describedby={
            invalidChannel ? `${id}-channel-help ${id}-channel-error` : `${id}-channel-help`
          }
          onChange={(event) => choose(target.installationId, event.target.value)}
        />
        {invalidChannel && (
          <p id={`${id}-channel-error`} role="alert" className="text-text-destructive">
            {localize('com_ui_discord_invalid')}
          </p>
        )}
        <p id={`${id}-channel-help`} className="text-text-secondary text-xs">
          {localize('com_ui_discord_binding_channel_help')}
        </p>
      </div>
      {guildReady && selected && valid && settled && status.isLoading && (
        <p role="status">{localize('com_ui_channels_loading')}</p>
      )}
      {status.isError && (
        <Alert variant="error">
          {localize(label(status.error))}
          <Button type="button" variant="outline" disabled={busy} onClick={() => void check()}>
            {localize('com_ui_retry')}
          </Button>
        </Alert>
      )}
      {mutation.isError && (
        <Alert variant="warning">
          <p>{localize(label(mutation.error))}</p>
          <p>{localize('com_ui_discord_binding_check_help')}</p>
        </Alert>
      )}
      {(uncertain || mutation.isError) && (
        <Button
          type="button"
          variant="outline"
          disabled={busy || status.isFetching || guilds.isFetching}
          ref={checkRef}
          onClick={() => void check()}
        >
          {localize('com_ui_discord_binding_check')}
        </Button>
      )}
      {status.isSuccess && selected && valid && settled && (
        <div>
          <h3 ref={headingRef} tabIndex={-1} className="font-medium">
            {localize('com_ui_discord_binding_status')}
          </h3>
          <p role="status">{statusText}</p>
          {!status.data.canReplace && (
            <p className="text-text-secondary">{localize('com_ui_discord_binding_unavailable')}</p>
          )}
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="submit"
          disabled={!canBind || (status.data?.occupied && !status.data.revision)}
          onClick={(event) => {
            actionRef.current = event.currentTarget;
            if (status.data?.occupied && status.data.revision)
              setConfirmation({ kind: 'bind', target: input, revision: status.data.revision });
            else mutation.mutate({ kind: 'bind', input, revision: status.data?.revision });
          }}
        >
          {localize(
            status.data?.occupied
              ? 'com_ui_discord_binding_replace'
              : 'com_ui_discord_binding_connect',
          )}
        </Button>
        {status.data?.assignedToThisAgent && (
          <Button
            type="button"
            variant="outline"
            disabled={!ready || !status.data.revision}
            onClick={(event) => {
              actionRef.current = event.currentTarget;
              if (status.data?.revision)
                setConfirmation({ kind: 'remove', target: input, revision: status.data.revision });
            }}
          >
            {localize('com_ui_discord_binding_remove')}
          </Button>
        )}
      </div>
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmation(null);
        }}
      >
        <AlertDialogContent
          className="w-11/12 max-w-md"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (actionRef.current?.isConnected && !actionRef.current.disabled)
              actionRef.current.focus();
            else headingRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {localize(
                confirmation?.kind === 'remove'
                  ? 'com_ui_discord_binding_remove'
                  : 'com_ui_discord_binding_replace',
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {localize(
                confirmation?.kind === 'remove'
                  ? 'com_ui_discord_binding_remove_help'
                  : 'com_ui_discord_binding_replace_help',
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {!confirmReady && !busy && (
            <Alert variant="warning">{localize('com_ui_discord_changed')}</Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{localize('com_ui_cancel')}</AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                type="button"
                variant="destructive"
                disabled={busy || !confirmReady}
                onClick={(event) => {
                  event.preventDefault();
                  if (confirmation && confirmReady)
                    mutation.mutate({
                      kind: confirmation.kind,
                      input: confirmation.target,
                      revision: confirmation.revision,
                    });
                }}
              >
                {localize('com_ui_confirm')}
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

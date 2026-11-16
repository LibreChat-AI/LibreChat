import { useCallback, useEffect, useId, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { atom, Provider, useAtom } from 'jotai';
import {
  useInfiniteQuery,
  useIsMutating,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import {
  DISCORD_COMMAND_MANIFEST_VERSION,
  channelSnowflakeSchema,
  configureDiscordApplicationSchema,
  dataService,
  MutationKeys,
  QueryKeys,
} from 'librechat-data-provider';
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
  DiscordIcon,
  Input,
  Label,
  OGDialog,
  OGDialogTemplate,
  OGDialogTrigger,
  Spinner,
} from '@librechat/client';
import type {
  ConfigureDiscordApplication,
  DiscordApplicationPage,
  RegisterDiscordCommands,
  DiscordApplication,
  DiscordGuild,
} from 'librechat-data-provider';
import type { InfiniteData } from '@tanstack/react-query';
import type { TranslationKeys } from '~/hooks';
import { watchOAuthSettlements } from '~/data-provider/PullRequest/signIn';
import { useAuthContext, useLocalize } from '~/hooks';

const editorAtom = atom<DiscordApplication | 'new' | null>(null);
const confirmAtom = atom<DiscordGuild | null>(null);
const flowAtom = atom<'pending' | 'cancelling' | 'failed' | null>(null);
const openAtom = atom(false);
const empty = { applicationId: '', name: '', botToken: '', clientSecret: '' };
type Fields = typeof empty;
type Attempt = { popup: Window; flowId?: string; cancelling: boolean };

/** Safe codes only; error messages are never shown, and unknown codes stay unconfirmed. */
function errorLabel(error: unknown): TranslationKeys {
  if (!(error instanceof Error)) return 'com_ui_discord_error';
  if ('status' in error && error.status === 403) return 'com_ui_discord_admin';
  if ('status' in error && error.status === 404) return 'com_ui_discord_disabled';
  if (!('code' in error)) return 'com_ui_discord_error';
  switch (error.code) {
    case 'transactions_unavailable':
      return 'com_ui_channels_transaction_required';
    case 'application_changed':
    case 'installation_changed':
      return 'com_ui_discord_changed';
    case 'provider_refused':
      return 'com_ui_discord_refused';
    case 'unsupported_installation':
      return 'com_ui_discord_code_grant';
    case 'application_in_use':
      return 'com_ui_discord_in_use';
    case 'rate_limited':
      return 'com_ui_discord_rate_limited';
    case 'provider_unavailable':
      return 'com_ui_discord_provider_unavailable';
    case 'timeout':
      return 'com_ui_discord_timeout';
    default:
      return 'com_ui_discord_error';
  }
}

/** A fresh feature store and form belong to exactly one signed-in account. */
export default function Discord({
  userId,
  tenantId,
  showDescription = true,
}: {
  userId: string;
  tenantId?: string;
  showDescription?: boolean;
}) {
  const principalKey = JSON.stringify([tenantId ?? '_', userId]);
  return (
    <Provider key={principalKey}>
      <Setup principalKey={principalKey} showDescription={showDescription} />
    </Provider>
  );
}

export function DiscordSettings() {
  const { user } = useAuthContext();
  return user ? (
    <Provider key={JSON.stringify([user.tenantId, user.id])}>
      <SettingsControl userId={user.id} tenantId={user.tenantId} />
    </Provider>
  ) : null;
}
function SettingsControl(props: { userId: string; tenantId?: string }) {
  const localize = useLocalize();
  const [open, setOpen] = useAtom(openAtom);
  return (
    <OGDialog open={open} onOpenChange={setOpen}>
      <OGDialogTrigger asChild>
        <Button type="button" variant="ghost" className="w-full justify-start">
          <DiscordIcon />
          {localize('com_ui_discord_title')}
        </Button>
      </OGDialogTrigger>
      <OGDialogTemplate
        title={localize('com_ui_discord_title')}
        description={localize('com_ui_discord_description')}
        className="max-w-2xl"
        mainClassName="max-h-[70dvh] overflow-y-auto"
        showCloseButton
        showCancelButton={false}
        main={open ? <Discord {...props} showDescription={false} /> : null}
      />
    </OGDialog>
  );
}

function Setup({
  principalKey,
  showDescription,
}: {
  principalKey: string;
  showDescription: boolean;
}) {
  const localize = useLocalize();
  const id = useId();
  const client = useQueryClient();
  const failedNextPage = useRef({ apps: false, guilds: false });
  const [editor, setEditor] = useAtom(editorAtom);
  const [confirm, setConfirm] = useAtom(confirmAtom);
  const [flow, setFlow] = useAtom(flowAtom);
  const attempt = useRef<Attempt | null>(null);
  const submission = useRef<ConfigureDiscordApplication | null>(null);
  const mounted = useRef(true);
  const deadline = useRef<ReturnType<typeof setTimeout>>();
  const editorTrigger = useRef<HTMLButtonElement | null>(null);
  const restoreEditorFocus = useRef(false);
  const disconnectTrigger = useRef<HTMLButtonElement | null>(null);
  const guildHeading = useRef<HTMLHeadingElement | null>(null);
  const appsHeading = useRef<HTMLHeadingElement | null>(null);
  const loadFailure = useRef<HTMLDivElement | null>(null);
  const busy = useIsMutating({ mutationKey: [MutationKeys.discordSetup, principalKey] }) > 0;
  const apps = useInfiniteQuery(
    [QueryKeys.discordApps, principalKey],
    ({ pageParam }: { pageParam?: string }) => dataService.getDiscordApps(pageParam),
    { enabled: !busy, retry: false, cacheTime: 0, getNextPageParam: (page) => page.next },
  );
  const guilds = useInfiniteQuery(
    [QueryKeys.discordGuilds, principalKey],
    ({ pageParam }: { pageParam?: string }) => dataService.getDiscordGuilds(pageParam),
    { enabled: !busy, retry: false, cacheTime: 0, getNextPageParam: (page) => page.next },
  );
  const form = useForm<Fields>({ defaultValues: empty });
  const cancelReads = useCallback(async () => {
    await Promise.all([
      client.cancelQueries([QueryKeys.discordApps, principalKey]),
      client.cancelQueries([QueryKeys.discordGuilds, principalKey]),
    ]);
  }, [client, principalKey]);
  const refresh = useCallback(async () => {
    await cancelReads();
    failedNextPage.current = { apps: false, guilds: false };
    await Promise.all([
      client.invalidateQueries([QueryKeys.discordApps, principalKey]),
      client.invalidateQueries([QueryKeys.discordGuilds, principalKey]),
      client.invalidateQueries([QueryKeys.agentChannels]),
    ]);
  }, [client, principalKey, cancelReads]);
  /** A failure answers a user action: focusing it scrolls a long dialog to it and keeps keyboard users oriented. */
  const reveal = useCallback((node: HTMLDivElement | null) => {
    node?.focus();
  }, []);
  // No optimistic cache writes: all pages reconcile after success, rejection or an uncertain response.
  const lifecycle = { onMutate: cancelReads, onError: cancelReads, onSettled: refresh };
  const save = useMutation({
    ...lifecycle,
    mutationKey: [MutationKeys.discordSetup, principalKey, 'save'],
    mutationFn: async () => {
      const input = submission.current;
      submission.current = null;
      if (!input) throw new Error('Missing Discord registration');
      try {
        return await dataService.configureDiscordApplication(input);
      } finally {
        input.botToken = undefined;
        input.clientSecret = undefined;
      }
    },
    onSuccess: () => {
      if (mounted.current) {
        form.reset(empty);
        restoreEditorFocus.current = true;
        setEditor(null);
      }
    },
  });
  const commands = useMutation({
    ...lifecycle,
    retry: false,
    mutationKey: [MutationKeys.discordSetup, principalKey, 'commands'],
    mutationFn: async (input: RegisterDiscordCommands) => {
      const current = client.getQueryData<InfiniteData<DiscordApplicationPage>>([
        QueryKeys.discordApps,
        principalKey,
      ]);
      if (
        !mounted.current ||
        input.manifestVersion !== DISCORD_COMMAND_MANIFEST_VERSION ||
        !current?.pages.some((page) =>
          page.applications.some(
            (app) =>
              app.applicationId === input.applicationId && app.revision === input.expectedRevision,
          ),
        )
      )
        throw Object.assign(new Error('Discord application changed'), {
          code: 'application_changed',
        });
      const result = await dataService.registerDiscordCommands(input);
      if (
        result.applicationId !== input.applicationId ||
        result.manifestVersion !== input.manifestVersion
      )
        throw new Error('Discord registration was not confirmed');
    },
  });
  const connect = useMutation({
    ...lifecycle,
    mutationKey: [MutationKeys.discordSetup, principalKey, 'connect'],
    mutationFn: (input: { applicationId: string; installationId?: string }) =>
      dataService.connectDiscordGuild(input.applicationId, input.installationId),
  });
  const cancel = useMutation({
    ...lifecycle,
    mutationKey: [MutationKeys.discordSetup, principalKey, 'cancel'],
    mutationFn: dataService.cancelDiscordInstall,
  });
  /** Tracked like a write: `busy` keeps every control disabled until the reads have refetched. */
  const reconcile = useMutation({
    mutationKey: [MutationKeys.discordSetup, principalKey, 'reconcile'],
    mutationFn: refresh,
  });
  const disconnect = useMutation({
    ...lifecycle,
    mutationKey: [MutationKeys.discordSetup, principalKey, 'disconnect'],
    mutationFn: (guild: DiscordGuild) =>
      dataService.disconnectDiscordGuild(guild.installationId, guild.revision),
    onSuccess: () => {
      if (mounted.current) setConfirm(null);
    },
  });
  const finish = useCallback(() => {
    clearTimeout(deadline.current);
    attempt.current?.popup.close();
    attempt.current = null;
    if (mounted.current) setFlow(null);
  }, [setFlow]);
  const retire = async (current: Attempt) => {
    current.cancelling = true;
    current.popup.close();
    clearTimeout(deadline.current);
    setFlow('cancelling');
    if (!current.flowId) return;
    try {
      await cancel.mutateAsync(current.flowId);
      if (mounted.current && attempt.current === current) finish();
    } catch (error) {
      if (!mounted.current || attempt.current !== current) return;
      if (error instanceof Error && 'code' in error && error.code === 'invalid_state') {
        finish();
        void refresh();
        return;
      }
      current.cancelling = false;
      setFlow('failed');
    }
  };
  useEffect(() => {
    mounted.current = true;
    const stop = watchOAuthSettlements((notice) => {
      if (!attempt.current?.flowId || notice.flowId !== attempt.current.flowId) return;
      finish();
      if (notice.outcome === 'failed') setFlow('failed');
      void refresh();
    });
    return () => {
      mounted.current = false;
      stop();
      clearTimeout(deadline.current);
      submission.current = null;
      const current = attempt.current;
      attempt.current = null;
      current?.popup.close();
      if (current?.flowId) void dataService.cancelDiscordInstall(current.flowId).catch(() => {});
    };
  }, [finish, refresh, setFlow]);
  const start = (applicationId: string, installationId?: string) => {
    if (attempt.current) return;
    connect.reset();
    cancel.reset();
    const popup = window.open('', '_blank');
    if (!popup) {
      setFlow('failed');
      return;
    }
    popup.opener = null;
    const current: Attempt = { popup, cancelling: false };
    attempt.current = current;
    setFlow('pending');
    connect.mutateAsync({ applicationId, installationId }).then(
      async (result) => {
        if (!mounted.current || attempt.current !== current) {
          popup.close();
          void dataService.cancelDiscordInstall(result.flowId).catch(() => {});
          return;
        }
        current.flowId = result.flowId;
        if (current.cancelling) {
          await retire(current);
          return;
        }
        let url: URL;
        try {
          url = new URL(result.url);
        } catch {
          await retire(current);
          if (mounted.current) setFlow('failed');
          return;
        }
        if (
          url.origin !== 'https://discord.com' ||
          url.pathname !== '/oauth2/authorize' ||
          url.searchParams.get('client_id') !== applicationId ||
          popup.closed
        ) {
          await retire(current);
          if (mounted.current) setFlow('failed');
          return;
        }
        deadline.current = setTimeout(() => {
          if (attempt.current !== current) return;
          finish();
          setFlow('failed');
          void dataService.cancelDiscordInstall(result.flowId).catch(() => {});
          void refresh();
        }, result.expiresInSeconds * 1000);
        try {
          popup.location.href = result.url;
        } catch {
          await retire(current);
          if (mounted.current) setFlow('failed');
        }
      },
      () => {
        popup.close();
        if (mounted.current && attempt.current === current) {
          attempt.current = null;
          setFlow('failed');
        }
      },
    );
  };
  const applications = apps.data?.pages.flatMap((page) => page.applications) ?? [];
  const installations = guilds.data?.pages.flatMap((page) => page.guilds) ?? [];
  const ready = apps.isSuccess && guilds.isSuccess && !apps.isFetching && !guilds.isFetching;
  const disabled = busy || !ready || flow !== null;
  const setup = apps.data?.pages[0].setup;
  const { setFocus } = form;
  useEffect(() => {
    if (editor) setFocus(editor === 'new' ? 'applicationId' : 'botToken');
  }, [editor, setFocus]);
  useEffect(() => {
    if (!restoreEditorFocus.current || editor || busy) return;
    if (ready) {
      const trigger = editorTrigger.current;
      if (trigger?.isConnected && !trigger.disabled) trigger.focus();
      else appsHeading.current?.focus();
      restoreEditorFocus.current = false;
    } else if (apps.isError || guilds.isError) {
      const failure = loadFailure.current;
      if (failure && !failure.contains(document.activeElement)) failure.focus();
    }
  }, [editor, ready, busy, apps.isError, guilds.isError]);
  const edit = (app: DiscordApplication | 'new', trigger: HTMLButtonElement) => {
    editorTrigger.current = trigger;
    save.reset();
    form.reset(
      app === 'new' ? empty : { ...empty, applicationId: app.applicationId, name: app.name ?? '' },
    );
    setEditor(app);
  };
  const submit = form.handleSubmit((fields) => {
    const parsed = configureDiscordApplicationSchema.safeParse({
      applicationId: fields.applicationId.trim(),
      name: fields.name.trim(),
      ...(fields.botToken.trim() ? { botToken: fields.botToken.trim() } : {}),
      ...(fields.clientSecret.trim() ? { clientSecret: fields.clientSecret.trim() } : {}),
      ...(editor && editor !== 'new' ? { expectedRevision: editor.revision } : {}),
    });
    if (!parsed.success) {
      form.setError('root', { message: localize('com_ui_discord_invalid') });
      return;
    }
    submission.current = parsed.data;
    form.resetField('botToken');
    form.resetField('clientSecret');
    save.mutate();
  });
  const mutationError = save.error || connect.error || cancel.error;
  const commandAppId = commands.variables?.applicationId;
  const retry = () => {
    if (apps.isError)
      void (failedNextPage.current.apps ? apps.fetchNextPage() : apps.refetch()).then((result) => {
        failedNextPage.current.apps = result.isError && failedNextPage.current.apps;
      });
    if (guilds.isError)
      void (failedNextPage.current.guilds ? guilds.fetchNextPage() : guilds.refetch()).then(
        (result) => {
          failedNextPage.current.guilds = result.isError && failedNextPage.current.guilds;
        },
      );
  };
  return (
    <div className="space-y-4">
      {showDescription && (
        <p className="text-text-secondary text-sm">{localize('com_ui_discord_description')}</p>
      )}
      {(apps.isLoading || guilds.isLoading) && (
        <p role="status">
          <Spinner className="size-4" />
          {localize('com_ui_channels_loading')}
        </p>
      )}
      {(apps.isError || guilds.isError) && (
        <Alert ref={loadFailure} tabIndex={-1} variant="error">
          {localize(errorLabel(apps.error || guilds.error))}
          <Button type="button" variant="outline" onClick={retry}>
            {localize('com_ui_retry')}
          </Button>
        </Alert>
      )}
      {Boolean(mutationError) && (
        <Alert ref={reveal} tabIndex={-1} variant="error">
          {localize(errorLabel(mutationError))}
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              form.reset(empty);
              restoreEditorFocus.current = editor !== null;
              setEditor(null);
              save.reset();
              connect.reset();
              cancel.reset();
              reconcile.mutate();
            }}
          >
            {localize('com_ui_refresh')}
          </Button>
        </Alert>
      )}
      {save.isSuccess && <p role="status">{localize('com_ui_discord_saved')}</p>}
      {flow && (
        <Alert
          ref={flow === 'failed' ? reveal : undefined}
          tabIndex={flow === 'failed' ? -1 : undefined}
          variant={flow === 'failed' ? 'warning' : 'info'}
        >
          <p>
            {localize(flow === 'failed' ? 'com_ui_discord_unconfirmed' : 'com_ui_discord_pending')}
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={flow === 'cancelling'}
            onClick={() => (attempt.current ? void retire(attempt.current) : finish())}
          >
            {localize('com_ui_cancel')}
          </Button>
        </Alert>
      )}
      {setup?.oauthCallbackUrl && (
        <div>
          <Label htmlFor={`${id}-callback`}>{localize('com_ui_discord_callback')}</Label>
          <Input id={`${id}-callback`} readOnly value={setup.oauthCallbackUrl} />
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <h3 ref={appsHeading} tabIndex={-1} className="text-sm font-semibold">
          {localize('com_ui_discord_apps')}
        </h3>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={(event) => edit('new', event.currentTarget)}
        >
          {localize('com_ui_discord_app_create')}
        </Button>
      </div>
      {ready && !applications.length && (
        <p className="text-text-secondary text-sm">{localize('com_ui_discord_empty')}</p>
      )}
      {editor && (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.stopPropagation();
            void submit(event);
          }}
        >
          <p className="text-text-secondary text-sm">
            {localize(editor === 'new' ? 'com_ui_discord_credentials' : 'com_ui_discord_rotation')}
          </p>
          {(['applicationId', 'name', 'botToken', 'clientSecret'] as const).map((field) => {
            const secret = field === 'botToken' || field === 'clientSecret';
            const labels = {
              applicationId: 'com_ui_discord_application_id',
              name: 'com_ui_name',
              botToken: 'com_ui_discord_bot_token',
              clientSecret: 'com_ui_discord_client_secret',
            } as const;
            return (
              <div key={field}>
                <Label htmlFor={`${id}-${field}`}>{localize(labels[field])}</Label>
                <Input
                  id={`${id}-${field}`}
                  type={secret ? 'password' : 'text'}
                  autoComplete={secret ? 'new-password' : 'off'}
                  readOnly={field === 'applicationId' && editor !== 'new'}
                  disabled={disabled}
                  aria-invalid={Boolean(form.formState.errors[field])}
                  aria-describedby={
                    form.formState.errors[field] ? `${id}-${field}-error` : undefined
                  }
                  {...form.register(field, {
                    required: field === 'applicationId' || (secret && editor === 'new'),
                    maxLength: { applicationId: 20, name: 100, botToken: 512, clientSecret: 512 }[
                      field
                    ],
                    ...(field === 'applicationId'
                      ? {
                          validate: (value) =>
                            channelSnowflakeSchema.safeParse(value.trim()).success,
                        }
                      : {}),
                  })}
                />
                {form.formState.errors[field] && (
                  <p
                    id={`${id}-${field}-error`}
                    role="alert"
                    className="text-text-destructive text-sm"
                  >
                    {localize('com_ui_discord_invalid')}
                  </p>
                )}
              </div>
            );
          })}
          {form.formState.errors.root && (
            <Alert variant="error">{form.formState.errors.root.message}</Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                form.reset(empty);
                restoreEditorFocus.current = true;
                setEditor(null);
              }}
            >
              {localize('com_ui_cancel')}
            </Button>
            <Button type="submit" variant="submit" disabled={disabled}>
              {localize('com_ui_save')}
            </Button>
          </div>
        </form>
      )}
      <ul className="space-y-3">
        {applications.map((app) => (
          <li
            key={app.applicationId}
            className="border-border-light space-y-2 rounded-lg border p-3"
          >
            <p className="text-sm font-medium">{app.name || app.applicationId}</p>
            <p className="text-text-secondary text-xs break-all">{app.applicationId}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={disabled}
                aria-label={localize('com_ui_discord_rotate_named', {
                  0: app.name || app.applicationId,
                })}
                onClick={(event) => edit(app, event.currentTarget)}
              >
                {localize('com_ui_discord_app_rotate')}
              </Button>
              <Button
                type="button"
                disabled={disabled}
                aria-label={localize('com_ui_discord_connect_named', {
                  0: app.name || app.applicationId,
                })}
                onClick={() => start(app.applicationId)}
              >
                {localize('com_ui_discord_connect')}
              </Button>
            </div>
            <div className="space-y-2">
              <Button
                type="button"
                variant="submit"
                disabled={disabled || (commands.isError && commandAppId === app.applicationId)}
                aria-label={localize('com_ui_discord_commands_named', {
                  0: app.name || app.applicationId,
                })}
                aria-busy={commandAppId === app.applicationId && commands.isLoading}
                onClick={() =>
                  commands.mutate({
                    applicationId: app.applicationId,
                    expectedRevision: app.revision,
                    manifestVersion: DISCORD_COMMAND_MANIFEST_VERSION,
                  })
                }
              >
                {localize(
                  commandAppId === app.applicationId && commands.isLoading
                    ? 'com_ui_discord_commands_registering'
                    : 'com_ui_discord_commands_register',
                )}
              </Button>
              <p className="text-text-secondary text-xs">
                {localize('com_ui_discord_commands_help')}
              </p>
              {commands.isSuccess &&
                commandAppId === app.applicationId &&
                commands.variables?.expectedRevision === app.revision && (
                  <p role="status">{localize('com_ui_discord_commands_success')}</p>
                )}
              {commandAppId === app.applicationId && commands.isError && (
                <Alert ref={reveal} tabIndex={-1} variant="error">
                  <p>{localize(errorLabel(commands.error))}</p>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      commands.reset();
                      void refresh();
                    }}
                  >
                    {localize('com_ui_refresh')}
                  </Button>
                </Alert>
              )}
            </div>
            {setup?.interactionBaseUrl ? (
              <div>
                <Label htmlFor={`${id}-ingress-${app.applicationId}`}>
                  {localize('com_ui_discord_interactions')}
                </Label>
                <Input
                  id={`${id}-ingress-${app.applicationId}`}
                  readOnly
                  value={`${setup.interactionBaseUrl}${encodeURIComponent(app.applicationId)}/interactions`}
                />
              </div>
            ) : (
              <p className="text-text-secondary text-xs">
                {localize('com_ui_discord_ingress_required')}
              </p>
            )}
          </li>
        ))}
      </ul>
      {apps.hasNextPage && (
        <Button
          type="button"
          variant="outline"
          disabled={disabled || apps.isFetchingNextPage}
          onClick={() => {
            failedNextPage.current.apps = true;
            void apps.fetchNextPage().then((result) => {
              failedNextPage.current.apps = result.isError;
            });
          }}
        >
          {localize('com_ui_discord_more_apps')}
        </Button>
      )}
      <h3 ref={guildHeading} tabIndex={-1} className="text-sm font-semibold">
        {localize('com_ui_discord_guilds')}
      </h3>
      {ready && !installations.length && (
        <p className="text-text-secondary text-sm">{localize('com_ui_discord_guilds_empty')}</p>
      )}
      <ul className="space-y-3">
        {installations.map((guild) => (
          <li
            key={guild.installationId}
            className="border-border-light space-y-2 rounded-lg border p-3"
          >
            <p className="text-sm font-medium">{guild.guildName}</p>
            <p role="status" className="text-text-secondary text-xs">
              {localize(
                guild.status === 'active'
                  ? 'com_ui_discord_connected'
                  : 'com_ui_discord_disconnected',
              )}
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={disabled}
                aria-label={localize('com_ui_discord_reconnect_named', { 0: guild.guildName })}
                onClick={() => start(guild.applicationId, guild.installationId)}
              >
                {localize('com_ui_discord_reconnect')}
              </Button>
              {guild.status === 'active' && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={disabled}
                  aria-label={localize('com_ui_discord_disconnect_named', { 0: guild.guildName })}
                  onClick={(event) => {
                    disconnectTrigger.current = event.currentTarget;
                    disconnect.reset();
                    setConfirm(guild);
                  }}
                >
                  {localize('com_ui_discord_disconnect')}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {guilds.hasNextPage && (
        <Button
          type="button"
          variant="outline"
          disabled={disabled || guilds.isFetchingNextPage}
          onClick={() => {
            failedNextPage.current.guilds = true;
            void guilds.fetchNextPage().then((result) => {
              failedNextPage.current.guilds = result.isError;
            });
          }}
        >
          {localize('com_ui_discord_more_guilds')}
        </Button>
      )}
      <Button asChild variant="link">
        <a
          href="https://discord.com/developers/applications"
          target="_blank"
          rel="noopener noreferrer"
        >
          {localize('com_ui_discord_developer_portal')}
        </a>
      </Button>
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !disconnect.isLoading) setConfirm(null);
        }}
      >
        <AlertDialogContent
          className="w-11/12 max-w-md"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const trigger = disconnectTrigger.current;
            if (trigger?.isConnected && !trigger.disabled) trigger.focus();
            else guildHeading.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{localize('com_ui_discord_disconnect')}</AlertDialogTitle>
            <AlertDialogDescription>
              {localize('com_ui_discord_disconnect_confirm')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {disconnect.isError && (
            <Alert variant="error">{localize(errorLabel(disconnect.error))}</Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnect.isLoading}>
              {localize('com_ui_cancel')}
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                type="button"
                variant="destructive"
                disabled={disconnect.isLoading || !ready}
                onClick={(event) => {
                  event.preventDefault();
                  if (confirm) disconnect.mutate(confirm);
                }}
              >
                {localize('com_ui_discord_disconnect')}
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

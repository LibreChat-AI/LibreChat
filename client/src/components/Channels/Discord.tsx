import { useCallback, useEffect, useId, useRef } from 'react';
import { Pencil } from 'lucide-react';
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
  discordCredentialHealthSchema,
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
  IconButton,
  TooltipAnchor,
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
  DiscordOAuthErrorCode,
  DiscordCredentialState,
  DiscordApplication,
  DiscordGuild,
} from 'librechat-data-provider';
import type { InfiniteData } from '@tanstack/react-query';
import type { TranslationKeys } from '~/hooks';
import { watchOAuthSettlements } from '~/data-provider/PullRequest/signIn';
import { discordCallbackLabels } from '~/components/OAuth/discord';
import { settingsTargetAtom } from '~/components/Nav/Settings';
import { useAuthContext, useLocalize } from '~/hooks';
import Dm from './Dm';

const editorAtom = atom<DiscordApplication | 'new' | null>(null);
const confirmAtom = atom<DiscordGuild | null>(null);
const flowAtom = atom<'pending' | 'cancelling' | 'failed' | null>(null);
const openAtom = atom(false);
/** Why the callback failed, when its notice named an approved code; it explains the failed notice and nothing else. */
const reasonAtom = atom<DiscordOAuthErrorCode | null>(null);
/** Set when a dismissal removes the control the user was on; focus returns to `trigger` once the reads settle. */
const restoreAtom = atom<{ trigger: HTMLButtonElement | null; servers?: boolean } | null>(null);
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

const controls =
  'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';

/** Whether the user put focus on a control of their own, which a waiting restore must not take back. */
function movedOn(trigger: HTMLButtonElement | null): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== trigger && active.matches(controls);
}

/** The last bot-token observation, or null when it is absent, legacy or malformed. */
function observation(
  app: DiscordApplication,
): { state: DiscordCredentialState; checked: Date } | null {
  const health = discordCredentialHealthSchema.safeParse(app.credentialHealth);
  if (!health.success) return null;
  const checked = new Date(health.data.checkedAt);
  return Number.isNaN(checked.getTime()) ? null : { state: health.data.state, checked };
}

/** An absolute server time, never aged against the browser clock. */
function CredentialHealth({ app }: { app: DiscordApplication }) {
  const localize = useLocalize();
  const health = observation(app);
  let key: TranslationKeys = 'com_ui_discord_health_unknown';
  if (health) {
    key =
      health.state === 'valid' ? 'com_ui_discord_health_valid' : 'com_ui_discord_health_invalid';
  }
  return (
    <div className="space-y-0.5 text-xs">
      <p
        role="status"
        className={health?.state === 'invalid' ? 'text-text-destructive' : 'text-text-secondary'}
      >
        {localize(key)}
      </p>
      {health && (
        <p className="text-text-secondary">
          {localize('com_ui_discord_health_checked')}{' '}
          <time dateTime={health.checked.toISOString()}>{health.checked.toLocaleString()}</time>
        </p>
      )}
    </div>
  );
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
  const [target, setTarget] = useAtom(settingsTargetAtom);
  const autoOpen = target?.entry === 'discordApps';
  return user ? (
    <Provider key={JSON.stringify([user.tenantId, user.id])}>
      <SettingsControl
        userId={user.id}
        tenantId={user.tenantId}
        autoOpen={autoOpen}
        onAutoOpened={() => setTarget(null)}
      />
    </Provider>
  ) : null;
}
function SettingsControl({
  autoOpen,
  onAutoOpened,
  ...props
}: {
  userId: string;
  tenantId?: string;
  autoOpen: boolean;
  onAutoOpened: () => void;
}) {
  const localize = useLocalize();
  const rowId = useId();
  const [open, setOpen] = useAtom(openAtom);
  useEffect(() => {
    if (!autoOpen) return;
    setOpen(true);
    onAutoOpened();
  }, [autoOpen, onAutoOpened, setOpen]);
  return (
    <OGDialog open={open} onOpenChange={setOpen}>
      <section aria-labelledby={`${rowId}-title`} className="flex items-center gap-3">
        <span
          className="border-border-light bg-surface-secondary flex size-10 shrink-0 items-center justify-center rounded-lg border"
          aria-hidden="true"
        >
          <DiscordIcon mark className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id={`${rowId}-title`} className="text-text-primary text-sm font-medium">
            {localize('com_ui_discord_title')}
          </h3>
          <p className="text-text-secondary mt-0.5 text-xs">
            {localize('com_ui_discord_row_description')}
          </p>
        </div>
        <OGDialogTrigger asChild>
          <Button type="button" variant="outline">
            {localize('com_ui_manage')}
          </Button>
        </OGDialogTrigger>
      </section>
      <OGDialogTemplate
        title={localize('com_ui_discord_title')}
        description={localize('com_ui_discord_description')}
        className="max-w-2xl"
        mainClassName="max-h-[70dvh] overflow-y-auto"
        showCloseButton
        showCancelButton={false}
        main={
          open ? (
            <div className="space-y-6">
              <Discord {...props} showDescription={false} />
              <div className="border-border-light border-t pt-6">
                <Dm principalKey={JSON.stringify([props.tenantId ?? '_', props.userId])} />
              </div>
            </div>
          ) : null
        }
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
  const [editor, setEditor] = useAtom(editorAtom);
  const [confirm, setConfirm] = useAtom(confirmAtom);
  const [flow, setFlow] = useAtom(flowAtom);
  const [reason, setReason] = useAtom(reasonAtom);
  const [restore, setRestore] = useAtom(restoreAtom);
  const attempt = useRef<Attempt | null>(null);
  const submission = useRef<ConfigureDiscordApplication | null>(null);
  const mounted = useRef(true);
  const deadline = useRef<ReturnType<typeof setTimeout>>();
  const editorTrigger = useRef<HTMLButtonElement | null>(null);
  const commandTrigger = useRef<HTMLButtonElement | null>(null);
  const connectTrigger = useRef<HTMLButtonElement | null>(null);
  const flowAlert = useRef<HTMLDivElement | null>(null);
  const disconnectTrigger = useRef<HTMLButtonElement | null>(null);
  const guildHeading = useRef<HTMLHeadingElement | null>(null);
  const appsHeading = useRef<HTMLHeadingElement | null>(null);
  const loadFailure = useRef<HTMLDivElement | null>(null);
  const readHint = useRef<HTMLDivElement | null>(null);
  const cancelButton = useRef<HTMLButtonElement | null>(null);
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
  const revealCommand = useCallback(
    (node: HTMLDivElement | null) => {
      const details = node?.closest('details');
      if (details) details.open = true;
      reveal(node);
    },
    [reveal],
  );
  const revealFlow = useCallback(
    (node: HTMLDivElement | null) => {
      flowAlert.current = node;
      reveal(node);
    },
    [reveal],
  );
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
        setRestore({ trigger: editorTrigger.current });
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
    if (mounted.current) {
      setFlow(null);
      setReason(null);
    }
  }, [setFlow, setReason]);
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
        reconcile.mutate();
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
      if (notice.outcome === 'failed') {
        setReason(notice.errorCode ?? null);
        setFlow('failed');
      }
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
  }, [finish, refresh, setFlow, setReason]);
  const start = (
    applicationId: string,
    installationId: string | undefined,
    trigger: HTMLButtonElement,
  ) => {
    if (attempt.current) return;
    connectTrigger.current = trigger;
    connect.reset();
    cancel.reset();
    setReason(null);
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
  const confirmed = confirm
    ? installations.find((item) => item.installationId === confirm.installationId)
    : undefined;
  /** The reads behind a failure are current, so only the record the user confirmed can be retried. */
  const stale =
    confirm !== null &&
    disconnect.isError &&
    ready &&
    !(confirmed?.status === 'active' && confirmed.revision === confirm.revision);
  const { setFocus } = form;
  useEffect(() => {
    if (editor) setFocus(editor === 'new' ? 'applicationId' : 'botToken');
  }, [editor, setFocus]);
  useEffect(() => {
    if (!restore || editor || busy || flow) return;
    const { trigger, servers } = restore;
    if (ready) {
      if (!movedOn(trigger)) {
        if (trigger?.isConnected && !trigger.disabled) trigger.focus();
        else (servers ? guildHeading : appsHeading).current?.focus();
      }
      setRestore(null);
    } else if (apps.isError || guilds.isError) {
      /** Behind an open confirmation the page-level error is unreachable: its hint is the visible one. */
      const failure = (confirm ? readHint : loadFailure).current;
      if (failure && !failure.contains(document.activeElement) && !movedOn(trigger))
        failure.focus();
    }
  }, [restore, setRestore, confirm, editor, ready, busy, flow, apps.isError, guilds.isError]);
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
  /** A failed next page is retried alone; a failed reread, even right after one, is read again. The query
   * records how its last fetch started and every later fetch replaces that, so nothing here can go stale. */
  const failedNextPage = (key: readonly unknown[]) =>
    client.getQueryState(key)?.fetchMeta?.fetchMore?.direction === 'forward';
  const retry = (target: HTMLButtonElement | null = null) => {
    setRestore((current) => current ?? { trigger: target });
    if (apps.isError) {
      void (failedNextPage([QueryKeys.discordApps, principalKey])
        ? apps.fetchNextPage()
        : apps.refetch());
    }
    if (guilds.isError) {
      void (failedNextPage([QueryKeys.discordGuilds, principalKey])
        ? guilds.fetchNextPage()
        : guilds.refetch());
    }
  };
  // Server management is admin-only; everyone else sees just their own Discord settings.
  const forbidden = [apps.error, guilds.error].some(
    (error) =>
      typeof error === 'object' && error !== null && 'status' in error && error.status === 403,
  );
  if (forbidden) return null;
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
          <Button type="button" variant="outline" onClick={() => retry()}>
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
              setRestore({
                trigger:
                  editor !== null || save.error ? editorTrigger.current : connectTrigger.current,
              });
              setEditor(null);
              save.reset();
              connect.reset();
              cancel.reset();
              reconcile.mutate();
              flowAlert.current?.focus();
            }}
          >
            {localize('com_ui_refresh')}
          </Button>
        </Alert>
      )}
      {save.isSuccess && <p role="status">{localize('com_ui_discord_saved')}</p>}
      {flow && (
        <Alert
          ref={flow === 'failed' ? revealFlow : undefined}
          tabIndex={flow === 'failed' ? -1 : undefined}
          variant={flow === 'failed' ? 'warning' : 'info'}
        >
          {flow === 'failed' && reason && <p>{localize(discordCallbackLabels[reason])}</p>}
          <p>
            {localize(flow === 'failed' ? 'com_ui_discord_unconfirmed' : 'com_ui_discord_pending')}
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={flow === 'cancelling'}
            onClick={() => {
              setRestore({ trigger: connectTrigger.current });
              if (attempt.current) void retire(attempt.current);
              else finish();
            }}
          >
            {localize('com_ui_cancel')}
          </Button>
        </Alert>
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
          {editor === 'new' && setup?.oauthCallbackUrl && (
            <div>
              <Label htmlFor={`${id}-callback`}>{localize('com_ui_discord_callback')}</Label>
              <Input id={`${id}-callback`} readOnly value={setup.oauthCallbackUrl} />
            </div>
          )}
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
                setRestore({ trigger: editorTrigger.current });
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
            <div className="flex items-center justify-between gap-2">
              <p className="min-w-0 truncate text-sm font-medium">
                {app.name || app.applicationId}
              </p>
              <TooltipAnchor
                description={localize('com_ui_discord_app_rotate')}
                render={
                  <IconButton
                    label={localize('com_ui_discord_rotate_named', {
                      0: app.name || app.applicationId,
                    })}
                    variant="ghost"
                    size="sm"
                    shape="control"
                    disabled={disabled}
                    onClick={(event) => edit(app, event.currentTarget)}
                  >
                    <Pencil className="size-4" aria-hidden="true" />
                  </IconButton>
                }
              />
            </div>
            <CredentialHealth app={app} />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={disabled}
                aria-label={localize('com_ui_discord_connect_named', {
                  0: app.name || app.applicationId,
                })}
                onClick={(event) => start(app.applicationId, undefined, event.currentTarget)}
              >
                {localize('com_ui_discord_connect')}
              </Button>
            </div>
            <details className="group border-border-light border-t pt-2">
              <summary className="text-text-secondary cursor-pointer text-sm">
                {localize('com_ui_discord_setup_details')}
              </summary>
              <div className="mt-3 space-y-3">
                {app.name && (
                  <p className="text-text-secondary text-xs break-all">
                    {localize('com_ui_discord_application_id')}: {app.applicationId}
                  </p>
                )}
                <p className="text-text-secondary text-xs">
                  {localize('com_ui_discord_health_help')}
                </p>
                {setup?.oauthCallbackUrl && (
                  <div>
                    <Label htmlFor={`${id}-callback-${app.applicationId}`}>
                      {localize('com_ui_discord_callback')}
                    </Label>
                    <Input
                      id={`${id}-callback-${app.applicationId}`}
                      readOnly
                      value={setup.oauthCallbackUrl}
                    />
                  </div>
                )}
                <div className="space-y-2">
                  <Button
                    type="button"
                    variant="submit"
                    disabled={disabled || (commands.isError && commandAppId === app.applicationId)}
                    aria-label={localize('com_ui_discord_commands_named', {
                      0: app.name || app.applicationId,
                    })}
                    aria-busy={commandAppId === app.applicationId && commands.isLoading}
                    onClick={(event) => {
                      commandTrigger.current = event.currentTarget;
                      commands.mutate({
                        applicationId: app.applicationId,
                        expectedRevision: app.revision,
                        manifestVersion: DISCORD_COMMAND_MANIFEST_VERSION,
                      });
                    }}
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
                    <Alert ref={revealCommand} tabIndex={-1} variant="error">
                      <p>{localize(errorLabel(commands.error))}</p>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          setRestore({ trigger: commandTrigger.current });
                          commands.reset();
                          reconcile.mutate();
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
              </div>
            </details>
          </li>
        ))}
      </ul>
      {apps.hasNextPage && (
        <Button
          type="button"
          variant="outline"
          disabled={disabled || apps.isFetchingNextPage}
          onClick={(event) => {
            setRestore({ trigger: event.currentTarget });
            void apps.fetchNextPage();
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
                onClick={(event) =>
                  start(guild.applicationId, guild.installationId, event.currentTarget)
                }
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
          onClick={(event) => {
            setRestore({ trigger: event.currentTarget, servers: true });
            void guilds.fetchNextPage();
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
            if (mounted.current) setRestore({ trigger: disconnectTrigger.current, servers: true });
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{localize('com_ui_discord_disconnect')}</AlertDialogTitle>
            <AlertDialogDescription>
              {localize('com_ui_discord_disconnect_confirm')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {disconnect.isError && (
            <Alert ref={reveal} tabIndex={-1} variant={stale ? 'warning' : 'error'}>
              {localize(stale ? 'com_ui_discord_disconnect_stale' : errorLabel(disconnect.error))}
            </Alert>
          )}
          {confirm !== null && (apps.isError || guilds.isError) && (
            <Alert ref={readHint} tabIndex={-1} variant="warning">
              <p>{localize('com_ui_discord_disconnect_unread')}</p>
              <Button type="button" variant="outline" onClick={() => retry(cancelButton.current)}>
                {localize('com_ui_retry')}
              </Button>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel ref={cancelButton} disabled={disconnect.isLoading}>
              {localize('com_ui_cancel')}
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                type="button"
                variant="destructive"
                disabled={disconnect.isLoading || !ready || stale}
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

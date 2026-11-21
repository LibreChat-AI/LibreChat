import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
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
  OGDialog,
  OGDialogTemplate,
  OGDialogTrigger,
} from '@librechat/client';
import type {
  ConfigureDiscordApplication,
  DiscordApplicationPage,
  RegisterDiscordCommands,
  DiscordOAuthErrorCode,
  DiscordApplication,
  DiscordGuild,
} from 'librechat-data-provider';
import type { InfiniteData } from '@tanstack/react-query';
import type { Fields } from './discord/Credentials';
import type { WizardStep } from './discord/Wizard';
import { watchOAuthSettlements } from '~/data-provider/PullRequest/signIn';
import { settingsTargetAtom } from '~/components/Nav/Settings';
import { useAuthContext, useLocalize } from '~/hooks';
import { empty } from './discord/Credentials';
import { errorLabel } from './discord/errors';
import Settings from './discord/Settings';
import Connect from './discord/Connect';
import Editor from './discord/Editor';
import Wizard from './discord/Wizard';
import Server from './discord/Server';
import Card from './discord/Card';
import Loading from './Loading';
import Notice from './Notice';
import Dm from './Dm';

const editorAtom = atom<DiscordApplication | 'new' | null>(null);
const confirmAtom = atom<DiscordGuild | null>(null);
const flowAtom = atom<'pending' | 'cancelling' | 'failed' | null>(null);
const openAtom = atom(false);
/** The application whose connection settings are open. */
const settingsAtom = atom<string | null>(null);
/** Why the callback failed, when its notice named an approved code; it explains the failed notice and nothing else. */
const reasonAtom = atom<DiscordOAuthErrorCode | null>(null);
/** Set when a dismissal removes the control the user was on; focus returns to `trigger` once the reads settle. */
const restoreAtom = atom<{ trigger: HTMLButtonElement | null; servers?: boolean } | null>(null);
type Attempt = { popup: Window; flowId?: string; cancelling: boolean };

const controls =
  'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';

/** Whether the user put focus on a control of their own, which a waiting restore must not take back. */
function movedOn(trigger: HTMLButtonElement | null): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== trigger && active.matches(controls);
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
        title={localize('com_ui_discord_manage_title')}
        className="max-w-2xl"
        mainClassName="max-h-[70dvh] overflow-y-auto"
        showCancelButton={false}
        showCloseButton
        footerClassName="hidden"
        main={
          open ? (
            <div className="space-y-6">
              <Discord {...props} showDescription={false} />
              <Dm principalKey={JSON.stringify([props.tenantId ?? '_', props.userId])} />
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
  const client = useQueryClient();
  const [editor, setEditor] = useAtom(editorAtom);
  const [confirm, setConfirm] = useAtom(confirmAtom);
  const [flow, setFlow] = useAtom(flowAtom);
  const [reason, setReason] = useAtom(reasonAtom);
  const [settings, setSettings] = useAtom(settingsAtom);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [restore, setRestore] = useAtom(restoreAtom);
  /** Held from the first-run save until the person finishes, so the new application does not replace it. */
  const [wizard, setWizard] = useState<{ step: WizardStep; applicationId?: string } | null>(null);
  const attempt = useRef<Attempt | null>(null);
  const submission = useRef<ConfigureDiscordApplication | null>(null);
  const mounted = useRef(true);
  const deadline = useRef<ReturnType<typeof setTimeout>>();
  const editorTrigger = useRef<HTMLButtonElement | null>(null);
  const commandTrigger = useRef<HTMLButtonElement | null>(null);
  const settingsTrigger = useRef<HTMLButtonElement | null>(null);
  const connectTrigger = useRef<HTMLButtonElement | null>(null);
  const lastStart = useRef<{ applicationId: string; installationId?: string } | null>(null);
  const flowAlert = useRef<HTMLDivElement | null>(null);
  const disconnectTrigger = useRef<HTMLButtonElement | null>(null);
  const guildHeading = useRef<HTMLHeadingElement | null>(null);
  const appsHeading = useRef<HTMLHeadingElement | null>(null);
  const loadFailure = useRef<HTMLDivElement | null>(null);
  const readHint = useRef<HTMLDivElement | null>(null);
  const settingsFailure = useRef<HTMLDivElement | null>(null);
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
    onSuccess: (saved) => {
      if (!mounted.current) return;
      form.reset(empty);
      if (editor === null) {
        setWizard({ step: 3, applicationId: saved.applicationId });
        return;
      }
      setRestore({ trigger: editorTrigger.current });
      setEditor(null);
    },
  });
  const commands = useMutation({
    ...lifecycle,
    /** A failure answers an action inside the settings, so it is shown there even if they were closed meanwhile. */
    onError: async (_error, input) => {
      await cancelReads();
      if (mounted.current) setSettings(input.applicationId);
    },
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
    lastStart.current = { applicationId, installationId };
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
  const listed = apps.isSuccess && guilds.isSuccess;
  const ready = listed && !apps.isFetching && !guilds.isFetching;
  const disabled = busy || !ready || flow !== null;
  const showWizard = listed && (wizard !== null || !applications.length);
  const setup = apps.data?.pages[0].setup;
  const settingsApp = settings
    ? applications.find((app) => app.applicationId === settings)
    : undefined;
  const settingsOpen = settingsApp !== undefined;
  const confirmed = confirm
    ? installations.find((item) => item.installationId === confirm.installationId)
    : undefined;
  /** The reads behind a failure are current, so only the record the user confirmed can be retried. */
  const stale =
    confirm !== null &&
    disconnect.isError &&
    ready &&
    !(confirmed?.status === 'active' && confirmed.revision === confirm.revision);
  useEffect(() => {
    if (!restore || editor || busy || flow) return;
    const { trigger, servers } = restore;
    /** A dialog that just closed still traps focus for this commit; focus moves once it has unmounted. */
    const timer = setTimeout(() => {
      if (ready) {
        if (!movedOn(trigger)) {
          if (trigger?.isConnected && !trigger.disabled) trigger.focus();
          else (servers ? guildHeading : appsHeading).current?.focus();
        }
        setRestore(null);
      } else if (apps.isError || guilds.isError) {
        /** Behind an open confirmation the page-level error is unreachable: its hint is the visible one. */
        let failure = loadFailure.current;
        if (settingsOpen) failure = settingsFailure.current;
        if (confirm) failure = readHint.current;
        if (failure && !failure.contains(document.activeElement) && !movedOn(trigger))
          failure.focus();
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [
    restore,
    setRestore,
    confirm,
    editor,
    ready,
    busy,
    flow,
    settingsOpen,
    apps.isError,
    guilds.isError,
  ]);
  useEffect(() => {
    if (settings && ready && !settingsApp) setSettings(null);
  }, [settings, settingsApp, ready, setSettings]);
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
      applicationId:
        editor && editor !== 'new' ? editor.applicationId : fields.applicationId.trim(),
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
  const linkError = connect.error || cancel.error;
  /** A failure is shown beside the action that caused it: inside its dialog while open, else on the page. */
  const pageError = (editor || showWizard ? null : save.error) || (flow ? null : linkError);
  const refreshAfterError = () => {
    form.reset(empty);
    setRestore({
      trigger: editor !== null || save.error ? editorTrigger.current : connectTrigger.current,
    });
    setEditor(null);
    save.reset();
    connect.reset();
    cancel.reset();
    reconcile.mutate();
    flowAlert.current?.focus();
  };
  const cancelAttempt = () => {
    setRestore({ trigger: connectTrigger.current });
    if (attempt.current) void retire(attempt.current);
    else finish();
  };
  const connectAgain = () => {
    const last = lastStart.current;
    const trigger = connectTrigger.current;
    if (!last || !trigger) return;
    finish();
    start(last.applicationId, last.installationId, trigger);
  };
  const commandRef = useCallback((node: HTMLButtonElement | null) => {
    commandTrigger.current = node;
  }, []);
  const commandFailed = settings !== null && commandAppId === settings && commands.isError;
  const known = new Set(applications.map((app) => app.applicationId));
  const orphans = installations.filter((guild) => !known.has(guild.applicationId));
  const reconnect = (guild: DiscordGuild, trigger: HTMLButtonElement) =>
    start(guild.applicationId, guild.installationId, trigger);
  const disconnectGuild = (guild: DiscordGuild, trigger: HTMLButtonElement) => {
    disconnectTrigger.current = trigger;
    disconnect.reset();
    setConfirm(guild);
  };
  if (forbidden) return null;
  return (
    <div className="space-y-4">
      {showDescription && (
        <p className="text-text-secondary text-sm">{localize('com_ui_discord_description')}</p>
      )}
      {(apps.isLoading || guilds.isLoading) && <Loading />}
      {(apps.isError || guilds.isError) && !settingsOpen && (
        <Notice
          ref={loadFailure}
          message={localize(errorLabel(apps.error || guilds.error))}
          action={localize('com_ui_retry')}
          onAction={() => retry()}
        />
      )}
      {Boolean(pageError) && (
        <Notice
          ref={reveal}
          message={localize(errorLabel(pageError))}
          action={localize('com_ui_refresh')}
          disabled={busy}
          onAction={refreshAfterError}
        />
      )}
      {save.isSuccess && !showWizard && (
        <Alert variant="success" role="status">
          {localize('com_ui_discord_saved')}
        </Alert>
      )}
      <h3 ref={appsHeading} tabIndex={-1} className="sr-only">
        {localize('com_ui_discord_apps')}
      </h3>
      {/* Loaded state, not "not fetching": a focus refetch must not swap the layout. */}
      {showWizard ? (
        <Wizard
          step={wizard?.step ?? 1}
          form={form}
          disabled={disabled}
          busy={busy}
          saving={save.isLoading}
          error={save.error}
          alertRef={reveal}
          onStep={(step) => {
            save.reset();
            setWizard({ step, applicationId: wizard?.applicationId });
          }}
          onSubmit={(event) => void submit(event)}
          onConnect={(trigger) => {
            if (wizard?.applicationId) start(wizard.applicationId, undefined, trigger);
          }}
          onFinish={() => {
            setWizard(null);
            setRestore({ trigger: null });
          }}
          onRefresh={refreshAfterError}
        />
      ) : (
        listed && (
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={(event) => edit('new', event.currentTarget)}
            >
              <Plus className="size-4" aria-hidden="true" />
              {localize('com_ui_discord_app_create')}
            </Button>
          </div>
        )
      )}
      <h3 ref={guildHeading} tabIndex={-1} className="sr-only">
        {localize('com_ui_discord_guilds')}
      </h3>
      {!showWizard &&
        applications.map((app) => (
          <Card
            key={app.applicationId}
            app={app}
            servers={installations.filter((guild) => guild.applicationId === app.applicationId)}
            open={!collapsed[app.applicationId]}
            disabled={disabled}
            onOpenChange={(open) =>
              setCollapsed((current) => ({ ...current, [app.applicationId]: !open }))
            }
            onEdit={edit}
            onSettings={(item, trigger) => {
              settingsTrigger.current = trigger;
              setSettings(item.applicationId);
            }}
            onConnect={(item, trigger) => start(item.applicationId, undefined, trigger)}
            onReconnect={reconnect}
            onDisconnect={disconnectGuild}
          />
        ))}
      {orphans.length > 0 && (
        <div className="border-border-light space-y-1 rounded-lg border p-3">
          <h4 className="text-sm font-medium">{localize('com_ui_discord_guilds_other')}</h4>
          <p className="text-text-secondary text-xs">
            {localize('com_ui_discord_guilds_other_help')}
          </p>
          {orphans.map((guild) => (
            <Server
              key={guild.installationId}
              guild={guild}
              disabled={disabled}
              onReconnect={reconnect}
              onDisconnect={disconnectGuild}
            />
          ))}
        </div>
      )}
      {(apps.hasNextPage || guilds.hasNextPage) && (
        <p className="text-text-secondary text-xs">{localize('com_ui_discord_more_hint')}</p>
      )}
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
      <Editor
        editor={editor}
        form={form}
        disabled={disabled}
        busy={busy}
        saving={save.isLoading}
        error={save.error}
        alertRef={reveal}
        onSubmit={(event) => void submit(event)}
        onClose={() => {
          form.reset(empty);
          setRestore({ trigger: editorTrigger.current });
          setEditor(null);
        }}
        onRefresh={refreshAfterError}
      />
      <Settings
        app={settingsApp}
        setup={setup}
        open={settingsOpen}
        disabled={disabled}
        busy={busy}
        registering={commandAppId === settings && commands.isLoading}
        registered={
          commandAppId === settings &&
          commands.isSuccess &&
          commands.variables?.expectedRevision === settingsApp?.revision
        }
        failure={commandFailed ? { error: commands.error } : null}
        loadError={apps.isError || guilds.isError ? apps.error || guilds.error : null}
        loadRef={settingsFailure}
        alertRef={reveal}
        commandRef={commandRef}
        onOpenChange={(open) => {
          if (!open) setSettings(null);
        }}
        onClosed={(event) => {
          event.preventDefault();
          const trigger = settingsTrigger.current;
          if (!restore && trigger?.isConnected && !trigger.disabled) trigger.focus();
        }}
        onRegister={() => {
          if (!settingsApp) return;
          commands.mutate({
            applicationId: settingsApp.applicationId,
            expectedRevision: settingsApp.revision,
            manifestVersion: DISCORD_COMMAND_MANIFEST_VERSION,
          });
        }}
        onRefresh={() => {
          setRestore({ trigger: commandTrigger.current });
          commands.reset();
          reconcile.mutate();
        }}
        onRetry={() => retry()}
      />
      <Connect
        flow={flow}
        reason={reason}
        error={linkError}
        busy={busy}
        retryable={!attempt.current && lastStart.current !== null}
        alertRef={revealFlow}
        errorRef={reveal}
        onCancel={cancelAttempt}
        onRetry={connectAgain}
        onRefresh={refreshAfterError}
      />
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
            <Notice
              ref={readHint}
              variant="warning"
              message={localize('com_ui_discord_disconnect_unread')}
              action={localize('com_ui_retry')}
              onAction={() => retry(cancelButton.current)}
            />
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

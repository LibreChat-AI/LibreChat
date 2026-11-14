import { useId, useRef, useState } from 'react';
import { dataService, MutationKeys, QueryKeys } from 'librechat-data-provider';
import { ChevronRight, ExternalLink, Pencil, Plus, Trash2 } from 'lucide-react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Chip,
  IconButton,
  TooltipAnchor,
  SecretInput,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  Button,
  Input,
  Label,
  OGDialog,
  OGDialogTemplate,
  Spinner,
} from '@librechat/client';
import type {
  ConfigureSlackApp,
  SlackAppRegistration,
  SlackWorkspace,
} from 'librechat-data-provider';
import type { ReactNode, ChangeEvent } from 'react';
import { channelErrorLabel } from '~/utils/channelErrors';
import { useAuthContext, useLocalize } from '~/hooks';
import Configuration from './Configuration';
import Loading from './Loading';

/** Organization administrators own the Slack app; operators only provide its callback service. */
export default function Apps({
  principalKey,
  busy,
  onInstall,
  workspaces = [],
  renderWorkspace,
  canManage = true,
  configured = true,
  hasMoreWorkspaces = false,
}: {
  principalKey: string;
  busy: boolean;
  onInstall: (appId: string) => void;
  workspaces?: SlackWorkspace[];
  renderWorkspace?: (workspace: SlackWorkspace, settings?: ReactNode) => ReactNode;
  canManage?: boolean;
  configured?: boolean;
  hasMoreWorkspaces?: boolean;
}) {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const id = useId();
  const client = useQueryClient();
  const [form, setForm] = useState<ConfigureSlackApp | null>(null);
  const [confirm, setConfirm] = useState<SlackAppRegistration | null>(null);
  const actionRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const submission = useRef<ConfigureSlackApp | null>(null);
  const original = useRef({ name: '', clientId: '' });
  const [saved, setSaved] = useState(false);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const apps = useInfiniteQuery(
    [QueryKeys.slackApps, principalKey],
    ({ pageParam }: { pageParam?: string }) => dataService.getSlackApps(pageParam),
    { getNextPageParam: (page) => page.next, enabled: canManage && configured },
  );
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries([QueryKeys.slackApps, principalKey]),
      client.invalidateQueries([QueryKeys.slackWorkspaces, principalKey]),
      client.invalidateQueries([QueryKeys.agentChannels]),
    ]);
  };
  const save = useMutation({
    mutationKey: [MutationKeys.slackApps, principalKey, 'save'],
    mutationFn: async () => {
      const input = submission.current;
      if (!input) throw new Error('Missing app registration');
      try {
        return await dataService.configureSlackApp(input);
      } finally {
        submission.current = null;
      }
    },
    onSuccess: async (app) => {
      setExpanded((current) => ({ ...current, [app.appId]: true }));
      setSearch('');
      setForm(null);
      setSaved(true);
      await refresh();
    },
  });
  const remove = useMutation({
    mutationKey: [MutationKeys.slackApps, principalKey, 'remove'],
    mutationFn: (app: SlackAppRegistration) => dataService.removeSlackApp(app.appId, app.revision),
    onSuccess: async () => {
      await refresh();
      setConfirm(null);
    },
  });
  const disabled = busy || save.isLoading || remove.isLoading || !canManage || !configured;
  const dirty = Boolean(
    form &&
      (!form.expectedRevision ||
        (form.name?.trim() ?? '') !== original.current.name ||
        form.clientId.trim() !== original.current.clientId ||
        form.clientSecret?.trim() ||
        form.signingSecret?.trim()),
  );
  const page = apps.data?.pages[0];
  const registrations =
    canManage && configured ? (apps.data?.pages.flatMap((p) => p.apps) ?? []) : [];
  const appIds = [
    ...new Set([
      ...registrations.map((app) => app.appId),
      ...workspaces.map((workspace) => workspace.appId),
    ]),
  ];
  const registrationsById = new Map(registrations.map((app) => [app.appId, app]));
  const workspaceAppNames = new Map(
    workspaces.map((workspace) => [workspace.appId, workspace.appName]),
  );
  const appName = (appId: string) =>
    registrationsById.get(appId)?.name || workspaceAppNames.get(appId);
  const query = search.trim().toLocaleLowerCase();
  const matchesApp = (appId: string) =>
    appId.toLocaleLowerCase().includes(query) ||
    appName(appId)?.toLocaleLowerCase().includes(query) === true;
  const matches = (appId: string) =>
    !query ||
    matchesApp(appId) ||
    workspaces.some(
      (workspace) =>
        workspace.appId === appId && workspace.teamName.toLocaleLowerCase().includes(query),
    );
  const edit = (app?: SlackAppRegistration) => {
    save.reset();
    remove.reset();
    setSaved(false);
    original.current = { name: app?.name?.trim() ?? '', clientId: app?.clientId.trim() ?? '' };
    setForm({
      appId: app?.appId ?? '',
      clientId: app?.clientId ?? '',
      name: app?.name ?? '',
      clientSecret: '',
      signingSecret: '',
      expectedRevision: app?.revision,
    });
  };
  const close = () => {
    if (save.isLoading) return;
    setForm(null);
    save.reset();
  };
  return (
    <section className="space-y-3" aria-labelledby={`${id}-title`}>
      <h3 ref={headingRef} id={`${id}-title`} tabIndex={-1} className="sr-only">
        {localize('com_ui_slack_apps_title')}
      </h3>
      <div className="flex items-center gap-3">
        <Input
          aria-label={localize('com_ui_slack_search')}
          placeholder={localize('com_ui_slack_search')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {canManage && configured && page?.canManage && page.configured && (
          <Button
            variant="outline"
            disabled={disabled}
            onClick={(event) => {
              actionRef.current = event.currentTarget;
              edit();
            }}
          >
            <Plus className="size-4" aria-hidden="true" />
            {localize('com_ui_slack_apps_add')}
          </Button>
        )}
      </div>
      {apps.isInitialLoading && <Loading />}
      {apps.isError && (
        <div className="flex flex-col items-start gap-2">
          <Alert variant="error">
            {localize(channelErrorLabel(apps.error, 'com_ui_slack_apps_error'))}
          </Alert>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => {
              save.reset();
              remove.reset();
              void apps.refetch();
            }}
          >
            {localize('com_ui_retry')}
          </Button>
        </div>
      )}
      {saved && (
        <Alert variant="success" role="status">
          {localize('com_ui_slack_apps_saved')}
        </Alert>
      )}
      <OGDialog
        open={form !== null && canManage && configured}
        triggerRef={actionRef}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <OGDialogTemplate
          title={localize(
            form?.expectedRevision ? 'com_ui_slack_apps_update' : 'com_ui_slack_apps_add',
          )}
          className="max-w-md"
          cancelDisabled={save.isLoading}
          onCloseAutoFocus={(event) => {
            if (actionRef.current?.isConnected) {
              event.preventDefault();
              actionRef.current.focus();
            }
          }}
          main={
            <div className="space-y-3">
              {form && (
                <form
                  id={`${id}-form`}
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!dirty || disabled) return;
                    const { clientSecret, signingSecret, ...metadata } = form;
                    submission.current = {
                      ...metadata,
                      name: form.name?.trim() ?? '',
                      ...(clientSecret?.trim() ? { clientSecret: clientSecret.trim() } : {}),
                      ...(signingSecret?.trim() ? { signingSecret: signingSecret.trim() } : {}),
                    };
                    save.mutate();
                  }}
                >
                  <div className="space-y-1">
                    <Label htmlFor={`${id}-name`}>
                      {localize('com_ui_name')}{' '}
                      <span className="text-text-secondary text-xs">
                        {localize('com_ui_optional')}
                      </span>
                    </Label>
                    <Input
                      id={`${id}-name`}
                      autoComplete="off"
                      maxLength={100}
                      value={form.name ?? ''}
                      disabled={disabled}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                    />
                  </div>
                  {(['appId', 'clientId', 'clientSecret', 'signingSecret'] as const).map(
                    (field) => {
                      const label = {
                        appId: 'com_ui_slack_apps_app_id',
                        clientId: 'com_ui_slack_apps_client_id',
                        clientSecret: 'com_ui_slack_apps_client_secret',
                        signingSecret: 'com_ui_slack_apps_signing_secret',
                      } as const;
                      const secret = field === 'clientSecret' || field === 'signingSecret';
                      const hasValue = Boolean(form.expectedRevision);
                      const statusText = localize(hasValue ? 'com_ui_set' : 'com_ui_unset');
                      const placeholder = hasValue ? '••••••••' : undefined;
                      const inputProps = {
                        id: `${id}-${field}`,
                        autoComplete: secret ? 'new-password' : 'off',
                        value: form[field] ?? '',
                        required:
                          !secret ||
                          !form.expectedRevision ||
                          (field === 'clientSecret' &&
                            form.clientId !== registrationsById.get(form.appId)?.clientId),
                        placeholder: secret ? placeholder : undefined,
                        maxLength: field === 'appId' ? 256 : 512,
                        disabled: disabled || (field === 'appId' && Boolean(form.expectedRevision)),
                        onChange: (event: ChangeEvent<HTMLInputElement>) =>
                          setForm({ ...form, [field]: event.target.value.trim() }),
                      };
                      return (
                        <div key={field} className="space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <Label htmlFor={`${id}-${field}`}>
                              {localize(label[field])}
                              {secret && <span className="sr-only"> ({statusText})</span>}
                            </Label>
                            {secret && (
                              <Chip tone={hasValue ? 'success' : 'neutral'} aria-hidden="true">
                                {statusText}
                              </Chip>
                            )}
                          </div>
                          {secret ? (
                            <SecretInput
                              {...inputProps}
                              data-lpignore="true"
                              data-1p-ignore="true"
                              controlsOnHover
                            />
                          ) : (
                            <Input {...inputProps} />
                          )}
                          {secret && hasValue && (
                            <p className="text-text-secondary text-xs">
                              {localize('com_ui_slack_apps_secret_keep')}
                            </p>
                          )}
                        </div>
                      );
                    },
                  )}
                  <Button asChild variant="inline-link" className="w-fit">
                    <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer">
                      {localize('com_ui_slack_apps_dashboard')}
                      <ExternalLink className="size-3.5" aria-hidden="true" />
                    </a>
                  </Button>
                </form>
              )}
              {save.isError && (
                <Alert variant="error">
                  {localize(channelErrorLabel(save.error, 'com_ui_slack_apps_error'))}
                </Alert>
              )}
            </div>
          }
          selection={
            <Button type="submit" form={`${id}-form`} disabled={disabled || !dirty}>
              {save.isLoading && <Spinner className="size-4" />}
              {localize('com_ui_save')}
            </Button>
          }
        />
      </OGDialog>
      {!apps.isInitialLoading && !appIds.length && (
        <p className="text-text-secondary text-sm">{localize('com_ui_slack_apps_empty')}</p>
      )}
      {query && appIds.length > 0 && !appIds.some(matches) && (
        <p className="text-text-secondary text-sm">{localize('com_ui_slack_search_empty')}</p>
      )}
      {appIds.filter(matches).map((appId) => {
        const app = registrationsById.get(appId);
        const name = appName(appId);
        const appLabel = name ? `${name} (${appId})` : appId;
        const children = workspaces.filter((workspace) => workspace.appId === appId);
        const canInstall =
          canManage &&
          configured &&
          app &&
          page?.canManage &&
          page.configured &&
          !hasMoreWorkspaces &&
          !children.some((workspace) => workspace.status === 'active');
        const settings =
          canManage && configured && app && page?.canManage && page.configured && page.setup ? (
            <Configuration
              app={app}
              setup={page.setup}
              tenantId={user?.tenantId || '_'}
              disabled={disabled || Boolean(form)}
            />
          ) : null;
        const visibleChildren =
          query && !matchesApp(appId)
            ? children.filter((workspace) => workspace.teamName.toLocaleLowerCase().includes(query))
            : children;
        const open = Boolean(query) || expanded[appId] === true;
        return (
          <div key={appId} className="border-border-light rounded-lg border">
            <Collapsible
              open={open}
              onOpenChange={(value) => setExpanded((current) => ({ ...current, [appId]: value }))}
            >
              <div className="relative flex items-center gap-2 rounded-lg p-3">
                <CollapsibleTrigger asChild>
                  <Button
                    variant={null}
                    className="absolute inset-0 h-full w-full"
                    aria-labelledby={`${id}-${appId}-label`}
                  />
                </CollapsibleTrigger>
                <div className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-2 text-sm">
                  <ChevronRight
                    className={open ? 'size-4 shrink-0 rotate-90' : 'size-4 shrink-0'}
                    aria-hidden="true"
                  />
                  <span
                    id={`${id}-${appId}-label`}
                    className="flex min-w-0 flex-1 flex-col items-start"
                  >
                    <span className="max-w-full truncate font-medium">
                      {name || localize('com_ui_slack_app')}
                    </span>
                    <span className="text-text-secondary max-w-full truncate font-mono text-xs">
                      {appId}
                    </span>
                  </span>
                </div>
                {canManage && configured && app && page?.canManage && (
                  <div className="relative z-10 flex shrink-0 items-center gap-2">
                    <TooltipAnchor
                      description={localize('com_ui_slack_apps_update')}
                      render={
                        <IconButton
                          label={localize('com_ui_slack_apps_edit_named', { 0: appLabel })}
                          variant="ghost"
                          size="sm"
                          shape="control"
                          disabled={disabled}
                          onClick={(event) => {
                            actionRef.current = event.currentTarget;
                            edit(app);
                          }}
                        >
                          <Pencil className="size-4" aria-hidden="true" />
                        </IconButton>
                      }
                    />
                    <TooltipAnchor
                      description={localize('com_ui_slack_apps_remove')}
                      render={
                        <IconButton
                          label={localize('com_ui_slack_apps_remove_named', { 0: appLabel })}
                          variant="ghost"
                          size="sm"
                          shape="control"
                          disabled={disabled}
                          onClick={(event) => {
                            actionRef.current = event.currentTarget;
                            remove.reset();
                            setConfirm(app);
                          }}
                        >
                          <Trash2 className="size-4" aria-hidden="true" />
                        </IconButton>
                      }
                    />
                  </div>
                )}
              </div>
              <CollapsibleContent>
                <div className="border-border-light space-y-3 border-t p-3">
                  {visibleChildren.map((workspace) => renderWorkspace?.(workspace, settings))}
                  {(canInstall || ((!children.length || !renderWorkspace) && settings)) && (
                    <div className="flex flex-wrap items-center gap-2">
                      {canInstall && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={disabled || Boolean(form)}
                          onClick={() => onInstall(appId)}
                        >
                          <Plus className="size-4" aria-hidden="true" />
                          {localize('com_ui_slack_workspaces_connect')}
                        </Button>
                      )}
                      {(!children.length || !renderWorkspace) && settings}
                    </div>
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        );
      })}
      {(apps.hasNextPage || hasMoreWorkspaces) && (
        <p className="text-text-secondary text-xs">{localize('com_ui_slack_search_loaded')}</p>
      )}
      {apps.hasNextPage && (
        <Button
          variant="outline"
          disabled={apps.isFetchingNextPage}
          onClick={() => void apps.fetchNextPage()}
        >
          {localize('com_ui_slack_workspaces_more')}
        </Button>
      )}
      <OGDialog
        open={confirm !== null && canManage && configured}
        triggerRef={actionRef}
        onOpenChange={(open) => {
          if (!open && !remove.isLoading) setConfirm(null);
        }}
      >
        <OGDialogTemplate
          className="max-w-md"
          footerClassName="sm:justify-between"
          title={localize('com_ui_slack_apps_remove_title')}
          description={confirm?.name ? `${confirm.name} · ${confirm.appId}` : confirm?.appId}
          cancelDisabled={remove.isLoading}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (actionRef.current?.isConnected) actionRef.current.focus();
            else headingRef.current?.focus();
          }}
          main={
            <div className="space-y-3 text-sm">
              <p className="text-text-secondary">{localize('com_ui_slack_apps_confirm_remove')}</p>
              {remove.isError && (
                <Alert variant="error">
                  {localize(channelErrorLabel(remove.error, 'com_ui_slack_apps_remove_error'))}
                </Alert>
              )}
            </div>
          }
          selection={
            <Button
              type="button"
              variant="destructive"
              disabled={disabled || !confirm}
              aria-busy={remove.isLoading}
              onClick={() => {
                if (confirm) remove.mutate(confirm);
              }}
            >
              {remove.isLoading && <Spinner className="size-4" aria-hidden="true" />}
              {localize('com_ui_slack_apps_remove')}
            </Button>
          }
        />
      </OGDialog>
    </section>
  );
}

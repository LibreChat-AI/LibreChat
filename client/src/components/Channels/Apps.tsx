import { useId, useRef, useState } from 'react';
import { Button, Input, Label, Spinner, Textarea } from '@librechat/client';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  dataService,
  MutationKeys,
  QueryKeys,
  SLACK_CHANNEL_BOT_EVENTS,
  SLACK_CHANNEL_LIFECYCLE_EVENTS,
  SLACK_CHANNEL_BOT_SCOPES,
} from 'librechat-data-provider';
import type { ConfigureSlackApp, SlackAppRegistration } from 'librechat-data-provider';
import { channelErrorLabel } from '~/utils/channelErrors';
import { useAuthContext, useLocalize } from '~/hooks';

/** Organization administrators own the Slack app; operators only provide its callback service. */
export default function Apps({
  principalKey,
  busy,
  onInstall,
}: {
  principalKey: string;
  busy: boolean;
  onInstall: (appId: string) => void;
}) {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const id = useId();
  const client = useQueryClient();
  const [form, setForm] = useState<ConfigureSlackApp | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const submission = useRef<ConfigureSlackApp | null>(null);
  const [saved, setSaved] = useState(false);
  const apps = useInfiniteQuery(
    [QueryKeys.slackApps, principalKey],
    ({ pageParam }: { pageParam?: string }) => dataService.getSlackApps(pageParam),
    { getNextPageParam: (page) => page.next },
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
    onSuccess: async () => {
      setForm(null);
      setSaved(true);
      await refresh();
    },
  });
  const remove = useMutation({
    mutationKey: [MutationKeys.slackApps, principalKey, 'remove'],
    mutationFn: (app: SlackAppRegistration) => dataService.removeSlackApp(app.appId, app.revision),
    onSuccess: async () => {
      setConfirm(null);
      await refresh();
    },
  });
  const disabled = busy || save.isLoading || remove.isLoading;
  const page = apps.data?.pages[0];
  const registrations = apps.data?.pages.flatMap((p) => p.apps) ?? [];
  const edit = (app?: SlackAppRegistration) => {
    save.reset();
    remove.reset();
    setSaved(false);
    setForm({
      appId: app?.appId ?? '',
      clientId: app?.clientId ?? '',
      clientSecret: '',
      signingSecret: '',
      expectedRevision: app?.revision,
    });
  };
  return (
    <section className="space-y-3" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="font-medium">
        {localize('com_ui_slack_apps_title')}
      </h3>
      <p className="text-text-secondary">{localize('com_ui_slack_apps_description')}</p>
      {apps.isLoading && <Spinner />}
      {(apps.isError || save.isError || remove.isError) && (
        <div role="alert" className="space-y-2">
          <p>
            {localize(
              channelErrorLabel(
                save.error ?? remove.error ?? apps.error,
                'com_ui_slack_apps_error',
              ),
            )}
          </p>
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
      {saved && <p role="status">{localize('com_ui_slack_apps_saved')}</p>}
      {page?.canManage && page.configured && !form && (
        <Button variant="outline" disabled={disabled} onClick={() => edit()}>
          {localize('com_ui_slack_apps_add')}
        </Button>
      )}
      {form && (
        <form
          className="border-border-light space-y-3 rounded-lg border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            submission.current = form;
            save.mutate();
          }}
        >
          <p>{localize('com_ui_slack_apps_instructions')}</p>
          <a
            className="text-text-primary underline"
            href="https://api.slack.com/apps"
            target="_blank"
            rel="noopener noreferrer"
          >
            {localize('com_ui_slack_apps_dashboard')}
          </a>
          {(['appId', 'clientId', 'clientSecret', 'signingSecret'] as const).map((field) => {
            const label = {
              appId: 'com_ui_slack_apps_app_id',
              clientId: 'com_ui_slack_apps_client_id',
              clientSecret: 'com_ui_slack_apps_client_secret',
              signingSecret: 'com_ui_slack_apps_signing_secret',
            } as const;
            return (
              <div key={field} className="space-y-1">
                <Label htmlFor={`${id}-${field}`}>{localize(label[field])}</Label>
                <Input
                  id={`${id}-${field}`}
                  type={field.endsWith('Secret') ? 'password' : 'text'}
                  autoComplete="off"
                  value={form[field]}
                  required
                  maxLength={field === 'appId' ? 256 : 512}
                  disabled={disabled || (field === 'appId' && Boolean(form.expectedRevision))}
                  onChange={(event) => setForm({ ...form, [field]: event.target.value.trim() })}
                />
              </div>
            );
          })}
          <div className="flex gap-2">
            <Button type="submit" disabled={disabled}>
              {localize('com_ui_save')}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() => {
                setForm(null);
                save.reset();
              }}
            >
              {localize('com_ui_cancel')}
            </Button>
          </div>
        </form>
      )}
      {page && !registrations.length && <p>{localize('com_ui_slack_apps_empty')}</p>}
      {registrations.map((app) => {
        const suffix = `/${encodeURIComponent(user?.tenantId || '_')}/${encodeURIComponent(app.appId)}`;
        const events = `${page?.setup?.eventsBaseUrl}${suffix}`;
        const interactions = `${page?.setup?.interactionsBaseUrl}${suffix}`;
        const manifest = {
          display_information: { name: 'LibreChat' },
          features: {
            bot_user: { display_name: 'LibreChat' },
            agent_view: { agent_description: 'Chat with your LibreChat agents' },
            app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
          },
          oauth_config: {
            scopes: { bot: [...SLACK_CHANNEL_BOT_SCOPES] },
            redirect_urls: [page?.setup?.redirectUri],
          },
          settings: {
            socket_mode_enabled: false,
            event_subscriptions: {
              bot_events: [...SLACK_CHANNEL_BOT_EVENTS, ...SLACK_CHANNEL_LIFECYCLE_EVENTS],
              request_url: events,
            },
            interactivity: { is_enabled: true, request_url: interactions },
            org_deploy_enabled: false,
            token_rotation_enabled: false,
          },
        };
        return (
          <div key={app.appId} className="border-border-light space-y-3 rounded-lg border p-3">
            <p className="font-mono text-sm">{app.appId}</p>
            {page?.setup && (
              <details className="space-y-2">
                <summary className="cursor-pointer">
                  {localize('com_ui_slack_apps_callbacks')}
                </summary>
                <p className="text-text-secondary">{localize('com_ui_slack_apps_settings')}</p>
                <Label htmlFor={`${id}-${app.appId}-manifest`}>
                  {localize('com_ui_channels_manifest')}
                </Label>
                <Textarea
                  id={`${id}-${app.appId}-manifest`}
                  readOnly
                  rows={8}
                  value={JSON.stringify(manifest, null, 2)}
                />
                {(
                  [
                    ['com_ui_slack_apps_redirect', page.setup.redirectUri],
                    ['com_ui_slack_apps_events', events],
                    ['com_ui_slack_apps_interactions', interactions],
                  ] as const
                ).map(([kind, value]) => (
                  <div key={kind} className="space-y-1">
                    <Label htmlFor={`${id}-${app.appId}-${kind}`}>{localize(kind)}</Label>
                    <Input
                      id={`${id}-${app.appId}-${kind}`}
                      readOnly
                      value={value}
                      onFocus={(event) => event.target.select()}
                    />
                  </div>
                ))}
              </details>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={disabled || !page?.configured || Boolean(form)}
                onClick={() => onInstall(app.appId)}
              >
                {localize('com_ui_slack_workspaces_connect')}
              </Button>
              <Button
                variant="outline"
                disabled={disabled || Boolean(form)}
                onClick={() => edit(app)}
              >
                {localize('com_ui_slack_apps_update')}
              </Button>
              <Button variant="outline" disabled={disabled} onClick={() => setConfirm(app.appId)}>
                {localize('com_ui_slack_apps_remove')}
              </Button>
            </div>
            {confirm === app.appId && (
              <div
                className="space-y-2"
                role="group"
                aria-label={localize('com_ui_slack_apps_confirm_remove')}
              >
                <p>{localize('com_ui_slack_apps_confirm_remove')}</p>
                <div className="flex gap-2">
                  <Button
                    variant="destructive"
                    disabled={disabled}
                    onClick={() => remove.mutate(app)}
                  >
                    {localize('com_ui_slack_apps_remove')}
                  </Button>
                  <Button variant="outline" disabled={disabled} onClick={() => setConfirm(null)}>
                    {localize('com_ui_cancel')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {apps.hasNextPage && (
        <Button
          variant="outline"
          disabled={apps.isFetchingNextPage}
          onClick={() => void apps.fetchNextPage()}
        >
          {localize('com_ui_slack_workspaces_more')}
        </Button>
      )}
    </section>
  );
}

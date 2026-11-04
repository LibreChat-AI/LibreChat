import { useEffect, useId, useState, useRef } from 'react';
import { MutationKeys, QueryKeys } from 'librechat-data-provider';
import { Alert, Button, Spinner, ThemeSelector } from '@librechat/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Check, ChevronDown, ExternalLink, ShieldCheck, UserRound } from 'lucide-react';
import type {
  ChannelIdentityClient,
  ChannelIdentityError,
  ChannelIdentityResult,
  ChannelLinkView,
} from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { useLocalize } from '~/hooks';

export const linkErrorKeys: Record<ChannelIdentityError, TranslationKeys> = {
  invalid_ticket: 'com_ui_channel_link_invalid',
  expired: 'com_ui_channel_link_expired',
  changed: 'com_ui_channel_link_changed',
  forbidden: 'com_ui_channel_link_forbidden',
  already_linked: 'com_ui_channel_link_exists',
  confirmation_required: 'com_ui_channel_link_confirm_slack',
  revoked: 'com_ui_channel_link_revoked',
  unavailable: 'com_ui_channel_link_error',
};

const pageCopy = {
  pending: {
    title: 'com_ui_channel_link_title',
    description: 'com_ui_channel_link_description',
  },
  accepted: {
    title: 'com_ui_channel_link_finish_title',
    description: 'com_ui_channel_link_finish_description',
  },
  active: {
    title: 'com_ui_channel_link_connected_title',
    description: 'com_ui_channel_link_connected_description',
  },
} as const;

interface LinkProps {
  api: ChannelIdentityClient;
  accountLabel: string;
  agentLabel?: string;
  appTitle?: string;
  principalKey: string;
  ticket?: string;
  enabled?: boolean;
  onTicketResult?: (result: ChannelIdentityResult<ChannelLinkView>) => void;
}
/** The host owns session and policy readiness; tickets never become query-key material. */
export default function Link(props: LinkProps) {
  return <OwnedLink key={JSON.stringify([props.principalKey, props.ticket])} {...props} />;
}
function OwnedLink({
  api,
  accountLabel,
  agentLabel,
  appTitle = 'LibreChat',
  principalKey,
  ticket: suppliedTicket,
  onTicketResult,
  enabled = true,
}: LinkProps) {
  const localize = useLocalize();
  const id = useId();
  const queryClient = useQueryClient();
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const key = [QueryKeys.channelLinkTicket, principalKey, id];
  const [ticket] = useState(() => suppliedTicket ?? window.location.hash.slice(1));
  useEffect(() => {
    if (suppliedTicket == null && window.location.hash) {
      window.history.replaceState(
        window.history.state,
        '',
        `${window.location.pathname}${window.location.search}`,
      );
    }
  }, [suppliedTicket]);
  const preview = useQuery(key, () => api.preview(ticket), {
    enabled: ticket.length > 0 && Boolean(principalKey) && enabled,
    retry: false,
    cacheTime: 0,
  });
  const accept = useMutation({
    mutationKey: [MutationKeys.channelLinkTicket, principalKey, id],
    cacheTime: 0,
    mutationFn: async () => {
      if (
        !mounted.current ||
        !enabled ||
        inFlight.current ||
        preview.isFetching ||
        preview.isError ||
        !preview.data?.ok ||
        preview.data.value.state !== 'pending' ||
        preview.data.value.expiresAtMs <= Date.now()
      )
        throw new Error('Channel link preview is unavailable');
      inFlight.current = true;
      try {
        return await api.accept({ ticket, expectedRevision: preview.data.value.revision });
      } finally {
        inFlight.current = false;
      }
    },
    onSuccess: async (result) => {
      if (!mounted.current) return;
      await queryClient.cancelQueries(key);
      if (!mounted.current) return;
      const current = queryClient.getQueryData<ChannelIdentityResult<ChannelLinkView>>(key);
      if (result.ok && current?.ok && current.value.state === 'pending') {
        queryClient.setQueryData(key, result);
      }
      await preview.refetch();
    },
    onError: async () => {
      if (!mounted.current) return;
      await queryClient.cancelQueries(key);
      if (!mounted.current) return;
      await preview.refetch();
    },
  });
  const result = preview.data;
  useEffect(() => {
    if (result) onTicketResult?.(result);
  }, [result, onTicketResult]);
  const data = result?.ok ? result.value : undefined;
  const mutationError =
    data?.state === 'pending' && accept.data && !accept.data.ok
      ? accept.data.error.code
      : undefined;
  const error = result && !result.ok ? result.error.code : mutationError;
  const accepted = data?.state === 'accepted';
  const active = data?.state === 'active';
  const nextStep = accepted || active;
  const copy = accepted || active ? pageCopy[data.state] : pageCopy.pending;
  const canReturnToSlack = nextStep && !error && !preview.isError;
  const retryable =
    preview.isError ||
    (accept.isError && data?.state === 'pending') ||
    Boolean(mutationError) ||
    error === 'changed';

  return (
    <main
      className="bg-surface-primary text-text-primary flex min-h-screen flex-col items-center justify-center px-4 py-8"
      aria-labelledby={`${id}-title`}
    >
      <div className="w-full max-w-lg">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <img src="assets/logo.svg" alt="" className="size-7 object-contain" />
          <span className="text-lg font-semibold">{appTitle}</span>
        </div>
        <section className="border-border-light bg-surface-secondary overflow-hidden rounded-2xl border shadow-sm">
          <div className="space-y-5 p-6 sm:p-7">
            <ol
              className="text-text-secondary flex items-center gap-3 text-xs font-medium"
              aria-label={localize('com_ui_channel_link_steps')}
            >
              <li className="flex items-center gap-2" aria-current={!nextStep ? 'step' : undefined}>
                <span className="bg-surface-tertiary text-text-primary flex size-6 items-center justify-center rounded-full">
                  {nextStep ? <Check className="size-3.5" aria-hidden="true" /> : '1'}
                </span>
                {localize('com_ui_channel_link_step_account')}
              </li>
              <li
                className="flex flex-1 items-center gap-2"
                aria-current={accepted ? 'step' : undefined}
              >
                <span className="bg-border-light me-1 h-px flex-1" aria-hidden="true" />
                <span className="bg-surface-tertiary text-text-primary flex size-6 items-center justify-center rounded-full">
                  {active ? <Check className="size-3.5" aria-hidden="true" /> : '2'}
                </span>
                {localize('com_ui_channel_link_step_slack')}
              </li>
            </ol>

            <header className="space-y-3">
              <h1 id={`${id}-title`} className="text-2xl font-semibold tracking-tight">
                {localize(copy.title)}
              </h1>
              <p className="text-text-secondary text-sm leading-6">{localize(copy.description)}</p>
            </header>

            <div className="border-border-light bg-surface-primary divide-border-light divide-y rounded-xl border">
              <div className="flex items-center gap-3 px-4 py-3.5">
                <UserRound className="text-text-secondary size-4 shrink-0" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-text-secondary text-xs">
                    {localize('com_ui_channel_link_account')}
                  </p>
                  <p className="mt-0.5 text-sm font-medium break-words">{accountLabel}</p>
                </div>
              </div>
              {data && (
                <div className="flex items-center gap-3 px-4 py-3.5">
                  <Bot className="text-text-secondary size-4 shrink-0" aria-hidden="true" />
                  <div className="min-w-0">
                    <p className="text-text-secondary text-xs">
                      {localize('com_ui_channel_link_agent')}
                    </p>
                    <p className="mt-0.5 text-sm font-medium break-words">
                      {agentLabel || localize('com_ui_channel_link_agent_fallback')}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {ticket && enabled && preview.isLoading && (
              <div className="text-text-secondary flex items-center gap-2 text-sm">
                <Spinner className="size-4" />
                <span>{localize('com_ui_channel_link_loading')}</span>
              </div>
            )}
            {!ticket && <Alert variant="error">{localize('com_ui_channel_link_invalid')}</Alert>}
            {error && <Alert variant="error">{localize(linkErrorKeys[error])}</Alert>}
            {(preview.isError || (accept.isError && data?.state === 'pending')) && (
              <Alert variant="error">{localize('com_ui_channel_link_error')}</Alert>
            )}
            {accepted && (
              <Alert variant="info" role="status">
                {localize('com_ui_channel_link_confirm_slack')}
              </Alert>
            )}
            {data?.state === 'expired' && (
              <Alert variant="warning">{localize('com_ui_channel_link_expired')}</Alert>
            )}
            {data?.state === 'revoked' && (
              <Alert variant="neutral" role="status">
                {localize('com_ui_channel_link_revoked')}
              </Alert>
            )}
            {data?.state === 'unavailable' && (
              <Alert variant="warning" role="status">
                {localize('com_ui_channel_link_unavailable')}
              </Alert>
            )}
            {active && (
              <Alert variant="success" role="status">
                {localize('com_ui_channel_link_active')}
              </Alert>
            )}

            {data?.state === 'pending' && (
              <Button
                type="button"
                size="lg"
                className="w-full"
                disabled={
                  !enabled ||
                  preview.isFetching ||
                  preview.isError ||
                  accept.isLoading ||
                  Boolean(mutationError) ||
                  accept.isError ||
                  data.expiresAtMs <= Date.now()
                }
                onClick={() => accept.mutate()}
              >
                {accept.isLoading && <Spinner className="size-4" />}
                {localize('com_ui_channel_link_accept')}
              </Button>
            )}
            {canReturnToSlack && (
              <Button asChild size="lg" className="w-full">
                <a href={`slack://open?team=${encodeURIComponent(data.identity.teamId)}`}>
                  {localize('com_ui_channel_link_open_slack')}
                  <ExternalLink className="size-4" aria-hidden="true" />
                </a>
              </Button>
            )}
            {retryable && (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={!enabled || preview.isFetching || accept.isLoading}
                onClick={() => {
                  accept.reset();
                  void preview.refetch();
                }}
              >
                {localize('com_ui_retry')}
              </Button>
            )}

            {data && (
              <details className="group border-border-light border-t pt-4">
                <summary className="text-text-secondary hover:text-text-primary focus-visible:outline-focus-control flex cursor-pointer list-none items-center justify-between gap-2 rounded-sm text-xs focus-visible:outline-2 focus-visible:outline-offset-4">
                  {localize('com_ui_channel_link_details')}
                  <ChevronDown
                    className="size-3.5 transition-transform group-open:rotate-180 motion-reduce:transition-none"
                    aria-hidden="true"
                  />
                </summary>
                <dl className="text-text-secondary mt-4 grid gap-3 text-xs">
                  <div>
                    <dt>{localize('com_ui_channel_link_workspace')}</dt>
                    <dd className="text-text-primary mt-1 font-mono break-all">
                      {data.identity.teamId}
                    </dd>
                  </div>
                  <div>
                    <dt>{localize('com_ui_channel_link_actor')}</dt>
                    <dd className="text-text-primary mt-1 font-mono break-all">
                      {data.identity.externalUserId}
                    </dd>
                  </div>
                  <div>
                    <dt>{localize('com_ui_channel_link_agent')}</dt>
                    <dd className="text-text-primary mt-1 font-mono break-all">
                      {data.identity.agentId}
                    </dd>
                  </div>
                </dl>
              </details>
            )}
          </div>
          <footer className="border-border-light bg-surface-primary text-text-secondary flex gap-2.5 border-t px-6 py-4 text-xs leading-5 sm:px-8">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p>{localize('com_ui_channel_link_boundary')}</p>
          </footer>
        </section>
      </div>
      <div className="mt-6">
        <ThemeSelector returnThemeOnly />
      </div>
    </main>
  );
}

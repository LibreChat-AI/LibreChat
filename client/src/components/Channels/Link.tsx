import { useEffect, useId, useState, useRef } from 'react';
import { Button, Spinner } from '@librechat/client';
import { MutationKeys, QueryKeys } from 'librechat-data-provider';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

interface LinkProps {
  api: ChannelIdentityClient;
  accountLabel: string;
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
  return (
    <main
      className="text-text-primary mx-auto w-full max-w-lg space-y-4 p-6"
      aria-labelledby={`${id}-title`}
    >
      <h1 id={`${id}-title`} className="text-xl font-semibold">
        {localize('com_ui_channel_link_title')}
      </h1>
      <p>{localize('com_ui_channel_link_signed_in', { 0: accountLabel })}</p>
      <p className="text-text-secondary">{localize('com_ui_channel_link_boundary')}</p>
      {ticket && enabled && preview.isLoading && <Spinner />}
      {!ticket && <p role="alert">{localize('com_ui_channel_link_invalid')}</p>}
      {error && <p role="alert">{localize(linkErrorKeys[error])}</p>}
      {(preview.isError || (accept.isError && data?.state === 'pending')) && (
        <p role="alert">{localize('com_ui_channel_link_error')}</p>
      )}
      {data && (
        <dl className="space-y-2 break-all">
          <dt>{localize('com_ui_channel_link_workspace')}</dt>
          <dd>{data.identity.teamId}</dd>
          <dt>{localize('com_ui_channel_link_actor')}</dt>
          <dd>{data.identity.externalUserId}</dd>
          <dt>{localize('com_ui_channel_link_agent')}</dt>
          <dd>{data.identity.agentId}</dd>
        </dl>
      )}
      {data?.state === 'pending' && (
        <Button
          type="button"
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
          {localize('com_ui_channel_link_accept')}
        </Button>
      )}
      {data?.state === 'accepted' && (
        <p role="status">{localize('com_ui_channel_link_confirm_slack')}</p>
      )}
      {data?.state === 'expired' && <p role="alert">{localize('com_ui_channel_link_expired')}</p>}
      {data?.state === 'revoked' && <p role="status">{localize('com_ui_channel_link_revoked')}</p>}
      {data?.state === 'unavailable' && (
        <p role="status">{localize('com_ui_channel_link_unavailable')}</p>
      )}
      {data?.state === 'active' && <p role="status">{localize('com_ui_channel_link_active')}</p>}
      {(preview.isError ||
        (accept.isError && data?.state === 'pending') ||
        Boolean(mutationError) ||
        error === 'changed') && (
        <Button
          type="button"
          variant="outline"
          disabled={!enabled || preview.isFetching || accept.isLoading}
          onClick={() => {
            accept.reset();
            void preview.refetch();
          }}
        >
          {localize('com_ui_retry')}
        </Button>
      )}
    </main>
  );
}

import { useEffect, useId, useState } from 'react';
import { Button, Spinner } from '@librechat/client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { MutationKeys, QueryKeys } from 'librechat-data-provider';
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

/** Mount behind normal sign-in; a GET/preview never links an account. */
export default function Link({
  api,
  accountLabel,
  ticket: suppliedTicket,
  onTicketResult,
}: {
  api: ChannelIdentityClient;
  accountLabel: string;
  ticket?: string;
  onTicketResult?: (result: ChannelIdentityResult<ChannelLinkView>) => void;
}) {
  const localize = useLocalize();
  const id = useId();
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
  const preview = useQuery([QueryKeys.channelLinkTicket, id], () => api.preview(ticket), {
    enabled: ticket.length > 0,
    retry: false,
    cacheTime: 0,
  });
  const accept = useMutation({
    mutationKey: [MutationKeys.channelLinkTicket, id],
    cacheTime: 0,
    mutationFn: () => {
      if (!preview.data?.ok) throw new Error('Channel link preview is unavailable');
      return api.accept({ ticket, expectedRevision: preview.data.value.revision });
    },
  });
  const result = accept.data ?? preview.data;
  useEffect(() => {
    if (result) onTicketResult?.(result);
  }, [result, onTicketResult]);
  const data = result?.ok ? result.value : undefined;
  const error = result && !result.ok ? result.error.code : undefined;
  return (
    <main className="mx-auto w-full max-w-lg space-y-4 p-6" aria-labelledby={`${id}-title`}>
      <h1 id={`${id}-title`} className="text-xl font-semibold">
        {localize('com_ui_channel_link_title')}
      </h1>
      <p>{localize('com_ui_channel_link_signed_in', { 0: accountLabel })}</p>
      <p className="text-text-secondary">{localize('com_ui_channel_link_boundary')}</p>
      {ticket && preview.isLoading && <Spinner />}
      {!ticket && <p role="alert">{localize('com_ui_channel_link_invalid')}</p>}
      {error && <p role="alert">{localize(linkErrorKeys[error])}</p>}
      {(preview.isError || accept.isError) && (
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
        <Button type="button" disabled={accept.isLoading} onClick={() => accept.mutate()}>
          {localize('com_ui_channel_link_accept')}
        </Button>
      )}
      {data?.state === 'accepted' && (
        <p role="status">{localize('com_ui_channel_link_confirm_slack')}</p>
      )}
      {data?.state === 'active' && <p role="status">{localize('com_ui_channel_link_active')}</p>}
      {(preview.isError || error === 'changed') && (
        <Button
          type="button"
          variant="outline"
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

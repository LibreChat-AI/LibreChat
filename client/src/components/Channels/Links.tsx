import { useId, useState } from 'react';
import { Button, Spinner } from '@librechat/client';
import { MutationKeys, QueryKeys } from 'librechat-data-provider';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChannelIdentityClient, ChannelLinkView } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { linkErrorKeys } from './Link';
import { useLocalize } from '~/hooks';

const states: Record<ChannelLinkView['state'], TranslationKeys> = {
  pending: 'com_ui_channel_link_pending',
  accepted: 'com_ui_channel_link_confirm_slack',
  active: 'com_ui_channel_link_active',
  revoked: 'com_ui_channel_link_revoked',
  expired: 'com_ui_channel_link_expired',
};

export default function Links({
  api,
  principalKey,
}: {
  api: ChannelIdentityClient;
  principalKey: string;
}) {
  const localize = useLocalize();
  const id = useId();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<string | null>(null);
  const key = [QueryKeys.channelLinks, principalKey];
  const links = useQuery(key, () => api.list(), { retry: false, cacheTime: 0 });
  const revoke = useMutation({
    mutationKey: [MutationKeys.channelLinks, principalKey],
    mutationFn: (link: ChannelLinkView) => api.revoke(link.linkId, link.revision),
    onSuccess: async () => {
      setConfirm(null);
      await queryClient.invalidateQueries(key);
    },
  });
  return (
    <section className="space-y-4" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="font-medium">
        {localize('com_ui_channel_link_personal')}
      </h2>
      <p className="text-text-secondary">{localize('com_ui_channel_link_boundary')}</p>
      {links.isLoading && <Spinner />}
      {links.isError && (
        <div role="alert">
          <p>{localize('com_ui_channel_link_error')}</p>
          <Button type="button" variant="outline" onClick={() => void links.refetch()}>
            {localize('com_ui_retry')}
          </Button>
        </div>
      )}
      {revoke.isError && <p role="alert">{localize('com_ui_channel_link_error')}</p>}
      {revoke.data && !revoke.data.ok && (
        <p role="alert">{localize(linkErrorKeys[revoke.data.error.code])}</p>
      )}
      {links.data?.length === 0 && <p>{localize('com_ui_channel_link_empty')}</p>}
      {links.data?.map((link) => (
        <div key={link.linkId} className="border-border-light space-y-2 rounded-lg border p-3">
          <p className="break-all">
            {localize('com_ui_channel_link_binding', {
              0: link.identity.teamId,
              1: link.identity.externalUserId,
              2: link.identity.agentId,
            })}
          </p>
          <p role="status">{localize(states[link.state])}</p>
          {link.state !== 'revoked' &&
            (confirm === link.linkId ? (
              <div role="group" aria-label={localize('com_ui_channel_link_revoke_confirm')}>
                <p>{localize('com_ui_channel_link_revoke_confirm')}</p>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={revoke.isLoading}
                    onClick={() => revoke.mutate(link)}
                  >
                    {localize('com_ui_channel_link_revoke')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={revoke.isLoading}
                    onClick={() => setConfirm(null)}
                  >
                    {localize('com_ui_cancel')}
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                disabled={revoke.isLoading}
                onClick={() => {
                  revoke.reset();
                  setConfirm(link.linkId);
                }}
              >
                {localize('com_ui_channel_link_revoke')}
              </Button>
            ))}
        </div>
      ))}
    </section>
  );
}

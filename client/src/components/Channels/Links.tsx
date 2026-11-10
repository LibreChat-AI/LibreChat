import { useId, useRef, useState } from 'react';
import { MutationKeys, QueryKeys } from 'librechat-data-provider';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, OGDialog, OGDialogTemplate, Spinner, Tag } from '@librechat/client';
import type { ChannelIdentityClient, ChannelLinkView } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { linkErrorKeys } from './Link';
import { useLocalize } from '~/hooks';

const states: Record<ChannelLinkView['state'], TranslationKeys> = {
  pending: 'com_ui_channel_link_status_pending',
  accepted: 'com_ui_channel_link_status_accepted',
  active: 'com_ui_channel_link_active',
  revoked: 'com_ui_channel_link_revoked',
  expired: 'com_ui_channel_link_status_expired',
  unavailable: 'com_ui_channels_workspace_unavailable_status',
};

const variants = {
  pending: 'info',
  accepted: 'info',
  active: 'success',
  revoked: 'neutral',
  expired: 'neutral',
  unavailable: 'neutral',
} as const;

interface LinksProps {
  api: ChannelIdentityClient;
  principalKey: string;
}
export default function Links(props: LinksProps) {
  return <OwnedLinks key={props.principalKey} {...props} />;
}
function OwnedLinks({ api, principalKey }: { api: ChannelIdentityClient; principalKey: string }) {
  const localize = useLocalize();
  const id = useId();
  const queryClient = useQueryClient();
  const actionRef = useRef<HTMLButtonElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const key = [QueryKeys.channelLinks, principalKey];
  const links = useQuery(key, () => api.list(), { retry: false, cacheTime: 0 });
  const revoke = useMutation({
    mutationKey: [MutationKeys.channelLinks, principalKey],
    mutationFn: (link: ChannelLinkView) => api.revoke(link.linkId, link.revision),
    onSuccess: async (result, link) => {
      if (result.ok) setConfirm((current) => (current === link.linkId ? null : current));
      await queryClient.invalidateQueries(key);
    },
  });
  const selected = links.data?.find((link) => link.linkId === confirm);
  if (links.isSuccess && links.data.length === 0) return null;
  return (
    <section className="space-y-4" aria-labelledby={`${id}-title`}>
      <h2
        ref={headingRef}
        tabIndex={-1}
        id={`${id}-title`}
        className="text-text-primary text-sm font-medium"
      >
        {localize('com_ui_channel_link_personal')}
      </h2>
      {links.isLoading && <Spinner />}
      {links.isError && (
        <div role="alert">
          <p>{localize('com_ui_channel_link_error')}</p>
          <Button type="button" variant="outline" onClick={() => void links.refetch()}>
            {localize('com_ui_retry')}
          </Button>
        </div>
      )}
      {links.data?.map((link) => (
        <div key={link.linkId} className="border-border-light space-y-2 rounded-lg border p-3">
          <p className="break-all">
            {localize('com_ui_channel_link_binding', {
              0: link.identity.teamId,
              1: link.identity.externalUserId,
              2: link.identity.agentId,
            })}
          </p>
          <div className="flex items-center justify-between gap-3">
            <Tag
              role="status"
              className="w-fit"
              label={localize(states[link.state])}
              variant={variants[link.state]}
            />
            {link.state !== 'revoked' && (
              <Button
                type="button"
                variant="outline"
                disabled={revoke.isLoading}
                onClick={(event) => {
                  actionRef.current = event.currentTarget;
                  revoke.reset();
                  setConfirm(link.linkId);
                }}
              >
                {localize('com_ui_channel_link_revoke')}
              </Button>
            )}
          </div>
        </div>
      ))}
      <OGDialog
        open={Boolean(selected)}
        triggerRef={actionRef}
        onOpenChange={(open) => {
          if (!open && !revoke.isLoading) setConfirm(null);
        }}
      >
        <OGDialogTemplate
          className="max-w-md"
          title={localize('com_ui_channel_link_revoke')}
          cancelDisabled={revoke.isLoading}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (actionRef.current?.isConnected) actionRef.current.focus();
            else headingRef.current?.focus();
          }}
          main={
            <div className="space-y-3 text-sm">
              <p>{localize('com_ui_channel_link_revoke_confirm')}</p>
              {revoke.isError && <p role="alert">{localize('com_ui_channel_link_error')}</p>}
              {revoke.data && !revoke.data.ok && (
                <p role="alert">{localize(linkErrorKeys[revoke.data.error.code])}</p>
              )}
            </div>
          }
          selection={
            <Button
              type="button"
              variant="destructive"
              disabled={revoke.isLoading || !selected}
              aria-busy={revoke.isLoading}
              onClick={() => {
                if (selected) revoke.mutate(selected);
              }}
            >
              {localize('com_ui_channel_link_revoke')}
            </Button>
          }
        />
      </OGDialog>
    </section>
  );
}

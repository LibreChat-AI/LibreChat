import { useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { MutationKeys, QueryKeys } from 'librechat-data-provider';
import { Alert, Button, Spinner, TooltipAnchor } from '@librechat/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChannelIdentityClient, ChannelLinkView } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import DeleteChannelDialog from '~/components/SidePanel/Agents/DeleteChannelDialog';
import { useGetAgentByIdQuery } from '~/data-provider';
import { linkErrorKeys } from './Link';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

const states: Record<ChannelLinkView['state'], TranslationKeys> = {
  pending: 'com_ui_channel_link_status_pending',
  accepted: 'com_ui_channel_link_status_accepted',
  active: 'com_ui_channel_link_active',
  revoked: 'com_ui_channel_link_revoked',
  expired: 'com_ui_channel_link_status_expired',
  unavailable: 'com_ui_channels_workspace_unavailable_status',
};

const dotColors: Record<ChannelLinkView['state'], string> = {
  pending: 'bg-status-info',
  accepted: 'bg-status-warning',
  active: 'bg-status-success',
  revoked: 'bg-status-neutral',
  expired: 'bg-status-error',
  unavailable: 'bg-status-error',
};

/** The agent's own name when it can be read. While it loads the row reads as a Slack agent; when
 *  it cannot be read (deleted, or no longer shared) the id stays, so two such links stay distinct. */
function LinkAgentName({ agentId }: { agentId: string }) {
  const localize = useLocalize();
  const agent = useGetAgentByIdQuery(agentId);
  if (agent.data?.name) {
    return <>{agent.data.name}</>;
  }
  return <>{agent.isLoading ? localize('com_ui_channel_link_agent_fallback') : agentId}</>;
}

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
  let revokeError: string | undefined;
  if (revoke.isError) revokeError = localize('com_ui_channel_link_error');
  else if (revoke.data && !revoke.data.ok)
    revokeError = localize(linkErrorKeys[revoke.data.error.code]);
  if (links.isSuccess && links.data.length === 0) return null;
  return (
    <section className="space-y-4" aria-labelledby={`${id}-title`}>
      <h2 ref={headingRef} tabIndex={-1} id={`${id}-title`} className="sr-only">
        {localize('com_ui_channel_link_personal')}
      </h2>
      {links.isLoading && (
        <div role="status" className="text-text-secondary flex items-center gap-2 text-sm">
          <Spinner className="size-4" />
          <span>{localize('com_ui_channel_link_loading')}</span>
        </div>
      )}
      {links.isError && (
        <div className="flex flex-col items-start gap-2">
          <Alert variant="error">{localize('com_ui_channel_link_error')}</Alert>
          <Button type="button" variant="outline" onClick={() => void links.refetch()}>
            {localize('com_ui_retry')}
          </Button>
        </div>
      )}
      {links.data != null && links.data.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {links.data.map((link) => (
            <li
              key={link.linkId}
              className="group hover:bg-surface-secondary flex items-center gap-2.5 rounded-lg px-2 py-1.5"
            >
              <TooltipAnchor
                description={localize(states[link.state])}
                render={
                  <span className="relative shrink-0">
                    <span className="bg-surface-fixed flex size-7 items-center justify-center overflow-hidden rounded-md">
                      <img src="assets/slack.svg" alt="" className="size-4" />
                    </span>
                    <span
                      className={cn(
                        'ring-surface-primary absolute -end-0.5 -bottom-0.5 size-2.5 rounded-full ring-2',
                        dotColors[link.state],
                      )}
                    />
                  </span>
                }
              />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-text-primary truncate text-sm font-medium">
                  <LinkAgentName agentId={link.identity.agentId} />
                </span>
                <span className="text-text-secondary truncate text-xs">
                  {localize('com_ui_channel_link_slack_ids', {
                    0: link.identity.externalUserId,
                    1: link.identity.teamId,
                  })}
                </span>
              </div>
              <span role="status" className="sr-only">
                {localize(states[link.state])}
              </span>
              {link.state !== 'revoked' && (
                <div className="no-touch:opacity-0 shrink-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100">
                  <TooltipAnchor
                    description={localize('com_ui_channel_link_revoke')}
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        disabled={revoke.isLoading}
                        aria-label={localize('com_ui_channel_link_revoke_for', {
                          0: link.identity.agentId,
                        })}
                        onClick={(event) => {
                          actionRef.current = event.currentTarget;
                          revoke.reset();
                          setConfirm(link.linkId);
                        }}
                      >
                        <X className="size-3.5" aria-hidden="true" />
                      </Button>
                    }
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <DeleteChannelDialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open && !revoke.isLoading) setConfirm(null);
        }}
        onConfirm={() => {
          if (selected) revoke.mutate(selected);
        }}
        loading={revoke.isLoading}
        disabled={!selected}
        error={revokeError}
        triggerRef={actionRef}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (actionRef.current?.isConnected) actionRef.current.focus();
          else headingRef.current?.focus();
        }}
        title="com_ui_channel_link_revoke_title"
        description="com_ui_channel_link_revoke_confirm"
        confirmLabel="com_ui_channel_link_revoke"
      />
    </section>
  );
}

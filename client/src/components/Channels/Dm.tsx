import { useEffect, useId, useRef, useState } from 'react';
import { atom, Provider, useAtom } from 'jotai';
import { dataService, MutationKeys, QueryKeys } from 'librechat-data-provider';
import {
  useInfiniteQuery,
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  Alert,
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Input,
  Label,
  OGDialog,
  OGDialogTemplate,
  Spinner,
} from '@librechat/client';
import type {
  ChannelLinkView,
  DiscordDmIssuedCode,
  DiscordDmSelectionView,
} from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { useLocalize, useCopyToClipboard } from '~/hooks';
import { LinkAgentName } from './Links';

const editorAtom = atom<ChannelLinkView | null>(null);
const confirmAtom = atom<DiscordDmSelectionView | null>(null);
const codeAtom = atom<DiscordDmIssuedCode | null>(null);
const expiredAtom = atom(false);
const states: Record<DiscordDmSelectionView['state'], TranslationKeys> = {
  active: 'com_ui_channel_link_active',
  revoked: 'com_ui_channel_link_revoked',
  expired: 'com_ui_channel_link_status_expired',
  unavailable: 'com_ui_channels_workspace_unavailable_status',
};
function errorKey(error: unknown): TranslationKeys {
  if (error instanceof Error && 'code' in error) {
    if (error.code === 'disabled') return 'com_ui_discord_dm_disabled';
    if (error.code === 'capacity') return 'com_ui_discord_dm_capacity';
    if (['changed', 'unavailable', 'forbidden'].includes(String(error.code)))
      return 'com_ui_discord_dm_changed';
  }
  return 'com_ui_discord_error';
}

/** The selection UI and its temporary code belong to one signed-in principal. */
export default function Dm({ principalKey }: { principalKey: string }) {
  return (
    <Provider key={principalKey}>
      <Selections principalKey={principalKey} />
    </Provider>
  );
}

function Code({ link, principalKey }: { link: ChannelLinkView; principalKey: string }) {
  const localize = useLocalize();
  const id = useId();
  const client = useQueryClient();
  const mounted = useRef(false);
  const codeInput = useRef<HTMLInputElement>(null);
  const [code, setCode] = useAtom(codeAtom);
  const [expired, setExpired] = useAtom(expiredAtom);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const copyCode = useCopyToClipboard({ text: code?.code });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      setCode(null);
      setExpired(false);
    };
  }, [setCode, setExpired]);
  useEffect(() => {
    if (!code) return;
    codeInput.current?.focus();
    const timer = setTimeout(
      () => {
        setCode(null);
        setExpired(true);
      },
      Math.max(0, code.expiresAtMs - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [code, setCode, setExpired]);
  const cancelReads = () => client.cancelQueries([QueryKeys.channelLinks, principalKey]);
  const issue = useMutation({
    mutationKey: [MutationKeys.discordDmSelections, principalKey, 'issue'],
    retry: false,
    // Return no secret to React Query: only this mounted, scoped store receives the code.
    mutationFn: async () => {
      const result = await dataService.issueDiscordDmCode({
        linkId: link.linkId,
        expectedLinkRevision: link.revision,
      });
      if (mounted.current) setCode(result);
    },
    onMutate: async () => {
      setCode(null);
      setExpired(false);
      setCopied(false);
      setCopyFailed(false);
      await cancelReads();
    },
    onError: cancelReads,
    onSettled: async () => {
      await cancelReads();
      await client.invalidateQueries([QueryKeys.channelLinks, principalKey]);
    },
  });
  return (
    <div className="space-y-3">
      <p className="text-sm">
        <LinkAgentName agentId={link.identity.agentId} />
      </p>
      {link.identity.provider === 'discord' && (
        <details className="text-text-secondary text-xs">
          <summary className="cursor-pointer">{localize('com_ui_channel_link_details')}</summary>
          <p className="mt-2 break-all">
            {localize('com_ui_channel_link_discord_ids', {
              0: link.identity.externalUserId,
              1: localize('com_ui_discord_binding_server_named', {
                0: link.identity.guildId,
                1: link.identity.applicationId,
              }),
            })}
          </p>
        </details>
      )}
      <p className="text-text-secondary text-sm">{localize('com_ui_discord_dm_code_help')}</p>
      {issue.isError && <Alert variant="error">{localize(errorKey(issue.error))}</Alert>}
      {expired && <p role="status">{localize('com_ui_discord_dm_code_expired')}</p>}
      {code && (
        <div role="status" className="space-y-2">
          <Label htmlFor={`${id}-code`}>{localize('com_ui_discord_dm_code')}</Label>
          <div className="flex items-center gap-2">
            <Input
              ref={codeInput}
              id={`${id}-code`}
              value={code.code}
              readOnly
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1"
              onFocus={(event) => event.currentTarget.select()}
              aria-describedby={`${id}-expires`}
            />
            <Button
              type="button"
              variant="ghost"
              className="shrink-0"
              onClick={() => {
                setCopied(false);
                setCopyFailed(!copyCode(setCopied));
              }}
            >
              {localize(copied ? 'com_ui_copied' : 'com_ui_discord_dm_copy_code')}
            </Button>
          </div>
          <p id={`${id}-expires`} className="text-text-secondary text-xs">
            {localize('com_ui_discord_dm_expires', {
              0: new Date(code.expiresAtMs).toLocaleString(),
            })}
          </p>
          {copied && (
            <span role="status" className="sr-only">
              {localize('com_ui_copied')}
            </span>
          )}
          {copyFailed && (
            <Alert variant="warning">{localize('com_ui_channel_handoff_copy_failed')}</Alert>
          )}
        </div>
      )}
      {!code && (
        <Button
          type="button"
          variant="submit"
          disabled={issue.isLoading}
          aria-busy={issue.isLoading}
          onClick={() => issue.mutate()}
        >
          {issue.isLoading && <Spinner className="size-4" />}
          {localize('com_ui_discord_dm_generate')}
        </Button>
      )}
    </div>
  );
}

function Selections({ principalKey }: { principalKey: string }) {
  const localize = useLocalize();
  const id = useId();
  const client = useQueryClient();
  const heading = useRef<HTMLHeadingElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const failedNext = useRef(false);
  const [editor, setEditor] = useAtom(editorAtom);
  const [confirm, setConfirm] = useAtom(confirmAtom);
  const key = [QueryKeys.discordDmSelections, principalKey];
  const busy = useIsMutating({ mutationKey: [MutationKeys.discordDmSelections, principalKey] }) > 0;
  const selections = useInfiniteQuery(
    key,
    async ({ pageParam }: { pageParam?: string }) => {
      try {
        const page = await dataService.listDiscordDmSelections(pageParam);
        failedNext.current = false;
        return page;
      } catch (error) {
        failedNext.current = Boolean(pageParam);
        throw error;
      }
    },
    { enabled: !busy, retry: false, cacheTime: 0, getNextPageParam: (page) => page.next },
  );
  const links = useQuery(
    [QueryKeys.channelLinks, principalKey],
    () => dataService.channelIdentityClient.list(),
    { retry: false, cacheTime: 0, enabled: !busy },
  );
  const cancelReads = () => client.cancelQueries(key);
  const revoke = useMutation({
    mutationKey: [MutationKeys.discordDmSelections, principalKey, 'revoke'],
    mutationFn: (selection: DiscordDmSelectionView) =>
      dataService.revokeDiscordDmSelection({
        selectionId: selection.selectionId,
        revision: selection.revision,
      }),
    retry: false,
    onMutate: cancelReads,
    onError: cancelReads,
    onSuccess: () => setConfirm(null),
    onSettled: async () => {
      await cancelReads();
      await client.invalidateQueries(key);
    },
  });
  const enabled = selections.data?.pages[0]?.enabled === true && !selections.isError;
  const active = links.isError
    ? []
    : (links.data?.filter(
        (link) => link.identity.provider === 'discord' && link.state === 'active',
      ) ?? []);
  const rows = selections.data?.pages.flatMap((page) => page.selections) ?? [];
  const restoreFocus = (event: Event) => {
    event.preventDefault();
    if (trigger.current?.isConnected) trigger.current.focus();
    else heading.current?.focus();
  };
  // Nothing to show or revoke while new selections are off: stay out of the way.
  if (selections.isSuccess && !enabled && rows.length === 0) return null;
  return (
    <section className="space-y-3" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`} ref={heading} tabIndex={-1} className="text-sm font-semibold">
        {localize('com_ui_discord_dm_title')}
      </h3>
      <p className="text-text-secondary text-sm">{localize('com_ui_discord_dm_description')}</p>
      {selections.isLoading && (
        <div role="status">
          <Spinner className="size-4" />
          {localize('com_ui_channel_link_loading')}
        </div>
      )}
      {selections.isError && (
        <div className="space-y-2">
          <Alert variant="error">{localize('com_ui_discord_error')}</Alert>
          <Button
            type="button"
            variant="outline"
            disabled={busy || selections.isFetching}
            onClick={() =>
              void (failedNext.current ? selections.fetchNextPage() : selections.refetch())
            }
          >
            {localize('com_ui_retry')}
          </Button>
        </div>
      )}
      {selections.data && !enabled && !selections.isError && (
        <p role="status" className="text-text-secondary text-sm">
          {localize('com_ui_discord_dm_disabled')}
        </p>
      )}
      {enabled && links.isError && (
        <div>
          <Alert variant="error">{localize('com_ui_channel_link_error')}</Alert>
          <Button type="button" variant="outline" onClick={() => void links.refetch()}>
            {localize('com_ui_retry')}
          </Button>
        </div>
      )}
      {enabled && links.isSuccess && active.length === 0 && (
        <p className="text-text-secondary text-sm">{localize('com_ui_discord_dm_link_first')}</p>
      )}
      {enabled && active.length > 0 && (
        <ul className="space-y-2">
          {active.map((link) => (
            <li key={link.linkId} className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 text-sm">
                <LinkAgentName agentId={link.identity.agentId} />
                <p className="text-text-secondary text-xs break-all">
                  {localize('com_ui_channel_link_discord_ids', {
                    0: link.identity.externalUserId,
                    1:
                      link.identity.provider === 'discord'
                        ? localize('com_ui_discord_binding_server_named', {
                            0: link.identity.guildId,
                            1: link.identity.applicationId,
                          })
                        : '',
                  })}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                aria-label={localize('com_ui_discord_dm_select_for', {
                  0: link.identity.agentId,
                  1: link.identity.externalUserId,
                  2:
                    link.identity.provider === 'discord'
                      ? localize('com_ui_discord_binding_server_named', {
                          0: link.identity.guildId,
                          1: link.identity.applicationId,
                        })
                      : '',
                })}
                onClick={(event) => {
                  trigger.current = event.currentTarget;
                  setEditor(link);
                }}
              >
                {localize('com_ui_discord_dm_select')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ul className="space-y-2">
        {rows.map((selection) => (
          <li
            key={selection.selectionId}
            className="flex flex-wrap items-center justify-between gap-2"
          >
            <div className="min-w-0 text-sm">
              <LinkAgentName agentId={selection.agentId} />
              <p className="text-text-secondary text-xs break-all">
                {localize('com_ui_discord_dm_destination', { 0: selection.dmChannelId })}
              </p>
              <p role="status">{localize(states[selection.state])}</p>
              <p className="text-text-secondary text-xs">
                {localize('com_ui_discord_dm_expires', {
                  0: new Date(selection.expiresAtMs).toLocaleString(),
                })}
              </p>
            </div>
            {selection.state !== 'revoked' && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                aria-label={localize('com_ui_discord_dm_revoke_for', {
                  0: selection.agentId,
                  1: selection.dmChannelId,
                })}
                onClick={(event) => {
                  trigger.current = event.currentTarget;
                  revoke.reset();
                  setConfirm(selection);
                }}
              >
                {localize('com_ui_discord_dm_revoke')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {selections.hasNextPage && (
        <Button
          type="button"
          variant="outline"
          disabled={busy || selections.isFetching}
          onClick={() => void selections.fetchNextPage()}
        >
          {localize('com_ui_load_more')}
        </Button>
      )}
      <OGDialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
        triggerRef={trigger}
      >
        <OGDialogTemplate
          title={localize('com_ui_discord_dm_select')}
          description={localize('com_ui_discord_dm_confirmation')}
          className="max-w-md"
          onCloseAutoFocus={restoreFocus}
          main={
            editor ? (
              <Provider key={`${editor.linkId}:${editor.revision}`}>
                <Code link={editor} principalKey={principalKey} />
              </Provider>
            ) : null
          }
        />
      </OGDialog>
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !revoke.isLoading) setConfirm(null);
        }}
      >
        <AlertDialogContent className="w-11/12 max-w-md" onCloseAutoFocus={restoreFocus}>
          <AlertDialogHeader>
            <AlertDialogTitle>{localize('com_ui_discord_dm_revoke')}</AlertDialogTitle>
            <AlertDialogDescription>
              {localize('com_ui_discord_dm_revoke_help')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {revoke.isError && <Alert variant="error">{localize(errorKey(revoke.error))}</Alert>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoke.isLoading}>
              {localize('com_ui_cancel')}
            </AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={!confirm || revoke.isLoading}
              aria-busy={revoke.isLoading}
              onClick={() => {
                if (confirm) revoke.mutate(confirm);
              }}
            >
              {localize('com_ui_discord_dm_revoke')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

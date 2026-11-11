import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, OGDialog, OGDialogTemplate, Spinner } from '@librechat/client';
import { dataService, MutationKeys, PrincipalType, QueryKeys } from 'librechat-data-provider';
import type { SlackWorkspace, SlackBotManager } from 'librechat-data-provider';
import PeoplePickerSearchItem from '~/components/Sharing/PeoplePicker/PeoplePickerSearchItem';
import { SearchPicker } from '~/components/Sharing/PeoplePicker/SearchPicker';
import PrincipalAvatar from '~/components/Sharing/PrincipalAvatar';
import { useLocalize } from '~/hooks';

function ManagerSearch({
  workspaceId,
  principalKey,
  managers,
  onAdd,
}: {
  workspaceId: string;
  principalKey: string;
  managers: SlackBotManager[];
  onAdd: (manager: SlackBotManager) => void;
}) {
  const localize = useLocalize();
  const [input, setInput] = useState('');
  const query = input.trim();
  const search = useQuery(
    [QueryKeys.slackWorkspaces, principalKey, 'managerSearch', workspaceId, query],
    () => dataService.searchSlackBotManagers(workspaceId, query),
    { enabled: query.length >= 2, retry: false, cacheTime: 0, refetchOnWindowFocus: false },
  );
  const selected = new Set(managers.map((manager) => manager.id));
  return (
    <div className="space-y-2">
      <SearchPicker
        label={localize('com_ui_slack_bot_managers_search')}
        placeholder={localize('com_ui_slack_bot_managers_search')}
        options={(search.data ?? [])
          .filter((manager) => !selected.has(manager.id))
          .map((manager) => ({ ...manager, key: manager.id, value: manager.id }))}
        renderOptions={(manager) => (
          <PeoplePickerSearchItem principal={{ ...manager, type: PrincipalType.USER }} />
        )}
        query={input}
        onQueryChange={setInput}
        onPick={onAdd}
        isLoading={search.isFetching}
        minQueryLengthForNoResults={search.isError ? Infinity : 2}
      />
      {search.isError && (
        <Alert variant="error">
          <p>{localize('com_ui_slack_bot_managers_search_error')}</p>
          <Button
            type="button"
            variant="outline"
            disabled={search.isFetching}
            onClick={() => void search.refetch()}
          >
            {localize('com_ui_retry')}
          </Button>
        </Alert>
      )}
    </div>
  );
}

/** Installation admins grant management; managers never receive credentials or sharing authority. */
export default function BotManagers({
  workspace,
  principalKey,
  disabled,
}: {
  workspace: SlackWorkspace;
  principalKey: string;
  disabled: boolean;
}) {
  const localize = useLocalize();
  const client = useQueryClient();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [managers, setManagers] = useState<SlackBotManager[]>([]);
  const query = useQuery(
    [QueryKeys.slackWorkspaces, principalKey, 'managers', workspace.workspaceId],
    () => dataService.getSlackBotManagers(workspace.workspaceId),
    {
      enabled: open,
      retry: false,
      cacheTime: 0,
      refetchOnWindowFocus: false,
      onSuccess: (data) => setManagers(data.managers),
    },
  );
  const mutation = useMutation({
    mutationKey: [MutationKeys.slackWorkspaces, principalKey, 'managers', workspace.workspaceId],
    mutationFn: () => {
      if (!open || !query.isSuccess || !query.data) throw new Error('Bot management unavailable');
      return dataService.setSlackBotManagers(
        workspace.workspaceId,
        query.data.revision,
        managers.map((manager) => manager.id),
      );
    },
    onSuccess: async () => {
      await client.invalidateQueries([QueryKeys.slackWorkspaces, principalKey]);
      setOpen(false);
    },
  });
  const ids = managers.map((manager) => manager.id).sort();
  const initialIds = query.data?.managers.map((manager) => manager.id).sort();
  const changed = JSON.stringify(ids) !== JSON.stringify(initialIds);
  const tooMany = Boolean(query.data && managers.length > query.data.maxManagers);
  return (
    <>
      <Button
        ref={trigger}
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={() => {
          mutation.reset();
          setOpen(true);
        }}
      >
        {localize('com_ui_slack_bot_managers')}
      </Button>
      <OGDialog
        open={open}
        onOpenChange={(value) => {
          if (!mutation.isLoading) setOpen(value);
        }}
      >
        <OGDialogTemplate
          className="max-w-lg"
          headerClassName="break-words"
          footerClassName="sm:justify-between"
          title={localize('com_ui_slack_bot_managers')}
          description={workspace.teamName}
          cancelDisabled={mutation.isLoading}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
          main={
            <div className="space-y-4 text-sm">
              <p className="text-text-secondary">
                {localize('com_ui_slack_bot_managers_description')}
              </p>
              {query.isFetching && <Spinner className="size-5" />}
              {(query.isError || mutation.isError) && (
                <Alert variant="error">
                  <p>{localize('com_ui_slack_bot_managers_error')}</p>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={query.isFetching || mutation.isLoading}
                    onClick={() => {
                      mutation.reset();
                      void query.refetch();
                    }}
                  >
                    {localize('com_ui_slack_bot_managers_reload')}
                  </Button>
                </Alert>
              )}
              {query.isSuccess && !query.isFetching && (
                <>
                  {!mutation.isLoading && (
                    <ManagerSearch
                      workspaceId={workspace.workspaceId}
                      principalKey={principalKey}
                      managers={managers}
                      onAdd={(manager) =>
                        setManagers((current) =>
                          current.some((person) => person.id === manager.id)
                            ? current
                            : [...current, manager],
                        )
                      }
                    />
                  )}
                  {managers.length === 0 && (
                    <p className="text-text-secondary">
                      {localize('com_ui_slack_bot_managers_empty')}
                    </p>
                  )}
                  {managers.map((manager) => (
                    <div
                      key={manager.id}
                      className="border-border-light flex items-center justify-between gap-3 rounded-lg border p-3"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <PrincipalAvatar
                          principal={{ ...manager, type: PrincipalType.USER }}
                          size="sm"
                        />
                        <div className="min-w-0">
                          <p className="truncate font-medium">{manager.name || manager.email}</p>
                          {manager.name && (
                            <p className="text-text-secondary truncate text-xs">{manager.email}</p>
                          )}
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="section-action"
                        size="compact"
                        disabled={mutation.isLoading}
                        aria-label={localize('com_ui_slack_bot_managers_remove', {
                          0: manager.name || manager.email,
                        })}
                        onClick={() =>
                          setManagers((current) =>
                            current.filter((person) => person.id !== manager.id),
                          )
                        }
                      >
                        {localize('com_nav_tool_remove')}
                      </Button>
                    </div>
                  ))}
                  <p className="text-text-secondary">
                    {localize('com_ui_slack_bot_managers_revocation')}
                  </p>
                  {tooMany && (
                    <Alert variant="warning">
                      {localize('com_ui_slack_bot_managers_limit', { 0: query.data.maxManagers })}
                    </Alert>
                  )}
                </>
              )}
            </div>
          }
          selection={
            <Button
              type="button"
              disabled={
                disabled ||
                !query.isSuccess ||
                query.isFetching ||
                mutation.isLoading ||
                mutation.isError ||
                !changed ||
                tooMany
              }
              aria-busy={mutation.isLoading}
              onClick={() => mutation.mutate()}
            >
              {mutation.isLoading && <Spinner className="size-4" aria-hidden="true" />}
              {localize('com_ui_save')}
            </Button>
          }
        />
      </OGDialog>
    </>
  );
}

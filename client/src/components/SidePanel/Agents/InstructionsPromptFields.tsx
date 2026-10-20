import { useMemo } from 'react';
import { Controller, useFormContext } from 'react-hook-form';
import { Button, Label, ControlCombobox } from '@librechat/client';
import type {
  TPromptGroupSource,
  LangfuseAgentInstructionsPromptSelection,
} from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { PromptRevisionSelection } from './instructionsPromptUtils';
import type { TranslationKeys } from '~/hooks';
import type { AgentForm } from '~/common';
import {
  buildPromptVersionOptions,
  isRestrictedInstructionsPrompt,
  getRevisionsLoadErrorKey,
  isLangfuseSelection,
  selectionValue,
  getHttpStatus,
} from './instructionsPromptUtils';
import { useGetAllPromptGroups, useGetPromptGroupRevisions } from '~/data-provider';
import { useAgentPanelContext } from '~/Providers/AgentPanelContext';
import { PromptSourceBadge } from '~/components/Prompts/display';
import { useLocalize } from '~/hooks';

export const fieldWrapperClass =
  'flex h-9 items-center rounded-lg border border-border-light bg-surface-secondary px-3 text-sm text-text-secondary';

export function LoadError({
  forbidden,
  messageKey,
  onRetry,
  retrying,
}: {
  forbidden?: boolean;
  /** Overrides the forbidden/generic choice below with a specific copy key,
   *  for a caller (the Version dropdown) that distinguishes more failure
   *  shapes than a plain forbidden/other split. */
  messageKey?: TranslationKeys;
  onRetry: () => void;
  /** Disables Retry while the same query is already fetching, so a repeated
   *  click does nothing instead of queuing a duplicate request, and the
   *  button itself gives feedback that a retry is in flight. */
  retrying?: boolean;
}) {
  const localize = useLocalize();
  const resolvedKey: TranslationKeys =
    messageKey ??
    (forbidden
      ? 'com_agents_instructions_prompt_forbidden'
      : 'com_agents_instructions_prompt_load_error');
  /** No Retry for a forbidden result, whether it came from the plain
   *  `forbidden` flag or a caller-chosen `messageKey` that resolves to the
   *  same forbidden copy (the Version dropdown's 403 case): retrying a
   *  permission failure cannot succeed. */
  const showRetry = resolvedKey !== 'com_agents_instructions_prompt_forbidden';
  return (
    <div className="border-border-light bg-surface-secondary text-text-secondary flex flex-col gap-1.5 rounded-lg border px-3 py-2 text-sm">
      <span role="alert">{localize(resolvedKey)}</span>
      {showRetry && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={onRetry}
          disabled={retrying}
        >
          {localize('com_ui_retry')}
        </Button>
      )}
    </div>
  );
}

/** Labels a disabled Langfuse link's saved selection with no revision fetch:
 *  "Production" or "Version N" straight off the stored selection, since a
 *  pinned Langfuse version is already the display number. Only ever called
 *  for a Langfuse link (the switch-off case), so the selection carries just
 *  the Langfuse `production | exact` shape. */
function formatDisabledVersionLabel(
  selection: LangfuseAgentInstructionsPromptSelection | undefined,
  localize: (key: TranslationKeys, vars?: Record<string, unknown>) => string,
): string {
  if (selection == null || selection.type === 'production') {
    return localize('com_ui_production');
  }
  return localize('com_ui_version_var', { 0: String(selection.version) });
}

function VersionSelect({
  groupId,
  source,
  selection,
  onSelect,
  disabled,
}: {
  groupId: string;
  /** The linked group's source, used to tell the two `exact` selection shapes apart. */
  source?: TPromptGroupSource;
  selection?: PromptRevisionSelection;
  onSelect: (selection: PromptRevisionSelection) => void;
  /** True for a saved Langfuse link while the switch is off: no revisions are
   *  fetched, and the saved selection is shown as plain text. */
  disabled?: boolean;
}) {
  const localize = useLocalize();
  const revisionsQuery = useGetPromptGroupRevisions(groupId, {
    enabled: groupId !== '' && !disabled,
  });
  const revisionsData = revisionsQuery.data;
  const options = useMemo(
    () =>
      revisionsData != null && Array.isArray(revisionsData.revisions)
        ? buildPromptVersionOptions(revisionsData, selection, localize)
        : [],
    [revisionsData, selection, localize],
  );
  const selectedValue = selectionValue(source, selection);
  const selectedOption = options.find((option) => option.value === selectedValue);

  let content: ReactNode;
  if (groupId === '') {
    content = (
      <div className={fieldWrapperClass}>
        {localize('com_agents_instructions_prompt_version_placeholder')}
      </div>
    );
  } else if (disabled) {
    /** `disabled` is only ever true for a Langfuse link (the switch-off case), so the
     *  saved selection can never carry the native `exact` shape (a `promptId` field)
     *  here; this narrows the type accordingly rather than handling a case that
     *  cannot occur. */
    const langfuseSelection = isLangfuseSelection(selection) ? selection : undefined;
    content = (
      <div className={fieldWrapperClass}>
        {formatDisabledVersionLabel(langfuseSelection, localize)}
      </div>
    );
  } else if (revisionsQuery.isLoading) {
    content = <div className={fieldWrapperClass}>{localize('com_ui_loading')}</div>;
  } else if (
    revisionsQuery.isError ||
    revisionsData == null ||
    !Array.isArray(revisionsData.revisions)
  ) {
    /** A malformed 200 (missing `revisions`, e.g. a permission failure that does
     *  not reach `isError`) is treated the same as a load failure, never as an
     *  empty revision list. */
    content = (
      <LoadError
        messageKey={getRevisionsLoadErrorKey(revisionsQuery.error)}
        onRetry={() => revisionsQuery.refetch()}
        retrying={revisionsQuery.isFetching}
      />
    );
  } else if (revisionsData.revisions.length === 0) {
    content = (
      <div className={fieldWrapperClass}>{localize('com_agents_instructions_prompt_empty')}</div>
    );
  } else {
    content = (
      <ControlCombobox
        selectId="instructions-prompt-version"
        selectedValue={selectedValue}
        displayValue={selectedOption?.label ?? ''}
        selectPlaceholder={localize('com_agents_instructions_prompt_version_select_placeholder')}
        setValue={(value) => {
          const option = options.find((item) => item.value === value);
          if (option) {
            onSelect(option.selection);
          }
        }}
        items={options}
        ariaLabel={localize('com_agents_instructions_prompt_version_label')}
        isCollapsed={false}
        showCarat={true}
        variant="field"
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col">
      <Label id="instructions-prompt-version-label" variant="section" className="mb-1 block">
        {localize('com_agents_instructions_prompt_version_label')}
      </Label>
      {/* `aria-labelledby`, not `htmlFor`, because the loading/error/empty/disabled
       * states render a plain `div`, not the combobox `id` a `for` would need to target. */}
      <div role="group" aria-labelledby="instructions-prompt-version-label">
        {content}
      </div>
    </div>
  );
}

/**
 * Prompt + Version dropdown row shown in "Prompt" instructions mode. Reads and
 * writes the whole `instructionsPrompt` link through a single Controller, since
 * the two dropdowns jointly determine one value.
 */
export default function InstructionsPromptFields() {
  const localize = useLocalize();
  const { control } = useFormContext<AgentForm>();
  const { agentsConfig } = useAgentPanelContext();
  const langfuseEnabled = agentsConfig?.linkedInstructions?.langfuse?.enabled === true;
  const groupsQuery = useGetAllPromptGroups();
  /** The endpoint can answer a 200 with `{ message }` instead of an array (for example, on
   *  a permission failure that does not reach `isError`); treat that the same as a load
   *  failure rather than an empty prompt library. */
  const groupsData = groupsQuery.data;
  const groupsFailed = groupsQuery.isError || !Array.isArray(groupsData);
  const groups = Array.isArray(groupsData) ? groupsData : [];

  return (
    <Controller
      name="instructionsPrompt"
      control={control}
      rules={{
        validate: (value, formValues) => {
          if (formValues.instructionsSource !== 'prompt') {
            return true;
          }
          if (isRestrictedInstructionsPrompt(value)) {
            return true;
          }
          return Boolean(value?.groupId) || localize('com_agents_instructions_prompt_required');
        },
      }}
      render={({ field, fieldState: { error } }) => {
        const link =
          field.value != null && !isRestrictedInstructionsPrompt(field.value) ? field.value : null;
        const groupId = link?.groupId ?? '';
        const selectedGroup = groups.find((group) => group._id === groupId);
        /** The link's source: the picked group's own source once one is loaded, falling
         *  back to the existing link's source when the group is missing from the listing
         *  (deleted, or the editor's share access was revoked). Disambiguates the two
         *  `exact` selection shapes below, which share the same `type` literal. */
        const linkSource: TPromptGroupSource | undefined = selectedGroup?.source ?? link?.source;
        /** A link that survived loading but matches no listed group: the group was
         *  deleted, or the editor's share access to it was revoked. */
        const linkedGroupMissing = groupId !== '' && !groupsFailed && selectedGroup == null;
        /** A saved Langfuse link while the switch is off: still shown (never hidden or
         *  dropped for inline text), but read-only until the switch is on again. */
        const isDisabledLangfuseLink = !langfuseEnabled && linkSource === 'langfuse';
        /** Langfuse groups disappear from the picker while the switch is off, except the
         *  one already linked, which stays visible so its name and badge keep showing. */
        const visibleGroups = langfuseEnabled
          ? groups
          : groups.filter((group) => group.source !== 'langfuse' || group._id === groupId);
        /** The stub carries no `groupId`, so the dropdown's current value comes from
         *  this label, never from a group name: nothing here reads identity off it. */
        const groupDisplayValue = isRestrictedInstructionsPrompt(field.value)
          ? localize('com_agents_instructions_prompt_restricted_title')
          : (selectedGroup?.name ?? '');

        const handleGroupChange = (nextGroupId: string) => {
          if (nextGroupId === '') {
            field.onChange(null);
            return;
          }
          /** Re-picking the already-linked group (for example, choosing the same
           *  disabled Langfuse group again from the combobox) must keep the saved
           *  selection rather than resetting it to Production: the server rejects a
           *  write that changes a pinned, currently-unavailable Langfuse link. */
          if (link != null && nextGroupId === link.groupId) {
            return;
          }
          const nextGroup = groups.find((group) => group._id === nextGroupId);
          const nextSource: TPromptGroupSource | undefined = nextGroup?.source ?? link?.source;
          if (nextSource == null) {
            return;
          }
          field.onChange(
            nextSource === 'langfuse'
              ? { source: 'langfuse', groupId: nextGroupId, selection: { type: 'production' } }
              : { source: 'native', groupId: nextGroupId, selection: { type: 'production' } },
          );
        };

        let groupField: ReactNode;
        if (groupsQuery.isLoading) {
          groupField = <div className={fieldWrapperClass}>{localize('com_ui_loading')}</div>;
        } else if (groupsFailed) {
          groupField = (
            <LoadError
              forbidden={getHttpStatus(groupsQuery.error) === 403}
              onRetry={() => groupsQuery.refetch()}
            />
          );
        } else if (visibleGroups.length === 0) {
          groupField = (
            <div className={fieldWrapperClass}>
              {localize('com_agents_instructions_prompt_empty')}
            </div>
          );
        } else {
          /** A missing link still gets the combobox, not just the hint below it: the
           *  backend allows removing or replacing a link to a deleted group, so the user
           *  needs a way to pick a replacement (or switch to Inline) rather than being
           *  stuck with prose and no control. */
          groupField = (
            <ControlCombobox
              selectId="instructions-prompt-group"
              selectedValue={groupId}
              displayValue={groupDisplayValue}
              selectPlaceholder={localize('com_agents_instructions_prompt_select_placeholder')}
              searchPlaceholder={localize('com_agents_instructions_prompt_search_placeholder')}
              setValue={handleGroupChange}
              items={visibleGroups.map((group) => ({
                label: group.name,
                value: group._id ?? '',
                /** Non-interactive: this icon sits inside an Ariakit `SelectItem` option
                 *  label, itself already interactive, so the focusable tooltip form would
                 *  nest a second focusable element inside it. */
                icon: <PromptSourceBadge source={group.source} interactive={false} />,
              }))}
              SelectIcon={
                selectedGroup?.source === 'langfuse' ? (
                  /** Non-interactive for the same reason: this renders inside the Select's
                   *  own trigger button. */
                  <PromptSourceBadge source="langfuse" interactive={false} />
                ) : undefined
              }
              ariaLabel={localize('com_ui_prompt')}
              isCollapsed={false}
              showCarat={true}
              variant="field"
            />
          );
        }

        return (
          <div className="grid grid-cols-2 gap-2">
            <div className="flex min-w-0 flex-col">
              <Label id="instructions-prompt-group-label" variant="section" className="mb-1 block">
                {localize('com_ui_prompt')}
              </Label>
              {/* `aria-labelledby`, not `htmlFor`: the loading/error/empty
               * states render a plain `div`, not the combobox `id` a `for` would need. */}
              <div role="group" aria-labelledby="instructions-prompt-group-label">
                {groupField}
              </div>
              {linkedGroupMissing && (
                <span
                  className="text-text-secondary mt-1 text-xs transition duration-300 ease-in-out"
                  role="note"
                >
                  {localize('com_agents_instructions_prompt_not_found')}
                </span>
              )}
              {isDisabledLangfuseLink && (
                <span
                  className="text-text-secondary mt-1 text-xs transition duration-300 ease-in-out"
                  role="note"
                >
                  {localize('com_agents_instructions_prompt_source_disabled')}
                </span>
              )}
              {error && (
                <span
                  className="text-text-destructive mt-1 text-xs transition duration-300 ease-in-out"
                  role="alert"
                >
                  {error.message}
                </span>
              )}
            </div>
            <VersionSelect
              groupId={groupId}
              source={linkSource}
              selection={link?.selection}
              disabled={isDisabledLangfuseLink}
              onSelect={(selection) => {
                if (groupId === '') {
                  return;
                }
                /** The two `exact` shapes share a `type` literal but never a field: a
                 *  `promptId` selection only ever fits a native link, a `version`
                 *  selection only ever fits a Langfuse one. */
                if (linkSource === 'langfuse') {
                  if ('promptId' in selection) {
                    return;
                  }
                  field.onChange({ source: 'langfuse', groupId, selection });
                } else if (linkSource === 'native') {
                  if ('version' in selection) {
                    return;
                  }
                  field.onChange({ source: 'native', groupId, selection });
                }
              }}
            />
          </div>
        );
      }}
    />
  );
}

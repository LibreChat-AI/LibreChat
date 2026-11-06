import { useMemo } from 'react';
import { Controller, useFormContext } from 'react-hook-form';
import { Button, Label, ControlCombobox } from '@librechat/client';
import type {
  PromptSelection,
  TPromptGroupSource,
  LangfuseAgentInstructionsPromptSelection,
} from 'librechat-data-provider';
import type { ReactNode } from 'react';
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
  /** Overrides the forbidden/generic choice below with a specific copy key. */
  messageKey?: TranslationKeys;
  onRetry: () => void;
  retrying?: boolean;
}) {
  const localize = useLocalize();
  const resolvedKey: TranslationKeys =
    messageKey ??
    (forbidden
      ? 'com_agents_instructions_prompt_forbidden'
      : 'com_agents_instructions_prompt_load_error');
  // Retrying a permission failure cannot succeed.
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
          onClick={() => {
            // aria-disabled, not disabled: keeps focus on the button while a retry is in flight.
            if (retrying) {
              return;
            }
            onRetry();
          }}
          aria-disabled={retrying}
        >
          {localize('com_ui_retry')}
        </Button>
      )}
    </div>
  );
}

/** Labels a disabled Langfuse link's saved selection without fetching revisions. */
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
  source?: TPromptGroupSource;
  selection?: PromptSelection;
  onSelect: (selection: PromptSelection) => void;
  /** True for a saved Langfuse link while the switch is off. */
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
    // `disabled` implies a Langfuse link, so the selection is always the Langfuse shape.
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
    // A malformed 200 (missing `revisions`) is treated as a load failure, not an empty list.
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
      {/* `aria-labelledby`, not `htmlFor`: no state here renders a labelable control. */}
      <div role="group" aria-labelledby="instructions-prompt-version-label">
        {content}
      </div>
    </div>
  );
}

export default function InstructionsPromptFields() {
  const localize = useLocalize();
  const { control, formState } = useFormContext<AgentForm>();
  const { agentsConfig } = useAgentPanelContext();
  const langfuseEnabled = agentsConfig?.linkedInstructions?.langfuse?.enabled === true;
  const groupsQuery = useGetAllPromptGroups();
  // A 200 with `{ message }` instead of an array is a load failure, not an empty library.
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
        // Falls back to the link's own source when the group is missing from the listing.
        const linkSource: TPromptGroupSource | undefined = selectedGroup?.source ?? link?.source;
        const linkedGroupMissing = groupId !== '' && !groupsFailed && selectedGroup == null;
        const isDisabledLangfuseLink = !langfuseEnabled && linkSource === 'langfuse';
        // Keyed off the saved link, not the live form value: the live groupId moves to the
        // newly picked group as soon as the user changes it, which would otherwise drop the
        // saved Langfuse group from the list on the very selection meant to keep it visible.
        const savedInstructionsPrompt = formState.defaultValues?.instructionsPrompt;
        const savedGroupId =
          savedInstructionsPrompt != null && 'groupId' in savedInstructionsPrompt
            ? savedInstructionsPrompt.groupId
            : undefined;
        const visibleGroups = langfuseEnabled
          ? groups
          : groups.filter((group) => group.source !== 'langfuse' || group._id === savedGroupId);
        // A restricted stub has no `groupId`, so the display value comes from this label.
        const groupDisplayValue = isRestrictedInstructionsPrompt(field.value)
          ? localize('com_agents_instructions_prompt_restricted_title')
          : (selectedGroup?.name ?? '');

        const handleGroupChange = (nextGroupId: string) => {
          if (nextGroupId === '') {
            field.onChange(null);
            return;
          }
          // Keeps the saved selection: the server rejects a write that changes a pinned link.
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
          // A missing link still gets the combobox, so the user can pick a replacement.
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
                // Non-interactive: nests inside the already-interactive `SelectItem`.
                icon: <PromptSourceBadge source={group.source} interactive={false} />,
              }))}
              SelectIcon={
                selectedGroup?.source === 'langfuse' ? (
                  <PromptSourceBadge source="langfuse" interactive={false} />
                ) : undefined
              }
              iconSide="right"
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
              {/* `aria-labelledby`, not `htmlFor`: no state here renders a labelable control. */}
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
                // The two `exact` shapes share a `type` literal but differ by field.
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

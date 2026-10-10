import { useMemo } from 'react';
import { Controller, useFormContext } from 'react-hook-form';
import { Button, Label, ControlCombobox } from '@librechat/client';
import type { AgentInstructionsPromptSelection } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { AgentForm } from '~/common';
import {
  buildPromptVersionOptions,
  isRestrictedInstructionsPrompt,
  getHttpStatus,
} from './instructionsPromptUtils';
import { useGetAllPromptGroups, useGetPrompts } from '~/data-provider';
import { useLocalize } from '~/hooks';

export const fieldWrapperClass =
  'flex h-9 items-center rounded-lg border border-border-light bg-surface-secondary px-3 text-sm text-text-secondary';

export function LoadError({ forbidden, onRetry }: { forbidden: boolean; onRetry: () => void }) {
  const localize = useLocalize();
  return (
    <div className="border-border-light bg-surface-secondary text-text-secondary flex flex-col gap-1.5 rounded-lg border px-3 py-2 text-sm">
      <span role="alert">
        {forbidden
          ? localize('com_agents_instructions_prompt_forbidden')
          : localize('com_agents_instructions_prompt_load_error')}
      </span>
      {!forbidden && (
        <Button type="button" variant="outline" size="sm" className="w-fit" onClick={onRetry}>
          {localize('com_ui_retry')}
        </Button>
      )}
    </div>
  );
}

function VersionSelect({
  groupId,
  productionId,
  selection,
  onSelect,
}: {
  groupId: string;
  productionId?: string | null;
  selection?: AgentInstructionsPromptSelection;
  onSelect: (selection: AgentInstructionsPromptSelection) => void;
}) {
  const localize = useLocalize();
  const promptsQuery = useGetPrompts({ groupId }, { enabled: groupId !== '' });
  const promptsData = promptsQuery.data;
  const prompts = useMemo(() => (Array.isArray(promptsData) ? promptsData : []), [promptsData]);
  const options = useMemo(
    () => buildPromptVersionOptions(prompts, productionId, localize),
    [prompts, productionId, localize],
  );
  const selectedValue = selection?.type === 'exact' ? selection.promptId : 'production';
  const selectedOption = options.find((option) => option.value === selectedValue);

  let content: ReactNode;
  if (groupId === '') {
    content = (
      <div className={fieldWrapperClass}>
        {localize('com_agents_instructions_prompt_version_placeholder')}
      </div>
    );
  } else if (promptsQuery.isLoading) {
    content = <div className={fieldWrapperClass}>{localize('com_ui_loading')}</div>;
  } else if (promptsQuery.isError || !Array.isArray(promptsQuery.data)) {
    content = (
      <LoadError
        forbidden={getHttpStatus(promptsQuery.error) === 403}
        onRetry={() => promptsQuery.refetch()}
      />
    );
  } else if (prompts.length === 0) {
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
      {/* `aria-labelledby`, not `htmlFor`, because the loading/error/empty states
       * render a plain `div`, not the combobox `id` a `for` would need to target. */}
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
        /** A link that survived loading but matches no listed group: the group was
         *  deleted, or the editor's share access to it was revoked. */
        const linkedGroupMissing = groupId !== '' && !groupsFailed && selectedGroup == null;
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
          field.onChange({
            source: 'native',
            groupId: nextGroupId,
            selection: { type: 'production' },
          });
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
        } else if (groups.length === 0) {
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
              items={groups.map((group) => ({ label: group.name, value: group._id ?? '' }))}
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
              productionId={selectedGroup?.productionId}
              selection={link?.selection}
              onSelect={(selection) => {
                if (groupId === '') {
                  return;
                }
                field.onChange({ source: 'native', groupId, selection });
              }}
            />
          </div>
        );
      }}
    />
  );
}

import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Constants } from 'librechat-data-provider';
import { Controller, useFormContext } from 'react-hook-form';
import { Input, Label, Button, TooltipAnchor } from '@librechat/client';
import type { AgentForm } from '~/common';
import { useLocalize } from '~/hooks';

const MAX_STARTER_LENGTH = 64;

function StartersField({
  value,
  onChange,
}: {
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const localize = useLocalize();
  const [draft, setDraft] = useState('');
  const hasReachedMax = value.length >= Constants.MAX_CONVO_STARTERS;
  const canAdd = !hasReachedMax && draft.trim() !== '';
  const addLabel = hasReachedMax
    ? localize('com_assistants_max_starters_reached')
    : localize('com_ui_add');

  const addStarter = () => {
    if (!canAdd) {
      return;
    }
    onChange([...value, draft.trim()]);
    setDraft('');
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        <Input
          id="conversation-starters"
          value={draft}
          maxLength={MAX_STARTER_LENGTH}
          disabled={hasReachedMax}
          className="h-9 flex-1"
          type="text"
          placeholder={
            hasReachedMax
              ? localize('com_assistants_max_starters_reached')
              : localize('com_assistants_conversation_starters_placeholder')
          }
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') {
              return;
            }
            /** Enter would otherwise submit the whole agent form */
            e.preventDefault();
            addStarter();
          }}
        />
        <TooltipAnchor
          side="top"
          description={addLabel}
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={addLabel}
              onClick={addStarter}
              disabled={!canAdd}
            >
              <Plus className="size-4" aria-hidden="true" />
            </Button>
          }
        />
      </div>
      {value.map((starter, index) => {
        const deleteLabel = `${localize('com_ui_delete')}: ${starter}`;
        return (
          <div key={index} className="relative">
            <Input
              value={starter}
              maxLength={MAX_STARTER_LENGTH}
              className="h-9 flex-1"
              type="text"
              aria-label={`${localize('com_assistants_conversation_starters')} ${index + 1}`}
              onChange={(e) => {
                const next = [...value];
                next[index] = e.target.value;
                onChange(next);
              }}
            />
            <TooltipAnchor
              side="top"
              description={localize('com_ui_delete')}
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={deleteLabel}
                  onClick={() => onChange(value.filter((_, i) => i !== index))}
                >
                  <X className="size-4" aria-hidden="true" />
                </Button>
              }
            />
          </div>
        );
      })}
    </div>
  );
}

export default function Starters() {
  const localize = useLocalize();
  const { control } = useFormContext<AgentForm>();

  return (
    <div className="mb-3 flex flex-col">
      <Label variant="section" className="mb-1 block" htmlFor="conversation-starters">
        {localize('com_assistants_conversation_starters')}
      </Label>
      <Controller
        name="conversation_starters"
        control={control}
        render={({ field }) => (
          <StartersField value={field.value ?? []} onChange={field.onChange} />
        )}
      />
    </div>
  );
}

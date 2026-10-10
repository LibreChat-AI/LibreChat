import { useId, useMemo } from 'react';
import { Label, Radio } from '@librechat/client';
import { Controller, useWatch, useFormContext } from 'react-hook-form';
import type { AgentForm } from '~/common';
import InstructionsPromptFields, { fieldWrapperClass, LoadError } from './InstructionsPromptFields';
import { isRestrictedInstructionsPrompt } from './instructionsPromptUtils';
import RestrictedInstructionsPrompt from './RestrictedInstructionsPrompt';
import { VariableEditor } from '~/components/Variables';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/** Status of the expanded agent query that `instructionsPrompt` arrives on. A
 * persisted agent's basic projection never carries `instructionsPrompt`, so this
 * section stays in a disabled loading (or error) state until the expanded query
 * resolves, rather than briefly reading the link as absent. */
export type InstructionsPromptStatus = 'ready' | 'loading' | 'error';

/** Two-way segmented toggle between the inline editor and a linked prompt group, matching the
 *  skills mode control so the section headers read as one set. */
function SourceToggle({ disabled = false }: { disabled?: boolean }) {
  const localize = useLocalize();
  const labelId = useId();
  const { control } = useFormContext<AgentForm>();
  const options = useMemo(
    () => [
      { value: 'inline', label: localize('com_agents_instructions_source_inline') },
      { value: 'prompt', label: localize('com_agents_instructions_source_prompt') },
    ],
    [localize],
  );

  return (
    <Controller
      name="instructionsSource"
      control={control}
      render={({ field }) => (
        <>
          <span id={labelId} className="sr-only">
            {localize('com_agents_instructions_source_toggle_aria')}
          </span>
          <Radio
            options={options}
            value={field.value}
            onChange={field.onChange}
            disabled={disabled}
            size="sm"
            aria-labelledby={labelId}
          />
        </>
      )}
    />
  );
}

export default function Instructions({
  promptStatus = 'ready',
  onRetryLoad,
}: {
  promptStatus?: InstructionsPromptStatus;
  onRetryLoad?: () => void;
}) {
  const localize = useLocalize();
  const { control } = useFormContext<AgentForm>();
  const instructionsSource = useWatch({ control, name: 'instructionsSource' });
  const instructionsPrompt = useWatch({ control, name: 'instructionsPrompt' });
  const restricted = isRestrictedInstructionsPrompt(instructionsPrompt);
  const isPromptMode = instructionsSource === 'prompt';
  const isReady = promptStatus === 'ready';

  return (
    <div className="mb-3 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <Label variant="section" data-testid="instructions-heading">
          {localize('com_ui_instructions')}
        </Label>
        <SourceToggle disabled={!isReady} />
      </div>

      {/* The expanded agent query (the only source of `instructionsPrompt`) has not
       * resolved yet: nothing here is derived from the basic projection, which would
       * otherwise read a linked agent as unlinked. The toggle stays disabled above so
       * a save cannot carry an instructions change until the real link is known. */}
      {!isReady && promptStatus === 'error' && (
        <LoadError forbidden={false} onRetry={onRetryLoad ?? (() => {})} />
      )}
      {!isReady && promptStatus !== 'error' && (
        <div className={fieldWrapperClass}>{localize('com_ui_loading')}</div>
      )}

      {isReady && isPromptMode && (
        <>
          <InstructionsPromptFields />
          {restricted && <RestrictedInstructionsPrompt />}
        </>
      )}

      {isReady && (
        <Controller
          name="instructions"
          control={control}
          render={({ field, fieldState: { error } }) => (
            <div
              data-testid="instructions-inline-panel"
              className={cn('flex flex-col', isPromptMode && 'hidden')}
            >
              <VariableEditor
                id="instructions"
                label={localize('com_ui_instructions')}
                value={field.value ?? ''}
                onChange={field.onChange}
                onBlur={field.onBlur}
                inputRef={field.ref}
                placeholder={localize('com_agents_instructions_placeholder')}
                className="min-h-[5.5rem] resize-y"
                labelClassName="sr-only"
                rows={3}
                required={!isPromptMode}
                invalid={error != null}
              />
              {error && (
                <span
                  className="text-text-destructive mt-1 text-xs transition duration-300 ease-in-out"
                  role="alert"
                >
                  {localize('com_ui_field_required')}
                </span>
              )}
            </div>
          )}
        />
      )}
    </div>
  );
}

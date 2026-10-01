import { Controller, useFormContext } from 'react-hook-form';
import type { AgentForm } from '~/common';
import { VariableEditor } from '~/components/Variables';
import { useLocalize } from '~/hooks';

export default function Instructions() {
  const localize = useLocalize();
  const { control } = useFormContext<AgentForm>();

  return (
    <Controller
      name="instructions"
      control={control}
      render={({ field, fieldState: { error } }) => (
        <div className="mb-3 flex flex-col">
          <VariableEditor
            id="instructions"
            label={localize('com_ui_instructions')}
            value={field.value ?? ''}
            onChange={field.onChange}
            onBlur={field.onBlur}
            inputRef={field.ref}
            placeholder={localize('com_agents_instructions_placeholder')}
            className="min-h-[5.5rem] resize-y"
            labelClassName="block text-[0.6875rem] font-medium uppercase tracking-wide text-text-secondary"
            rows={3}
            required={true}
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
  );
}

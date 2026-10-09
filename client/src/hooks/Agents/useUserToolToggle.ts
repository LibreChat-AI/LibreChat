import { useCallback } from 'react';
import { useFormContext, useWatch } from 'react-hook-form';
import type { AgentToolOptions, UserToolToggle } from 'librechat-data-provider';
import type { AgentForm } from '~/common';

interface UseUserToolToggleReturn {
  value: UserToolToggle | undefined;
  setValue: (next: UserToolToggle | undefined) => void;
}

/** Reads/writes one tool's `user_toggle`; `undefined` (locked) removes the key and any emptied entry. */
export default function useUserToolToggle(toolOptionKey: string): UseUserToolToggleReturn {
  const { getValues, setValue: setFormValue, control } = useFormContext<AgentForm>();
  const toolOptions = useWatch({ control, name: 'tool_options' });

  const setValue = useCallback(
    (next: UserToolToggle | undefined) => {
      const options: AgentToolOptions = { ...getValues('tool_options') };
      if (next != null) {
        options[toolOptionKey] = { ...options[toolOptionKey], user_toggle: next };
      } else if (options[toolOptionKey] != null) {
        const { user_toggle: _omit, ...rest } = options[toolOptionKey];
        if (Object.keys(rest).length === 0) {
          delete options[toolOptionKey];
        } else {
          options[toolOptionKey] = rest;
        }
      }
      setFormValue('tool_options', options, { shouldDirty: true });
    },
    [getValues, setFormValue, toolOptionKey],
  );

  return { value: toolOptions?.[toolOptionKey]?.user_toggle, setValue };
}

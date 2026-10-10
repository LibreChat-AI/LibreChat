import { useCallback } from 'react';
import { useFormContext, useWatch } from 'react-hook-form';
import { v4 as uuidv4, validate as validateUUID } from 'uuid';
import type {
  AgentToolOptions,
  AllowedCaller,
  AgentToolType,
  AgentToolApprovalMode,
} from 'librechat-data-provider';
import type { UseFormGetValues, UseFormSetValue } from 'react-hook-form';
import type { AgentForm } from '~/common';

type BooleanToolOptionKey = 'defer_loading' | 'run_in_background' | 'describe_intent';

interface BooleanOptionHandlers {
  isSet: (toolId: string) => boolean;
  toggle: (toolId: string) => void;
  areAllSet: (tools: AgentToolType[]) => boolean;
  toggleAll: (tools: AgentToolType[]) => void;
}

interface ToolOptionsFormContext {
  formToolOptions: AgentToolOptions | undefined;
  getValues: UseFormGetValues<AgentForm>;
  setValue: UseFormSetValue<AgentForm>;
}

interface UseMCPToolOptionsReturn {
  formToolOptions: AgentToolOptions | undefined;
  setToolApprovalMode: (toolIds: readonly string[], mode?: AgentToolApprovalMode) => void;
  isToolDeferred: (toolId: string) => boolean;
  isToolProgrammatic: (toolId: string) => boolean;
  isToolBackground: (toolId: string) => boolean;
  isToolIntent: (toolId: string) => boolean;
  isToolProgrammaticOnly: (toolId: string) => boolean;
  toggleToolDefer: (toolId: string) => void;
  toggleToolProgrammatic: (toolId: string) => void;
  toggleToolBackground: (toolId: string) => void;
  toggleToolIntent: (toolId: string) => void;
  areAllToolsDeferred: (tools: AgentToolType[]) => boolean;
  areAllToolsProgrammatic: (tools: AgentToolType[]) => boolean;
  areAllToolsBackground: (tools: AgentToolType[]) => boolean;
  areAllToolsIntent: (tools: AgentToolType[]) => boolean;
  toggleDeferAll: (tools: AgentToolType[]) => void;
  toggleProgrammaticAll: (tools: AgentToolType[]) => void;
  toggleBackgroundAll: (tools: AgentToolType[]) => void;
  toggleIntentAll: (tools: AgentToolType[]) => void;
}

/**
 * Sets or clears a boolean flag on one tool's options without mutating the
 * previous objects (react-hook-form still holds them); dropping the last flag
 * removes the tool's entry entirely.
 */
export function withBooleanOption(
  options: AgentToolOptions,
  toolId: string,
  key: BooleanToolOptionKey,
  set: boolean,
): AgentToolOptions {
  const updatedOptions: AgentToolOptions = { ...options };
  const currentToolOptions = updatedOptions[toolId];
  if (set) {
    updatedOptions[toolId] = { ...currentToolOptions, [key]: true };
    return updatedOptions;
  }
  if (!currentToolOptions) {
    return updatedOptions;
  }
  const { [key]: _omit, ...restOptions } = currentToolOptions;
  if (Object.keys(restOptions).length === 0) {
    delete updatedOptions[toolId];
  } else {
    updatedOptions[toolId] = restOptions;
  }
  return updatedOptions;
}

/**
 * Counterpart of {@link withBooleanOption} for flags whose ABSENCE means
 * default-on (background-native code execution): enabling clears the entry so
 * the native default applies; disabling persists an explicit `false`, which a
 * missing key can no longer express.
 */
export function withNativeBooleanOptOut(
  options: AgentToolOptions,
  toolId: string,
  key: BooleanToolOptionKey,
  enabled: boolean,
): AgentToolOptions {
  const updatedOptions: AgentToolOptions = { ...options };
  const currentToolOptions = updatedOptions[toolId];
  if (!enabled) {
    updatedOptions[toolId] = { ...currentToolOptions, [key]: false };
    return updatedOptions;
  }
  if (!currentToolOptions || !(key in currentToolOptions)) {
    return updatedOptions;
  }
  const { [key]: _omit, ...restOptions } = currentToolOptions;
  if (Object.keys(restOptions).length === 0) {
    delete updatedOptions[toolId];
  } else {
    updatedOptions[toolId] = restOptions;
  }
  return updatedOptions;
}

/** Read/toggle handlers for one boolean per-tool option key (single + bulk). */
function useBooleanToolOption(
  key: BooleanToolOptionKey,
  { formToolOptions, getValues, setValue }: ToolOptionsFormContext,
): BooleanOptionHandlers {
  const isSet = useCallback(
    (toolId: string): boolean => formToolOptions?.[toolId]?.[key] === true,
    [formToolOptions, key],
  );

  const toggle = useCallback(
    (toolId: string) => {
      const currentOptions = getValues('tool_options') || {};
      const set = currentOptions[toolId]?.[key] !== true;
      setValue('tool_options', withBooleanOption(currentOptions, toolId, key, set), {
        shouldDirty: true,
      });
    },
    [getValues, setValue, key],
  );

  const areAllSet = useCallback(
    (tools: AgentToolType[]): boolean =>
      tools.length > 0 && tools.every((tool) => formToolOptions?.[tool.tool_id]?.[key] === true),
    [formToolOptions, key],
  );

  const toggleAll = useCallback(
    (tools: AgentToolType[]) => {
      if (tools.length === 0) {
        return;
      }
      const set = !areAllSet(tools);
      let updatedOptions = getValues('tool_options') || {};
      for (const tool of tools) {
        updatedOptions = withBooleanOption(updatedOptions, tool.tool_id, key, set);
      }
      setValue('tool_options', updatedOptions, { shouldDirty: true });
    },
    [areAllSet, getValues, setValue, key],
  );

  return { isSet, toggle, areAllSet, toggleAll };
}

export function withApprovalModes(
  options: AgentToolOptions,
  toolIds: readonly string[],
  mode?: AgentToolApprovalMode,
): AgentToolOptions {
  let updated = options;
  for (const toolId of toolIds) {
    const current = options[toolId];
    const remembered = mode === 'chat' || mode === 'always';
    if (
      current?.approval_mode === mode &&
      (!remembered || validateUUID(current.approval_revision ?? ''))
    )
      continue;
    if (updated === options) updated = { ...options };
    const { approval_mode: _mode, approval_revision: _revision, ...rest } = options[toolId] ?? {};
    if (mode != null) {
      updated[toolId] = { ...rest, approval_mode: mode, approval_revision: uuidv4() };
    } else if (Object.keys(rest).length > 0) {
      updated[toolId] = rest;
    } else {
      delete updated[toolId];
    }
  }
  return updated;
}

export default function useMCPToolOptions(): UseMCPToolOptionsReturn {
  const { getValues, setValue, control } = useFormContext<AgentForm>();
  const formToolOptions = useWatch({ control, name: 'tool_options' });
  const formContext: ToolOptionsFormContext = { formToolOptions, getValues, setValue };

  const defer = useBooleanToolOption('defer_loading', formContext);
  const background = useBooleanToolOption('run_in_background', formContext);
  const intent = useBooleanToolOption('describe_intent', formContext);

  /** `allowed_callers` is array-valued, so the programmatic family stays bespoke. */
  const isToolProgrammatic = useCallback(
    (toolId: string): boolean =>
      formToolOptions?.[toolId]?.allowed_callers?.includes('code_execution') === true,
    [formToolOptions],
  );

  /**
   * Whether the tool can NEVER be called directly (`allowed_callers` set and
   * missing `direct`) — mirrors the backend's `canInjectIntentParam` gate: no
   * card renders for such calls, so intent labels are guaranteed inert and
   * the intent toggle must not present a setting runtime will ignore.
   */
  const isToolProgrammaticOnly = useCallback(
    (toolId: string): boolean => {
      const callers = formToolOptions?.[toolId]?.allowed_callers;
      return callers != null && callers.length > 0 && !callers.includes('direct');
    },
    [formToolOptions],
  );

  const toggleToolProgrammatic = useCallback(
    (toolId: string) => {
      const currentOptions = getValues('tool_options') || {};
      const currentToolOptions = currentOptions[toolId] || {};
      const currentCallers = currentToolOptions.allowed_callers || [];
      const isProgrammatic = currentCallers.includes('code_execution');

      const updatedOptions: AgentToolOptions = { ...currentOptions };

      if (isProgrammatic) {
        const newCallers = currentCallers.filter((c: AllowedCaller) => c !== 'code_execution');
        if (newCallers.length === 0) {
          const { allowed_callers: _, ...restOptions } = currentToolOptions;
          if (Object.keys(restOptions).length === 0) {
            delete updatedOptions[toolId];
          } else {
            updatedOptions[toolId] = restOptions;
          }
        } else {
          updatedOptions[toolId] = {
            ...currentToolOptions,
            allowed_callers: newCallers,
          };
        }
      } else {
        updatedOptions[toolId] = {
          ...currentToolOptions,
          allowed_callers: ['code_execution'] as AllowedCaller[],
        };
      }

      setValue('tool_options', updatedOptions, { shouldDirty: true });
    },
    [getValues, setValue],
  );

  const areAllToolsProgrammatic = useCallback(
    (tools: AgentToolType[]): boolean =>
      tools.length > 0 &&
      tools.every(
        (tool) =>
          formToolOptions?.[tool.tool_id]?.allowed_callers?.includes('code_execution') === true,
      ),
    [formToolOptions],
  );

  const toggleProgrammaticAll = useCallback(
    (tools: AgentToolType[]) => {
      if (tools.length === 0) {
        return;
      }

      const shouldBeProgrammatic = !areAllToolsProgrammatic(tools);
      const currentOptions = getValues('tool_options') || {};
      const updatedOptions: AgentToolOptions = { ...currentOptions };

      for (const tool of tools) {
        const currentToolOptions = updatedOptions[tool.tool_id];
        if (shouldBeProgrammatic) {
          updatedOptions[tool.tool_id] = {
            ...currentToolOptions,
            allowed_callers: ['code_execution'] as AllowedCaller[],
          };
          continue;
        }
        if (!currentToolOptions) {
          continue;
        }
        const { allowed_callers: _, ...restOptions } = currentToolOptions;
        if (Object.keys(restOptions).length === 0) {
          delete updatedOptions[tool.tool_id];
        } else {
          updatedOptions[tool.tool_id] = restOptions;
        }
      }

      setValue('tool_options', updatedOptions, { shouldDirty: true });
    },
    [getValues, setValue, areAllToolsProgrammatic],
  );

  const setToolApprovalMode = useCallback(
    (toolIds: readonly string[], mode?: AgentToolApprovalMode) => {
      const options = getValues('tool_options') ?? {};
      const updated = withApprovalModes(options, toolIds, mode);
      if (updated !== options) setValue('tool_options', updated, { shouldDirty: true });
    },
    [getValues, setValue],
  );

  return {
    formToolOptions,
    setToolApprovalMode,
    isToolDeferred: defer.isSet,
    isToolProgrammatic,
    isToolBackground: background.isSet,
    isToolIntent: intent.isSet,
    isToolProgrammaticOnly,
    toggleToolDefer: defer.toggle,
    toggleToolProgrammatic,
    toggleToolBackground: background.toggle,
    toggleToolIntent: intent.toggle,
    areAllToolsDeferred: defer.areAllSet,
    areAllToolsProgrammatic,
    areAllToolsBackground: background.areAllSet,
    areAllToolsIntent: intent.areAllSet,
    toggleDeferAll: defer.toggleAll,
    toggleProgrammaticAll,
    toggleBackgroundAll: background.toggleAll,
    toggleIntentAll: intent.toggleAll,
  };
}

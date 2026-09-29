import { useCallback } from 'react';
import { useFormContext, useWatch } from 'react-hook-form';
import type { AgentToolOptions, AllowedCaller, AgentToolType } from 'librechat-data-provider';
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
  isToolDeferred: (toolId: string, deferredBySize?: boolean) => boolean;
  isToolProgrammatic: (toolId: string) => boolean;
  isToolBackground: (toolId: string) => boolean;
  isToolIntent: (toolId: string) => boolean;
  isToolProgrammaticOnly: (toolId: string) => boolean;
  toggleToolDefer: (toolId: string, deferredBySize?: boolean) => void;
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
 * Defer is the one flag a server rule can turn on: a tool whose schema is over
 * `mcpSettings.deferSchemaChars` defers with no stored option. Keeping such a
 * tool loaded stores an explicit `false`; deferring it again clears that, so
 * the tool follows the rule. Other tools store exactly what they did before.
 */
export function withDeferOption(
  options: AgentToolOptions,
  toolId: string,
  defer: boolean,
  deferredBySize: boolean,
): AgentToolOptions {
  if (!deferredBySize) {
    return withBooleanOption(options, toolId, 'defer_loading', defer);
  }
  if (defer) {
    return withBooleanOption(options, toolId, 'defer_loading', false);
  }
  return { ...options, [toolId]: { ...options[toolId], defer_loading: false } };
}

export function isDeferred(
  options: AgentToolOptions | undefined,
  toolId: string,
  deferredBySize = false,
): boolean {
  const explicit = options?.[toolId]?.defer_loading;
  return explicit === true || (explicit == null && deferredBySize);
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

export default function useMCPToolOptions(): UseMCPToolOptionsReturn {
  const { getValues, setValue, control } = useFormContext<AgentForm>();
  const formToolOptions = useWatch({ control, name: 'tool_options' });
  const formContext: ToolOptionsFormContext = { formToolOptions, getValues, setValue };

  const isToolDeferred = useCallback(
    (toolId: string, deferredBySize = false): boolean =>
      isDeferred(formToolOptions, toolId, deferredBySize),
    [formToolOptions],
  );

  const toggleToolDefer = useCallback(
    (toolId: string, deferredBySize = false) => {
      const currentOptions = getValues('tool_options') || {};
      const defer = !isDeferred(currentOptions, toolId, deferredBySize);
      setValue('tool_options', withDeferOption(currentOptions, toolId, defer, deferredBySize), {
        shouldDirty: true,
      });
    },
    [getValues, setValue],
  );

  const areAllToolsDeferred = useCallback(
    (tools: AgentToolType[]): boolean =>
      tools.length > 0 &&
      tools.every((tool) =>
        isDeferred(formToolOptions, tool.tool_id, tool.metadata?.deferredBySize === true),
      ),
    [formToolOptions],
  );

  const toggleDeferAll = useCallback(
    (tools: AgentToolType[]) => {
      if (tools.length === 0) {
        return;
      }
      const defer = !areAllToolsDeferred(tools);
      let updatedOptions = getValues('tool_options') || {};
      for (const tool of tools) {
        updatedOptions = withDeferOption(
          updatedOptions,
          tool.tool_id,
          defer,
          tool.metadata?.deferredBySize === true,
        );
      }
      setValue('tool_options', updatedOptions, { shouldDirty: true });
    },
    [areAllToolsDeferred, getValues, setValue],
  );
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

  return {
    formToolOptions,
    isToolDeferred,
    isToolProgrammatic,
    isToolBackground: background.isSet,
    isToolIntent: intent.isSet,
    isToolProgrammaticOnly,
    toggleToolDefer,
    toggleToolProgrammatic,
    toggleToolBackground: background.toggle,
    toggleToolIntent: intent.toggle,
    areAllToolsDeferred,
    areAllToolsProgrammatic,
    areAllToolsBackground: background.areAllSet,
    areAllToolsIntent: intent.areAllSet,
    toggleDeferAll,
    toggleProgrammaticAll,
    toggleBackgroundAll: background.toggleAll,
    toggleIntentAll: intent.toggleAll,
  };
}

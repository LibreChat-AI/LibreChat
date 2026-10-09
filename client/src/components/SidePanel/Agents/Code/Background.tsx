import { useCallback } from 'react';
import { Tools } from 'librechat-data-provider';
import { useFormContext, useWatch } from 'react-hook-form';
import {
  Switch,
  HoverCard,
  HoverCardPortal,
  HoverCardContent,
  HoverCardTrigger,
  CircleHelpIcon,
} from '@librechat/client';
import type { AgentForm } from '~/common';
import { useAgentCapabilities, useGetAgentsConfig, useLocalize } from '~/hooks';
import { withNativeBooleanOptOut } from '~/hooks/Agents/useMCPToolOptions';
import { ESide } from '~/common';

/** Tools sharing the code-execution sandbox; background-native, so the single
 *  builder toggle persists (or clears) the pair's explicit opt-out. */
const CODE_BACKGROUND_TOOL_IDS: string[] = [Tools.execute_code, Tools.bash_tool];

export default function Background() {
  const localize = useLocalize();
  const { agentsConfig } = useGetAgentsConfig();
  const { backgroundToolsEnabled } = useAgentCapabilities(agentsConfig?.capabilities);
  const { control, getValues, setValue } = useFormContext<AgentForm>();
  const toolOptions = useWatch({ control, name: 'tool_options' });
  /** The pair is background-NATIVE: no entry means on. Mirrors the server's
   *  resolution precedence for the runtime def — its own `bash_tool` key
   *  first, then the `execute_code` capability marker, then the native
   *  default (`resolveToolOption` in packages/api). */
  const enabled =
    (toolOptions?.[Tools.bash_tool]?.run_in_background ??
      toolOptions?.[Tools.execute_code]?.run_in_background) !== false;

  const handleChange = useCallback(
    (value: boolean) => {
      let updated = getValues('tool_options') || {};
      for (const toolId of CODE_BACKGROUND_TOOL_IDS) {
        updated = withNativeBooleanOptOut(updated, toolId, 'run_in_background', value);
      }
      setValue('tool_options', updated, { shouldDirty: true });
    },
    [getValues, setValue],
  );

  if (!backgroundToolsEnabled) {
    return null;
  }

  return (
    <HoverCard openDelay={50}>
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <div className="text-sm">{localize('com_ui_code_background')}</div>
          <HoverCardTrigger>
            <CircleHelpIcon className="h-4 w-4 text-text-tertiary" />
          </HoverCardTrigger>
        </div>
        <HoverCardPortal>
          <HoverCardContent side={ESide.Top} className="w-80">
            <div className="space-y-2">
              <p className="text-sm text-text-secondary">
                {localize('com_nav_info_code_background')}
              </p>
            </div>
          </HoverCardContent>
        </HoverCardPortal>
        <Switch
          id="code-background-tools"
          checked={enabled}
          onCheckedChange={handleChange}
          className="ml-4"
          data-testid="code-background-tools"
          aria-label={localize('com_ui_code_background')}
        />
      </div>
    </HoverCard>
  );
}

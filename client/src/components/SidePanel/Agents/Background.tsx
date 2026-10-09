import { useCallback } from 'react';
import { useFormContext, useWatch } from 'react-hook-form';
import { normalizeActionToolName } from 'librechat-data-provider';
import {
  Switch,
  HoverCard,
  HoverCardPortal,
  HoverCardContent,
  HoverCardTrigger,
  CircleHelpIcon,
} from '@librechat/client';
import type { TranslationKeys } from '~/hooks/useLocalize';
import type { AgentForm } from '~/common';
import { useAgentCapabilities, useGetAgentsConfig, useLocalize } from '~/hooks';
import { withBooleanOption } from '~/hooks/Agents/useMCPToolOptions';
import { ESide } from '~/common';

interface Props {
  toolIds: string[];
  switchId: string;
  labelKey: TranslationKeys;
  infoKey: TranslationKeys;
}

/** Shared "Background execution" switch — opts the given tool ids into
 *  background dispatch via `tool_options`. Reflects enabled when ANY id is
 *  opted in, mirroring the server, which honors each id independently and
 *  expands grouped ids (e.g. the code pair) across the group. */
export default function Background({ toolIds, switchId, labelKey, infoKey }: Props) {
  const localize = useLocalize();
  const { agentsConfig } = useGetAgentsConfig();
  const { backgroundToolsEnabled } = useAgentCapabilities(agentsConfig?.capabilities);
  const { control, getValues, setValue } = useFormContext<AgentForm>();
  const toolOptions = useWatch({ control, name: 'tool_options' });
  const enabled = toolIds.some((toolId) => {
    const normalized = normalizeActionToolName(toolId);
    const normalizedValue = toolOptions?.[normalized]?.run_in_background;
    if (normalized !== toolId && normalizedValue != null) {
      return normalizedValue;
    }
    return toolOptions?.[toolId]?.run_in_background === true;
  });

  const handleChange = useCallback(
    (value: boolean) => {
      let updated = getValues('tool_options') || {};
      for (const toolId of toolIds) {
        const normalized = normalizeActionToolName(toolId);
        const aliases = normalized === toolId ? [toolId] : [toolId, normalized];
        for (const alias of aliases) {
          updated = withBooleanOption(updated, alias, 'run_in_background', value);
        }
      }
      setValue('tool_options', updated, { shouldDirty: true });
    },
    [toolIds, getValues, setValue],
  );

  if (!backgroundToolsEnabled || toolIds.length === 0) {
    return null;
  }

  return (
    <HoverCard openDelay={50}>
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <div className="text-sm">{localize(labelKey)}</div>
          <HoverCardTrigger>
            <CircleHelpIcon className="h-4 w-4 text-text-tertiary" />
          </HoverCardTrigger>
        </div>
        <HoverCardPortal>
          <HoverCardContent side={ESide.Top} className="w-80">
            <div className="space-y-2">
              <p className="text-sm text-text-secondary">{localize(infoKey)}</p>
            </div>
          </HoverCardContent>
        </HoverCardPortal>
        <Switch
          id={switchId}
          checked={enabled}
          onCheckedChange={handleChange}
          className="ml-4"
          data-testid={switchId}
          aria-label={localize(labelKey)}
        />
      </div>
    </HoverCard>
  );
}

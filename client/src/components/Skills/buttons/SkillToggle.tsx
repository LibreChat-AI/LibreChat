import { memo, useId } from 'react';
import { Label, Switch, TooltipAnchor } from '@librechat/client';
import { useLocalize } from '~/hooks';

interface SkillToggleProps {
  enabled: boolean;
  onChange: () => void;
}

/**
 * Controls whether the skill is injected into the agent's catalog for the
 * current user. The label stays fixed while the switch carries the state, so
 * flipping it cannot resize the surrounding action row.
 */
function SkillToggle({ enabled, onChange }: SkillToggleProps) {
  const localize = useLocalize();
  const switchId = useId();
  const labelId = useId();

  return (
    <TooltipAnchor
      description={localize('com_ui_skill_available_hint')}
      side="top"
      render={
        <span
          onClick={(e) => e.stopPropagation()}
          className="inline-flex h-9 items-center gap-2 rounded-md px-2 transition-colors hover:bg-surface-hover"
        >
          <Switch
            id={switchId}
            checked={enabled}
            onCheckedChange={() => onChange()}
            aria-labelledby={labelId}
          />
          <Label
            id={labelId}
            htmlFor={switchId}
            className="cursor-pointer select-none whitespace-nowrap text-xs font-medium text-text-secondary"
          >
            {localize('com_ui_skill_available')}
          </Label>
        </span>
      }
    />
  );
}

export default memo(SkillToggle);

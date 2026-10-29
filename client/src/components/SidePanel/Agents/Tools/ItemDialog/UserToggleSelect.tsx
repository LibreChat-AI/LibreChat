import { Radio } from '@librechat/client';
import type { UserToolToggle } from 'librechat-data-provider';
import useUserToolToggle from '~/hooks/Agents/useUserToolToggle';
import { useLocalize } from '~/hooks';

interface Props {
  toolOptionKey: string;
  labelId: string;
}

const LOCKED = 'locked';

export default function UserToggleSelect({ toolOptionKey, labelId }: Props) {
  const localize = useLocalize();
  const { value, setValue } = useUserToolToggle(toolOptionKey);

  const options = [
    { value: LOCKED, label: localize('com_ui_tool_toggle_locked') },
    { value: 'on', label: localize('com_ui_tool_toggle_on') },
    { value: 'off', label: localize('com_ui_tool_toggle_off') },
  ];

  return (
    <div className="flex flex-col gap-3">
      <span id={labelId} className="text-sm font-medium text-text-primary">
        {localize('com_ui_tool_toggle_label')}
      </span>
      <Radio
        options={options}
        value={value ?? LOCKED}
        onChange={(next) => setValue(next === LOCKED ? undefined : (next as UserToolToggle))}
        fullWidth
        aria-labelledby={labelId}
      />
      <p className="text-sm leading-relaxed text-text-secondary">
        {localize('com_ui_tool_toggle_info')}
      </p>
    </div>
  );
}

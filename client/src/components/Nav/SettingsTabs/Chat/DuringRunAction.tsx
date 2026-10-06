import { useAtom } from 'jotai';
import { Dropdown, InfoHoverCard, ESide } from '@librechat/client';
import { duringRunActionAtom } from '~/store/duringRun';
import { useLocalize } from '~/hooks';

export default function DuringRunAction() {
  const [action, setAction] = useAtom(duringRunActionAtom);
  const localize = useLocalize();
  const labelId = 'during-run-action-label';

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center space-x-2">
        <span id={labelId}>{localize('com_nav_during_run_action')}</span>
        <InfoHoverCard side={ESide.Bottom} text={localize('com_nav_info_during_run_action')} />
      </div>
      <Dropdown
        value={action}
        options={[
          { value: 'steer', label: localize('com_ui_steer') },
          { value: 'interrupt', label: localize('com_ui_interrupt_steer') },
          { value: 'queue', label: localize('com_ui_queue') },
        ]}
        onChange={(value) => {
          if (value === 'steer' || value === 'interrupt' || value === 'queue') setAction(value);
        }}
        className="z-50"
        sizeClasses="z-50"
        testId="duringRunAction"
        aria-labelledby={labelId}
      />
    </div>
  );
}

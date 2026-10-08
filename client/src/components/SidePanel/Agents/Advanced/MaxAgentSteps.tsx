import { useFormContext, Controller } from 'react-hook-form';
import { Input, Label, HoverCard, HoverCardPortal, HoverCardContent } from '@librechat/client';
import type { AgentForm } from '~/common';
import { useLocalize } from '~/hooks';
import { InfoTrigger } from './ui';
import { ESide } from '~/common';

export default function MaxAgentSteps() {
  const localize = useLocalize();
  const { control } = useFormContext<AgentForm>();

  return (
    <HoverCard openDelay={50}>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <Label htmlFor="recursion_limit" className="w-auto text-[13px] font-medium">
            {localize('com_ui_agent_recursion_limit')}
          </Label>
          <InfoTrigger />
        </div>
        <Controller
          name="recursion_limit"
          control={control}
          render={({ field }) => (
            <Input
              id="recursion_limit"
              type="number"
              inputMode="numeric"
              value={field.value ?? ''}
              onChange={(e) => {
                const value = e.target.value;
                if (value === '') {
                  field.onChange('');
                } else if (!isNaN(Number(value))) {
                  field.onChange(Number(value));
                }
              }}
              placeholder={localize('com_nav_theme_system')}
              aria-label={localize('com_ui_agent_recursion_limit')}
              className="h-9 w-full"
            />
          )}
        />
      </div>
      <HoverCardPortal>
        <HoverCardContent side={ESide.Top} className="w-80">
          <p className="text-text-secondary text-sm">
            {localize('com_ui_agent_recursion_limit_info')}
          </p>
        </HoverCardContent>
      </HoverCardPortal>
    </HoverCard>
  );
}

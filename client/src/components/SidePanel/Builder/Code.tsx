import { Capabilities } from 'librechat-data-provider';
import { useFormContext, Controller } from 'react-hook-form';
import {
  Checkbox,
  HoverCard,
  HoverCardContent,
  HoverCardPortal,
  HoverCardTrigger,
  CircleHelpIcon,
} from '@librechat/client';
import type { AssistantForm } from '~/common';
import { useLocalize } from '~/hooks';
import { ESide } from '~/common';

export default function Code({ version }: { version: number | string }) {
  const localize = useLocalize();
  const methods = useFormContext<AssistantForm>();
  const { control, setValue, getValues } = methods;

  return (
    <>
      <HoverCard openDelay={50}>
        <div className="flex items-center">
          <Controller
            name={Capabilities.code_interpreter}
            control={control}
            render={({ field }) => (
              <Checkbox
                {...field}
                checked={field.value}
                onCheckedChange={field.onChange}
                className="relative float-left mr-2 inline-flex h-4 w-4 cursor-pointer"
                value={field.value.toString()}
                aria-labelledby={Capabilities.code_interpreter}
              />
            )}
          />
          <button
            type="button"
            className="text-text-tertiary flex items-center space-x-2"
            onClick={() =>
              setValue(Capabilities.code_interpreter, !getValues(Capabilities.code_interpreter), {
                shouldDirty: true,
              })
            }
          >
            <label
              id={Capabilities.code_interpreter}
              className="form-check-label text-text-primary w-full cursor-pointer"
              htmlFor={Capabilities.code_interpreter}
            >
              {localize('com_assistants_code_interpreter')}
            </label>
            <HoverCardTrigger>
              <CircleHelpIcon className="h-5 w-5" />
            </HoverCardTrigger>
          </button>
          <HoverCardPortal>
            <HoverCardContent side={ESide.Top} className="w-80">
              <div className="space-y-2">
                <p className="text-text-secondary text-sm">
                  {version == 2 && localize('com_assistants_code_interpreter_info')}
                </p>
              </div>
            </HoverCardContent>
          </HoverCardPortal>
        </div>
      </HoverCard>
    </>
  );
}

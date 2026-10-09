import { Checkbox, Label } from '@librechat/client';
import { Capabilities } from 'librechat-data-provider';
import { useFormContext, Controller } from 'react-hook-form';
import type { AssistantForm } from '~/common';
import { useLocalize } from '~/hooks';

export default function ImageVision() {
  const localize = useLocalize();
  const methods = useFormContext<AssistantForm>();
  const { control, setValue, getValues } = methods;

  return (
    <div className="flex items-center">
      <Controller
        name={Capabilities.image_vision}
        control={control}
        render={({ field }) => (
          <Checkbox
            {...field}
            checked={field.value}
            onCheckedChange={field.onChange}
            className="relative float-left mr-2 inline-flex cursor-pointer"
            value={field.value?.toString()}
            aria-labelledby="image-vision-label"
          />
        )}
      />
      <Label
        id="image-vision-label"
        className="cursor-pointer"
        htmlFor={Capabilities.image_vision}
        onClick={() =>
          setValue(Capabilities.image_vision, !getValues(Capabilities.image_vision), {
            shouldDirty: true,
          })
        }
      >
        <div className="flex items-center">{localize('com_assistants_image_vision')}</div>
      </Label>
    </div>
  );
}

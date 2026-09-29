import * as React from 'react';
import { useEffect } from 'react';
import { Checkbox, useStoreState, useCheckboxStore } from '@ariakit/react';
import { composerControlClasses } from '~/utils/composer';
import { cn } from '~/utils';

const CheckboxButton: React.ForwardRefExoticComponent<
  {
    icon?: React.ReactNode;
    label: string;
    className?: string;
    checked?: boolean;
    defaultChecked?: boolean;
    isCheckedClassName?: string;
    setValue?: (values: {
      e?: React.ChangeEvent<HTMLInputElement>;
      value: boolean | string;
    }) => void;
  } & React.RefAttributes<HTMLInputElement>
> = React.forwardRef<
  HTMLInputElement,
  {
    icon?: React.ReactNode;
    label: string;
    className?: string;
    checked?: boolean;
    defaultChecked?: boolean;
    isCheckedClassName?: string;
    setValue?: (values: {
      e?: React.ChangeEvent<HTMLInputElement>;
      value: boolean | string;
    }) => void;
  }
>(({ icon, label, setValue, className, checked, defaultChecked, isCheckedClassName }, ref) => {
  const checkbox = useCheckboxStore();
  const isChecked = useStoreState(checkbox, (state) => state?.value);
  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (typeof isChecked !== 'boolean') {
      return;
    }
    setValue?.({ e, value: !isChecked });
  };

  // Sync with controlled checked prop
  useEffect(() => {
    if (checked !== undefined) {
      checkbox.setValue(checked);
    }
  }, [checked, checkbox]);

  // Set initial value from defaultChecked
  useEffect(() => {
    if (defaultChecked !== undefined && checked === undefined) {
      checkbox.setValue(defaultChecked);
    }
  }, [defaultChecked, checked, checkbox]);

  return (
    <Checkbox
      ref={ref}
      store={checkbox}
      onChange={onChange}
      className={cn(
        composerControlClasses(),
        'w-theme-control max-w-fit p-theme-compact md:w-full md:px-theme-normal',

        // Checked state styling
        isChecked && isCheckedClassName && isCheckedClassName,

        // Additional custom classes
        className,
      )}
      render={<button type="button" aria-label={label} />}
    >
      {/* Icon if provided */}
      {icon && <span className="icon-md text-text-primary">{icon as React.JSX.Element}</span>}

      {/* Show the label on larger screens */}
      <span className="hidden truncate md:block">{label}</span>
    </Checkbox>
  );
});

CheckboxButton.displayName = 'CheckboxButton';

export default CheckboxButton;

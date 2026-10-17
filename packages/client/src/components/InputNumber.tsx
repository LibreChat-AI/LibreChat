import * as React from 'react';

// import { NumericFormat } from 'react-number-format';

import RCInputNumber from 'rc-input-number';
import * as InputNumberPrimitive from 'rc-input-number';
import type { ValueType } from '@rc-component/mini-decimal';
import { cn, disabledWithinFillClasses } from '~/utils';
import './InputNumber.css';

// TODO help needed
// React.ElementRef<typeof LabelPrimitive.Root>,
// React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>

/** `option` is the borderless value that sits beside a setting's label, such as a slider's
 *  number: it reads as text until the row is hovered or the field is focused. Focus and the
 *  placeholder belong to the nested input rc-input-number renders, so they are matched there. */
const INPUT_NUMBER_VARIANTS: Record<'default' | 'option', string> = {
  default: '',
  option:
    'h-auto border-0 border-transparent p-0 pr-1 text-right shadow-none outline-hidden transition-colors hover:not-focus-within:bg-surface-hover focus-within:bg-surface-secondary [&_input]:placeholder:text-text-secondary [&_input:focus]:placeholder:text-text-primary group-hover/temp:border-border-light reset-rc-number-input reset-rc-number-input-text-right',
};

export type InputNumberProps = InputNumberPrimitive.InputNumberProps<ValueType> & {
  variant?: keyof typeof INPUT_NUMBER_VARIANTS;
};

const InputNumber: React.ForwardRefExoticComponent<
  InputNumberProps & React.RefAttributes<HTMLInputElement>
> = React.forwardRef<React.ElementRef<typeof RCInputNumber>, InputNumberProps>(
  ({ className, variant = 'default', ...props }, ref) => {
    return (
      <RCInputNumber
        className={cn(
          'border-border-control text-text-primary placeholder:text-text-tertiary flex max-h-5 w-full rounded-md border bg-transparent px-3 py-2 text-sm focus:outline-hidden has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50',
          disabledWithinFillClasses,
          INPUT_NUMBER_VARIANTS[variant],
          className ?? '',
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
InputNumber.displayName = 'Input';

export { InputNumber };

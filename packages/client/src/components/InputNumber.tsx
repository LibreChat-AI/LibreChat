import * as React from 'react';

// import { NumericFormat } from 'react-number-format';

import RCInputNumber from 'rc-input-number';
import * as InputNumberPrimitive from 'rc-input-number';
import type { ValueType } from '@rc-component/mini-decimal';
import { cn, disabledWithinFillClasses } from '~/utils';

// TODO help needed
// React.ElementRef<typeof LabelPrimitive.Root>,
// React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>

const InputNumber: React.ForwardRefExoticComponent<
  InputNumberPrimitive.InputNumberProps<ValueType> & React.RefAttributes<HTMLInputElement>
> = React.forwardRef<React.ElementRef<typeof RCInputNumber>, InputNumberPrimitive.InputNumberProps>(
  ({ className, ...props }, ref) => {
    return (
      <RCInputNumber
        className={cn(
          'border-border-medium text-text-primary placeholder:text-text-tertiary flex max-h-5 w-full rounded-md border bg-transparent px-3 py-2 text-sm focus:outline-hidden disabled:cursor-not-allowed disabled:opacity-50',
          disabledWithinFillClasses,
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

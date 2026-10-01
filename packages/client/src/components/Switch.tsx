import * as React from 'react';
import * as SwitchPrimitives from '@radix-ui/react-switch';
import { cn, disabledFillClasses } from '~/utils';

type BaseSwitchProps = Omit<
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>,
  'aria-label' | 'aria-labelledby'
>;

type SwitchProps =
  | (BaseSwitchProps & {
      'aria-label': string;
      'aria-labelledby'?: never;
    })
  | (BaseSwitchProps & {
      'aria-labelledby': string;
      'aria-label'?: never;
    });

const Switch: React.ForwardRefExoticComponent<
  SwitchProps & React.RefAttributes<HTMLButtonElement>
> = React.forwardRef<React.ElementRef<typeof SwitchPrimitives.Root>, SwitchProps>(
  ({ className, ...props }, ref) => (
    <SwitchPrimitives.Root
      className={cn(
        /** A compact theme track can be smaller than a usable target, so an invisible layer
         *  centered on it keeps the hit area at least 24px tall, and 44px each way on a coarse
         *  pointer; a track larger than that still takes taps on its own box. */
        'touch:before:h-theme-control-touch touch:before:w-theme-control-touch before:h-theme-target relative before:absolute before:top-1/2 before:left-1/2 before:w-full before:-translate-x-1/2 before:-translate-y-1/2',
        'peer focus-visible:ring-focus-control focus-visible:ring-offset-surface-primary data-[state=checked]:bg-surface-inverted data-[state=unchecked]:bg-switch-unchecked h-theme-switch w-theme-switch inline-flex shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-50',
        disabledFillClasses,
        className,
      )}
      {...props}
      ref={ref}
    >
      <SwitchPrimitives.Thumb
        className={cn(
          'bg-switch-thumb size-theme-switch-thumb data-[state=checked]:translate-x-theme-switch-travel pointer-events-none block rounded-full shadow-lg ring-0 transition-transform data-[state=unchecked]:translate-x-0',
        )}
      />
    </SwitchPrimitives.Root>
  ),
);
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };

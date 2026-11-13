import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from '~/utils';

/**
 * Radix popover parts, so a consumer of this library (the chat package among them) composes an
 * anchored, focus-managed popup without its own dependency on Radix. The root, trigger, portal
 * and close parts are Radix's own; `PopoverContent` adds the panel's surface, edge, radius,
 * shadow and enter/exit motion, and callers add only size and layout through `className`.
 */
const Popover: React.FC<PopoverPrimitive.PopoverProps> = PopoverPrimitive.Root;

const PopoverTrigger: React.ForwardRefExoticComponent<
  PopoverPrimitive.PopoverTriggerProps & React.RefAttributes<HTMLButtonElement>
> = PopoverPrimitive.Trigger;

const PopoverPortal: React.FC<PopoverPrimitive.PopoverPortalProps> = PopoverPrimitive.Portal;

const PopoverContent: React.ForwardRefExoticComponent<
  PopoverPrimitive.PopoverContentProps & React.RefAttributes<HTMLDivElement>
> = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, ...props }, ref) => (
  <PopoverPrimitive.Content
    ref={ref}
    className={cn(
      'border-border-light bg-surface-secondary text-text-primary data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 rounded-theme-popover z-50 origin-[--radix-popover-content-transform-origin] border shadow-xl motion-reduce:animate-none',
      className,
    )}
    {...props}
  />
));
PopoverContent.displayName = 'PopoverContent';

const PopoverClose: React.ForwardRefExoticComponent<
  PopoverPrimitive.PopoverCloseProps & React.RefAttributes<HTMLButtonElement>
> = PopoverPrimitive.Close;

export { Popover, PopoverTrigger, PopoverPortal, PopoverContent, PopoverClose };

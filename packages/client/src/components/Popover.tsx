import * as PopoverPrimitive from '@radix-ui/react-popover';
import type * as React from 'react';

/**
 * Radix popover parts, re-exported unstyled so a consumer of this library (the chat package
 * among them) composes an anchored, focus-managed popup without its own dependency on Radix.
 * Each caller styles `PopoverContent` itself; this adds no classes and changes no behavior.
 */
const Popover: React.FC<PopoverPrimitive.PopoverProps> = PopoverPrimitive.Root;

const PopoverTrigger: React.ForwardRefExoticComponent<
  PopoverPrimitive.PopoverTriggerProps & React.RefAttributes<HTMLButtonElement>
> = PopoverPrimitive.Trigger;

const PopoverPortal: React.FC<PopoverPrimitive.PopoverPortalProps> = PopoverPrimitive.Portal;

const PopoverContent: React.ForwardRefExoticComponent<
  PopoverPrimitive.PopoverContentProps & React.RefAttributes<HTMLDivElement>
> = PopoverPrimitive.Content;

const PopoverClose: React.ForwardRefExoticComponent<
  PopoverPrimitive.PopoverCloseProps & React.RefAttributes<HTMLButtonElement>
> = PopoverPrimitive.Close;

export { Popover, PopoverTrigger, PopoverPortal, PopoverContent, PopoverClose };

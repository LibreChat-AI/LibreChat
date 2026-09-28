import * as React from 'react';
import * as HoverCardPrimitive from '@radix-ui/react-hover-card';
import { useNestedPopoverStyle } from './OriginalDialog';
import { cn } from '~/utils';

const HoverCard: React.FC<HoverCardPrimitive.HoverCardProps> = HoverCardPrimitive.Root;

const HoverCardTrigger: React.ForwardRefExoticComponent<
  HoverCardPrimitive.HoverCardTriggerProps & React.RefAttributes<HTMLAnchorElement>
> = HoverCardPrimitive.Trigger;

const HoverCardPortal: React.FC<HoverCardPrimitive.HoverCardPortalProps> =
  HoverCardPrimitive.Portal;

const HoverCardContent: React.ForwardRefExoticComponent<
  Omit<HoverCardPrimitive.HoverCardContentProps & React.RefAttributes<HTMLDivElement>, 'ref'> & {
    disabled?: boolean;
  } & React.RefAttributes<HTMLDivElement>
> = React.forwardRef<
  React.ElementRef<typeof HoverCardPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof HoverCardPrimitive.Content> & { disabled?: boolean }
>(
  (
    { className = '', align = 'center', sideOffset = 6, disabled = false, style, ...props },
    ref,
  ) => {
    const nestedStyle = useNestedPopoverStyle();
    if (disabled) {
      return null;
    }

    return (
      <HoverCardPrimitive.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        style={{ ...nestedStyle, ...style }}
        className={cn(
          'z-50 w-64 origin-[--radix-hover-card-content-transform-origin] rounded-xl border border-border-light bg-surface-secondary p-4 text-text-primary shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
          className,
        )}
        {...props}
      />
    );
  },
);
HoverCardContent.displayName = HoverCardPrimitive.Content.displayName;

export { HoverCard, HoverCardTrigger, HoverCardContent, HoverCardPortal };

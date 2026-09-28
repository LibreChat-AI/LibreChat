import * as React from 'react';
import { JSX } from 'react/jsx-runtime';
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import { cn } from '~/utils';

const AlertDialog: React.FC<AlertDialogPrimitive.AlertDialogProps> = AlertDialogPrimitive.Root;

const AlertDialogTrigger: React.ForwardRefExoticComponent<
  AlertDialogPrimitive.AlertDialogTriggerProps & React.RefAttributes<HTMLButtonElement>
> = AlertDialogPrimitive.Trigger;

type AlertPortalProps = AlertDialogPrimitive.AlertDialogPortalProps & { className?: string };

const AlertDialogPortal = ({ className = '', children, ...props }: AlertPortalProps) => (
  <AlertDialogPrimitive.Portal className={cn(className)} {...(props as AlertPortalProps)}>
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      {children}
    </div>
  </AlertDialogPrimitive.Portal>
);
AlertDialogPortal.displayName = AlertDialogPrimitive.Portal.displayName;

const AlertDialogOverlay = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Overlay>
>(({ className = '', ...props }, ref) => (
  <AlertDialogPrimitive.Overlay
    className={cn(
      'fixed inset-0 z-50 bg-surface-overlay/90 transition-opacity animate-in fade-in',
      className,
    )}
    {...props}
    ref={ref}
  />
));
AlertDialogOverlay.displayName = AlertDialogPrimitive.Overlay.displayName;

const AlertDialogContent: React.ForwardRefExoticComponent<
  Omit<AlertDialogPrimitive.AlertDialogContentProps & React.RefAttributes<HTMLDivElement>, 'ref'> &
    React.RefAttributes<HTMLDivElement>
> = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content>
>(({ className = '', ...props }, ref) => (
  <AlertDialogPortal>
    <AlertDialogOverlay />
    <AlertDialogPrimitive.Content
      ref={ref}
      className={cn(
        /** The dialog surface is otherwise borderless: in high contrast it sits on
         *  a canvas of its own colour, so it needs a drawn edge. */
        'fixed z-50 grid w-full max-w-lg scale-100 gap-4 bg-surface-dialog p-6 opacity-100 animate-in fade-in-90 slide-in-from-bottom-10 high-contrast:border high-contrast:border-solid high-contrast:border-border-medium sm:rounded-lg sm:zoom-in-90 sm:slide-in-from-bottom-0 md:w-full',
        className,
      )}
      {...props}
    />
  </AlertDialogPortal>
));
AlertDialogContent.displayName = AlertDialogPrimitive.Content.displayName;

const AlertDialogHeader: {
  ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
  displayName: string;
} = ({ className = '', ...props }: React.HTMLAttributes<HTMLDivElement>): JSX.Element => (
  <div className={cn('flex flex-col space-y-2 text-center sm:text-left', className)} {...props} />
);
AlertDialogHeader.displayName = 'AlertDialogHeader';

const AlertDialogFooter: {
  ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
  displayName: string;
} = ({ className = '', ...props }: React.HTMLAttributes<HTMLDivElement>): JSX.Element => (
  <div
    className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)}
    {...props}
  />
);
AlertDialogFooter.displayName = 'AlertDialogFooter';

const AlertDialogTitle: React.ForwardRefExoticComponent<
  Omit<
    AlertDialogPrimitive.AlertDialogTitleProps & React.RefAttributes<HTMLHeadingElement>,
    'ref'
  > &
    React.RefAttributes<HTMLHeadingElement>
> = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Title>
>(({ className = '', ...props }, ref) => (
  <AlertDialogPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold text-text-primary', className)}
    {...props}
  />
));
AlertDialogTitle.displayName = AlertDialogPrimitive.Title.displayName;

const AlertDialogDescription: React.ForwardRefExoticComponent<
  Omit<
    AlertDialogPrimitive.AlertDialogDescriptionProps & React.RefAttributes<HTMLParagraphElement>,
    'ref'
  > &
    React.RefAttributes<HTMLParagraphElement>
> = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Description>
>(({ className = '', ...props }, ref) => (
  <AlertDialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-text-secondary', className)}
    {...props}
  />
));
AlertDialogDescription.displayName = AlertDialogPrimitive.Description.displayName;

const AlertDialogAction: React.ForwardRefExoticComponent<
  Omit<
    AlertDialogPrimitive.AlertDialogActionProps & React.RefAttributes<HTMLButtonElement>,
    'ref'
  > &
    React.RefAttributes<HTMLButtonElement>
> = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Action>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Action>
>(({ className = '', ...props }, ref) => (
  <AlertDialogPrimitive.Action
    ref={ref}
    className={cn(
      'inline-flex h-10 items-center justify-center rounded-md bg-surface-inverted px-4 py-2 text-sm font-semibold text-text-inverted transition-colors hover:bg-surface-inverted-hover focus:outline-none focus:ring-2 focus:ring-text-primary focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  />
));
AlertDialogAction.displayName = AlertDialogPrimitive.Action.displayName;

const AlertDialogCancel: React.ForwardRefExoticComponent<
  Omit<
    AlertDialogPrimitive.AlertDialogCancelProps & React.RefAttributes<HTMLButtonElement>,
    'ref'
  > &
    React.RefAttributes<HTMLButtonElement>
> = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Cancel>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Cancel>
>(({ className = '', ...props }, ref) => (
  <AlertDialogPrimitive.Cancel
    ref={ref}
    className={cn(
      'mt-2 inline-flex h-10 items-center justify-center rounded-md border border-border-light bg-transparent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-text-primary focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 sm:mt-0',
      className,
    )}
    {...props}
  />
));
AlertDialogCancel.displayName = AlertDialogPrimitive.Cancel.displayName;

export {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
};

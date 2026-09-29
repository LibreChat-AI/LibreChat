import * as React from 'react';
import { JSX } from 'react/jsx-runtime';
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import { useDialogDepth } from './OriginalDialog';
import { cn } from '~/utils';

const AlertDialog: React.FC<AlertDialogPrimitive.AlertDialogProps> = AlertDialogPrimitive.Root;

const AlertDialogTrigger: React.ForwardRefExoticComponent<
  AlertDialogPrimitive.AlertDialogTriggerProps & React.RefAttributes<HTMLButtonElement>
> = AlertDialogPrimitive.Trigger;

type AlertPortalProps = AlertDialogPrimitive.AlertDialogPortalProps & { className?: string };

const AlertDialogPortal = ({ className = '', children, ...props }: AlertPortalProps) => {
  const dialogDepth = useDialogDepth();
  const zIndex = dialogDepth > 0 ? 190 + (dialogDepth - 1) * 60 : 50;

  return (
    <AlertDialogPrimitive.Portal className={cn(className)} {...(props as AlertPortalProps)}>
      <div
        className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
        style={{ zIndex }}
      >
        {children}
      </div>
    </AlertDialogPrimitive.Portal>
  );
};
AlertDialogPortal.displayName = AlertDialogPrimitive.Portal.displayName;

const AlertDialogOverlay = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Overlay>
>(({ className = '', style, ...props }, ref) => {
  const dialogDepth = useDialogDepth();
  const zIndex = dialogDepth > 0 ? 190 + (dialogDepth - 1) * 60 : 50;

  return (
    <AlertDialogPrimitive.Overlay
      className={cn(
        'bg-surface-overlay/90 animate-in fade-in fixed inset-0 z-50 transition-opacity',
        className,
      )}
      style={{ ...style, zIndex }}
      {...props}
      ref={ref}
    />
  );
});
AlertDialogOverlay.displayName = AlertDialogPrimitive.Overlay.displayName;

const AlertDialogContent: React.ForwardRefExoticComponent<
  Omit<AlertDialogPrimitive.AlertDialogContentProps & React.RefAttributes<HTMLDivElement>, 'ref'> &
    React.RefAttributes<HTMLDivElement>
> = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content>
>(({ className = '', style, ...props }, ref) => {
  const dialogDepth = useDialogDepth();
  const zIndex = dialogDepth > 0 ? 200 + (dialogDepth - 1) * 60 : 50;

  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        ref={ref}
        className={cn(
          /** The dialog surface is otherwise borderless: in high contrast it sits on
           *  a canvas of its own colour, so it needs a drawn edge. */
          'bg-surface-dialog animate-in fade-in-90 slide-in-from-bottom-10 high-contrast:border high-contrast:border-solid high-contrast:border-border-medium sm:zoom-in-90 sm:slide-in-from-bottom-0 fixed z-50 grid w-full max-w-lg scale-100 gap-4 p-6 opacity-100 sm:rounded-lg md:w-full',
          className,
        )}
        style={{ ...style, zIndex }}
        {...props}
      />
    </AlertDialogPortal>
  );
});
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
    className={cn('text-text-primary text-lg font-semibold', className)}
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
    className={cn('text-text-secondary text-sm', className)}
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
      'bg-surface-inverted text-text-inverted hover:bg-surface-inverted-hover focus:ring-focus-control inline-flex h-10 items-center justify-center rounded-md px-4 py-2 text-sm font-semibold transition-colors focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:cursor-not-allowed disabled:opacity-50',
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
      'border-border-light text-text-primary hover:bg-surface-hover focus:ring-focus-control mt-2 inline-flex h-10 items-center justify-center rounded-md border bg-transparent px-4 py-2 text-sm font-semibold transition-colors focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:cursor-not-allowed disabled:opacity-50 sm:mt-0',
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

import * as React from 'react';
import { X } from 'lucide-react';
import { JSX } from 'react/jsx-runtime';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Button, ButtonProps } from './Button';
import { useMediaQuery } from '~/hooks';
import { cn } from '~/utils';

const Dialog: React.FC<DialogPrimitive.DialogProps> = DialogPrimitive.Root;

const DialogTrigger: React.ForwardRefExoticComponent<
  DialogPrimitive.DialogTriggerProps & React.RefAttributes<HTMLButtonElement>
> = DialogPrimitive.Trigger;

type DialogPortalProps = DialogPrimitive.DialogPortalProps & { className?: string };

const DialogPortal = ({ className = '', children, ...props }: DialogPortalProps) => (
  <DialogPrimitive.Portal className={cn(className)} {...(props as DialogPortalProps)}>
    <div className="fixed inset-0 z-[999] flex items-start justify-center sm:items-center">
      {children}
    </div>
  </DialogPrimitive.Portal>
);
DialogPortal.displayName = DialogPrimitive.Portal.displayName;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    className={cn(
      'fixed inset-0 z-[999] bg-surface-overlay/65 transition-all duration-100 data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=open]:fade-in',
      className ?? '',
    )}
    {...props}
    ref={ref}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

type DialogContentProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
  disableScroll?: boolean;
};

const DialogContent: React.ForwardRefExoticComponent<
  Omit<DialogPrimitive.DialogContentProps & React.RefAttributes<HTMLDivElement>, 'ref'> & {
    showCloseButton?: boolean;
    disableScroll?: boolean;
  } & React.RefAttributes<HTMLDivElement>
> = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Content>, DialogContentProps>(
  (
    { className, children = true, showCloseButton = true, disableScroll = false, ...props },
    ref,
  ) => {
    const isSmallScreen = useMediaQuery('(max-width: 768px)');
    return (
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          ref={ref}
          className={cn(
            /** The dialog surface is otherwise borderless: in high contrast it sits
             *  on a canvas of its own colour, so it needs a drawn edge. */
            'fixed z-[999] grid w-full gap-4 rounded-b-lg bg-surface-dialog pb-6 animate-in data-[state=open]:fade-in-90 data-[state=open]:slide-in-from-bottom-10 high-contrast:border high-contrast:border-solid high-contrast:border-border-medium sm:rounded-lg',
            isSmallScreen
              ? 'fixed left-1/2 top-1/2 z-[999] m-auto grid w-11/12 -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-surface-dialog pb-6'
              : '',
            disableScroll ? 'overflow-hidden' : '',
            className ?? '',
          )}
          {...props}
        >
          {children}
          {showCloseButton && (
            <DialogPrimitive.Close className="absolute right-6 top-[1.6rem] rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-text-primary focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-surface-hover">
              <X className="h-5 w-5 text-text-primary" aria-hidden="true" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Content>
      </DialogPortal>
    );
  },
);
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader: {
  ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
  displayName: string;
} = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): JSX.Element => (
  <div
    className={cn(
      'flex flex-col space-y-2 border-b border-border-light p-6 pb-4 text-left',
      className ?? '',
    )}
    {...props}
  />
);
DialogHeader.displayName = 'DialogHeader';

const DialogFooter: {
  ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
  displayName: string;
} = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): JSX.Element => (
  <div
    className={cn('flex flex-row justify-between space-x-2 px-6 py-4', className ?? '')}
    {...props}
  />
);
DialogFooter.displayName = 'DialogFooter';

const DialogTitle: React.ForwardRefExoticComponent<
  Omit<DialogPrimitive.DialogTitleProps & React.RefAttributes<HTMLHeadingElement>, 'ref'> &
    React.RefAttributes<HTMLHeadingElement>
> = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold text-text-primary', className ?? '')}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription: React.ForwardRefExoticComponent<
  Omit<DialogPrimitive.DialogDescriptionProps & React.RefAttributes<HTMLParagraphElement>, 'ref'> &
    React.RefAttributes<HTMLParagraphElement>
> = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-text-secondary', className ?? '')}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

const DialogClose: React.ForwardRefExoticComponent<
  Omit<DialogPrimitive.DialogCloseProps & React.RefAttributes<HTMLButtonElement>, 'ref'> &
    React.RefAttributes<HTMLButtonElement>
> = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Close>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Close>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Close
    ref={ref}
    className={cn(
      'mt-2 inline-flex h-10 items-center justify-center rounded-lg border border-border-light bg-transparent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-surface-hover focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 sm:mt-0',
      className ?? '',
      /* Important: for accessibility */
      'focus:ring-2 focus:ring-text-primary focus:ring-offset-2',
    )}
    {...props}
  />
));
DialogClose.displayName = DialogPrimitive.Title.displayName;

const DialogButton: React.ForwardRefExoticComponent<
  Omit<ButtonProps & React.RefAttributes<HTMLButtonElement>, 'ref'> &
    React.RefAttributes<HTMLButtonElement>
> = React.forwardRef<
  React.ElementRef<typeof Button>,
  React.ComponentPropsWithoutRef<typeof Button>
>(({ className, ...props }, ref) => (
  <Button
    ref={ref}
    variant="outline"
    className={cn(
      'mt-2 inline-flex h-10 items-center justify-center rounded-lg border border-border-light bg-transparent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-text-primary focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 sm:mt-0',
      className ?? '',
      /* Important: for accessibility */
      'focus:ring-2 focus:ring-text-primary focus:ring-offset-2',
    )}
    {...props}
  />
));
DialogButton.displayName = DialogPrimitive.Title.displayName;

export {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogButton,
};

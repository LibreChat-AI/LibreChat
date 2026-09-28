import * as React from 'react';
import { X } from 'lucide-react';
import { JSX } from 'react/jsx-runtime';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from '~/utils';

const DialogDepthContext = React.createContext(0);

/** Current OGDialog nesting depth (0 when rendered outside any dialog). */
export const useDialogDepth = (): number => React.useContext(DialogDepthContext);

/**
 * z-index for a portaled popover so it renders above the dialog it lives in.
 * Outside any dialog (depth 0) it falls back to a low default (50).
 */
export const usePopoverZIndex = (): number => {
  const depth = useDialogDepth();
  if (depth <= 0) {
    return 50;
  }
  const contentZIndex = 140 + (depth - 1) * 60;
  return contentZIndex + 10;
};

/**
 * What a body-portaled Radix popover needs to survive a modal dialog, or
 * `undefined` outside one — so a popover's own CSS layer (and any consumer
 * override of it) is left untouched everywhere else.
 *
 * Radix coordinates nested layers through module-level state, so it only
 * coordinates layers from the *same copy* of `react-dismissable-layer`. This
 * app has three: `react-dialog` is pinned at 1.0.2 (see PR 11023) while `react-select`
 * and `react-hover-card` resolve to their own newer copies. A popover therefore
 * never learns that the dialog disabled body pointer events, and never lifts
 * itself over the dialog — it opens behind an opaque overlay, inert.
 *
 * `pointer-events` mirrors what `DropdownPopup` already does for Ariakit menus
 * in the same situation; a click inside still reaches the dialog's own
 * "inside" check, because React portals bubble through the React tree.
 */
export const useNestedPopoverStyle = (): React.CSSProperties | undefined => {
  const depth = useDialogDepth();
  const zIndex = usePopoverZIndex();
  return depth > 0 ? { zIndex, pointerEvents: 'auto' } : undefined;
};

/**
 * Whether Escape belongs to something inside the dialog rather than the dialog
 * itself: a trigger whose popover is open, focus inside a menu/listbox/combobox,
 * or a tooltip. WCAG 2.1.1 wants those dismissable on their own, so the first
 * Escape closes them and the dialog stays put.
 */
const escapeBelongsToPopup = (ownerDocument: Document): boolean => {
  const activeElement = ownerDocument.activeElement;
  if (activeElement?.getAttribute('aria-expanded') === 'true') {
    return true;
  }
  const popovers = ownerDocument.querySelectorAll(
    '[role="menu"], [role="listbox"], [role="combobox"]',
  );
  for (const popover of popovers) {
    if (popover.contains(activeElement)) {
      return true;
    }
  }
  const tooltips = ownerDocument.querySelectorAll('.tooltip');
  for (const tooltip of tooltips) {
    if (tooltip.contains(activeElement)) {
      return true;
    }
  }
  return false;
};

interface OGDialogProps extends DialogPrimitive.DialogProps {
  triggerRef?: React.RefObject<HTMLButtonElement | HTMLInputElement | HTMLDivElement | null>;
  triggerRefs?: React.RefObject<HTMLButtonElement | HTMLInputElement | HTMLDivElement | null>[];
}

const Dialog: React.ForwardRefExoticComponent<OGDialogProps & React.RefAttributes<HTMLDivElement>> =
  React.forwardRef<HTMLDivElement, OGDialogProps>(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ({ children, triggerRef, triggerRefs, onOpenChange, ...props }, ref) => {
      const parentDepth = React.useContext(DialogDepthContext);
      const currentDepth = parentDepth + 1;

      const handleOpenChange = (open: boolean) => {
        if (!open && triggerRef?.current) {
          setTimeout(() => {
            triggerRef.current?.focus();
          }, 0);
        }
        if (triggerRefs?.length) {
          triggerRefs.forEach((ref) => {
            if (ref?.current) {
              setTimeout(() => {
                ref.current?.focus();
              }, 0);
            }
          });
        }
        onOpenChange?.(open);
      };

      return (
        <DialogDepthContext.Provider value={currentDepth}>
          <DialogPrimitive.Root {...props} onOpenChange={handleOpenChange}>
            {children}
          </DialogPrimitive.Root>
        </DialogDepthContext.Provider>
      );
    },
  );

const DialogTrigger: React.ForwardRefExoticComponent<
  DialogPrimitive.DialogTriggerProps & React.RefAttributes<HTMLButtonElement>
> = DialogPrimitive.Trigger;

const DialogPortal: React.FC<DialogPrimitive.DialogPortalProps> = DialogPrimitive.Portal;

const DialogClose: React.ForwardRefExoticComponent<
  DialogPrimitive.DialogCloseProps & React.RefAttributes<HTMLButtonElement>
> = DialogPrimitive.Close;

/**
 * The scrim. `surface-overlay` is the theme's own scrim color, so a theme that
 * redefines it moves every OGDialog with it; the opacity stays at 80% because
 * that leaves the themes whose overlay is black (dark, and both high-contrast
 * modes) rendering exactly as before, and puts the light theme's gray scrim at
 * 4.3:1 against the dialog it frames — past the 3:1 floor for a non-text
 * boundary, and between the two other dialog families' scrims.
 */
export const DialogOverlay: React.ForwardRefExoticComponent<
  Omit<DialogPrimitive.DialogOverlayProps & React.RefAttributes<HTMLDivElement>, 'ref'> &
    React.RefAttributes<HTMLDivElement>
> = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, style, ...props }, ref) => {
  const depth = React.useContext(DialogDepthContext);
  const overlayZIndex = 130 + (depth - 1) * 60;

  return (
    <DialogPrimitive.Overlay
      ref={ref}
      style={{ ...style, zIndex: overlayZIndex }}
      className={cn(
        'fixed inset-0 bg-surface-overlay/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        className,
      )}
      {...props}
    />
  );
});
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

type DialogContentProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
  disableScroll?: boolean;
  overlayClassName?: string;
};

const DialogContent: React.ForwardRefExoticComponent<
  Omit<DialogPrimitive.DialogContentProps & React.RefAttributes<HTMLDivElement>, 'ref'> & {
    showCloseButton?: boolean;
    disableScroll?: boolean;
    overlayClassName?: string;
  } & React.RefAttributes<HTMLDivElement>
> = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Content>, DialogContentProps>(
  (
    {
      className,
      overlayClassName,
      showCloseButton = true,
      children,
      style,
      onEscapeKeyDown: propsOnEscapeKeyDown,
      ...props
    },
    ref,
  ) => {
    const depth = React.useContext(DialogDepthContext);
    const contentZIndex = 140 + (depth - 1) * 60;
    const contentRef = React.useRef<HTMLDivElement | null>(null);
    const composedRef = React.useCallback(
      (node: HTMLDivElement | null) => {
        contentRef.current = node;
        if (typeof ref !== 'function') {
          if (ref) {
            (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
          }
          return undefined;
        }
        /** React 19 lets a callback ref return a teardown, and swallowing it
         *  here would strand a consumer's observers and listeners on a replaced
         *  node. Only a real function is passed on: React 18 warns about any
         *  other return value. */
        const cleanup: unknown = ref(node);
        if (typeof cleanup !== 'function') {
          return undefined;
        }
        return () => {
          contentRef.current = null;
          (cleanup as () => void)();
        };
      },
      [ref],
    );

    /**
     * Radix routes Escape to the highest dismissable layer only, and a toast
     * registers one *above* whatever dialog is already open — so a status toast
     * on screen swallows the Escape that should have closed the dialog under
     * it, and the reader has to press it twice.
     *
     * A toast is transient status, not something the reader is working in, so
     * the dialog takes Escape back while one is up. Scoped to exactly that
     * case: with no toast on screen Radix's own arbitration is untouched, and
     * only the frontmost dialog acts, so an inner dialog still closes alone.
     * Closing goes through a hidden `Dialog.Close`, which drives Radix's own
     * close path and therefore works for controlled and uncontrolled dialogs
     * alike.
     */
    const escapeFallbackRef = React.useRef<HTMLButtonElement>(null);
    React.useEffect(() => {
      const handleKeyDown = (event: KeyboardEvent) => {
        const content = contentRef.current;
        if (content == null || event.key !== 'Escape' || event.isComposing) {
          return;
        }
        /** Another layer already answered this Escape — a select inside the
         *  dialog closing its own listbox, say. Forcing the dialog shut on top
         *  of that would take the reader's work with it. */
        if (event.defaultPrevented) {
          return;
        }
        const ownerDocument = content.ownerDocument;
        if (escapeBelongsToPopup(ownerDocument)) {
          return;
        }
        /** Radix Toast's own `li`. Matched whatever its `data-state`, because a
         *  toast that has begun closing keeps its dismissable layer registered
         *  until the exit animation ends — and that layer is what takes the
         *  Escape. */
        const toast = ownerDocument.querySelector('li[data-radix-collection-item]');
        if (toast == null) {
          return;
        }
        /** Read the RESOLVED z-index: dialogs outside this primitive carry
         *  theirs in a class (`ImagePreview` is `z-[250]`), and an inline-only
         *  reading scores those zero and mistakes the dialog underneath for the
         *  frontmost one. Ties fall to the later element, which is the one
         *  painted on top. */
        const stackOrder = (element: HTMLElement): number => {
          const zIndex = Number(ownerDocument.defaultView?.getComputedStyle(element).zIndex);
          return Number.isNaN(zIndex) ? 0 : zIndex;
        };
        const frontmost = Array.from(
          ownerDocument.querySelectorAll<HTMLElement>(
            '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
          ),
        ).reduce<HTMLElement | null>(
          (highest, candidate) =>
            highest == null || stackOrder(candidate) >= stackOrder(highest) ? candidate : highest,
          null,
        );
        if (frontmost !== content) {
          return;
        }
        /** Only now, with this dialog established as the one the Escape belongs
         *  to. Every mounted dialog runs this listener, and calling a consumer's
         *  handler from the ones underneath would fire their side effects for
         *  someone else's keystroke — and a `preventDefault()` there would stop
         *  the frontmost dialog from closing at all.
         *
         *  The consumer's own `onEscapeKeyDown` never ran: Radix calls it only
         *  for the highest layer, which the toast is. Give it the say it would
         *  have had, so a dialog that refuses to close on Escape still does. */
        propsOnEscapeKeyDown?.(event);
        if (event.defaultPrevented) {
          return;
        }
        escapeFallbackRef.current?.click();
      };
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }, [propsOnEscapeKeyDown]);

    /* Handle Escape key to prevent closing dialog if a tooltip or dropdown has focus
    (this is a workaround in order to achieve WCAG compliance which requires
    that our tooltips be dismissable with Escape key) */
    const handleEscapeKeyDown = React.useCallback(
      (event: KeyboardEvent) => {
        if (escapeBelongsToPopup(document)) {
          event.preventDefault();
          return;
        }

        propsOnEscapeKeyDown?.(event);
      },
      [propsOnEscapeKeyDown],
    );

    return (
      <DialogPortal>
        <DialogOverlay className={overlayClassName} />
        <DialogPrimitive.Content
          ref={composedRef}
          style={{ ...style, zIndex: contentZIndex }}
          onEscapeKeyDown={handleEscapeKeyDown}
          className={cn(
            /** `shadow-lg` is a black shadow, which carries no separation against
             *  a pure black surface, so high contrast trades it for a real edge. */
            'max-w-11/12 fixed left-[50%] top-[50%] grid max-h-[90vh] w-full translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto rounded-2xl bg-surface-dialog p-6 text-text-primary shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] high-contrast:border high-contrast:border-solid high-contrast:border-border-medium high-contrast:shadow-none',
            className,
          )}
          {...props}
        >
          {children}
          <DialogPrimitive.Close
            ref={escapeFallbackRef}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
          />
          {showCloseButton && (
            <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-ring-primary ring-offset-surface-dialog transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-text-primary focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-surface-hover data-[state=open]:text-text-secondary">
              <X className="h-6 w-6" aria-hidden="true" />
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
  <div className={cn('flex flex-col space-y-1.5 text-center sm:text-left', className)} {...props} />
);
DialogHeader.displayName = 'DialogHeader';

const DialogFooter: {
  ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
  displayName: string;
} = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): JSX.Element => (
  <div
    className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)}
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
    className={cn('text-lg font-semibold leading-none tracking-tight', className)}
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
    className={cn('text-sm text-text-secondary', className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog as OGDialog,
  DialogPortal as OGDialogPortal,
  DialogOverlay as OGDialogOverlay,
  DialogClose as OGDialogClose,
  DialogTrigger as OGDialogTrigger,
  DialogContent as OGDialogContent,
  DialogHeader as OGDialogHeader,
  DialogFooter as OGDialogFooter,
  DialogTitle as OGDialogTitle,
  DialogDescription as OGDialogDescription,
};

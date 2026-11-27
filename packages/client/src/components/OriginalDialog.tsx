import * as React from 'react';
import { X } from 'lucide-react';
import { JSX } from 'react/jsx-runtime';
import { cx } from 'class-variance-authority';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { FocusOutline } from './Focus';
import { usePortalContainer } from '../Providers/PortalContext';
import { focusOutlineVariants } from './Focus';
import { cn } from '~/utils';

const DialogDepthContext = React.createContext(0);

/** Current OGDialog nesting depth (0 when rendered outside any dialog). */
export const useDialogDepth = (): number => React.useContext(DialogDepthContext);

/**
 * Counts a dialog that is not an OGDialog, such as a Headless UI panel, as one dialog level, so
 * the popovers portaled out of it layer above it the way they do inside an OGDialog.
 */
export const DialogLayer = ({ children }: { children: React.ReactNode }): React.JSX.Element => {
  const depth = React.useContext(DialogDepthContext);
  return <DialogDepthContext.Provider value={depth + 1}>{children}</DialogDepthContext.Provider>;
};

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
    '[role="menu"], [role="listbox"], [role="combobox"][aria-expanded="true"]',
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

const dialogEscapeHandlers = new WeakMap<HTMLElement, (event: KeyboardEvent) => void>();

/** Visual order can differ from registration order while portals mount or animate out. */
const frontmostDialog = (ownerDocument: Document): HTMLElement | null => {
  const stackOrder = (element: HTMLElement): number => {
    const zIndex = Number(ownerDocument.defaultView?.getComputedStyle(element).zIndex);
    return Number.isNaN(zIndex) ? 0 : zIndex;
  };
  return Array.from(
    ownerDocument.querySelectorAll<HTMLElement>(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
    ),
  ).reduce<HTMLElement | null>(
    (highest, candidate) =>
      highest == null || stackOrder(candidate) >= stackOrder(highest) ? candidate : highest,
    null,
  );
};

/**
 * Radix routes Escape to the highest dismissable layer only, and a toast
 * registers one *above* whatever dialog is already open — so a status toast
 * on screen swallows the Escape that should have closed the dialog under
 * it, and the reader has to press it twice.
 *
 * A toast is transient status, not something the reader is working in, so
 * the frontmost dialog takes Escape back while one is up. This listener handles
 * only the toast case; native dialog callbacks also verify visual ownership.
 */
const takeEscape = (event: KeyboardEvent): void => {
  if (event.key !== 'Escape' || event.isComposing) {
    return;
  }
  /** Another layer already answered this Escape — a select inside the
   *  dialog closing its own listbox, say. Forcing the dialog shut on top
   *  of that would take the reader's work with it. */
  if (event.defaultPrevented) {
    return;
  }
  if (escapeBelongsToPopup(document)) {
    return;
  }
  /** Radix Toast's own `li`. Matched whatever its `data-state`, because a
   *  toast that has begun closing keeps its dismissable layer registered
   *  until the exit animation ends — and that layer is what takes the
   *  Escape. */
  if (document.querySelector('li[data-radix-collection-item]') == null) {
    return;
  }
  const frontmost = frontmostDialog(document);
  if (frontmost != null) dialogEscapeHandlers.get(frontmost)?.(event);
};

/** Dialog contents mounted on the page, open or closed. */
let mounted = 0;

/**
 * Keeps `takeEscape` on the document from the first dialog content to mount until the last
 * unmounts: one listener for the page. One per dialog ran on every key press for each dialog
 * mounted, and a thread mounts a closed dialog in every reply's toolbar.
 *
 * It is held while any dialog is mounted, not only while one is open, which keeps it ahead of
 * the listeners the page adds later. Radix answers a dialog's Escape in the capture phase,
 * before any of them, and this stands in for that answer: a listener that leaves an answered
 * Escape alone, as the mobile drawer's does, has to find it answered here too, or one key press
 * closes the dialog and the drawer under it.
 *
 * The count is the listener's own bookkeeping and nothing renders from it. It belongs to the
 * document, so it is kept here rather than in an atom, which would hold a listener per store.
 */
const listen = (): (() => void) => {
  if (mounted === 0) document.addEventListener('keydown', takeEscape);
  mounted += 1;
  return () => {
    mounted -= 1;
    if (mounted === 0) document.removeEventListener('keydown', takeEscape);
  };
};

interface OGDialogProps extends DialogPrimitive.DialogProps {
  triggerRef?: React.RefObject<HTMLElement | null>;
  triggerRefs?: React.RefObject<HTMLElement | null>[];
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

/** Radix's portal, into the element a `PortalProvider` names where the caller names none. */
const DialogPortal: React.FC<DialogPrimitive.DialogPortalProps> = ({ container, ...props }) => {
  const fallback = usePortalContainer();
  return <DialogPrimitive.Portal container={container ?? fallback} {...props} />;
};

const DialogClose: React.ForwardRefExoticComponent<
  DialogPrimitive.DialogCloseProps & {
    focusOutline?: FocusOutline;
  } & React.RefAttributes<HTMLButtonElement>
> = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Close>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Close> & { focusOutline?: FocusOutline }
>(({ className, focusOutline, ...props }, ref) => (
  <DialogPrimitive.Close
    ref={ref}
    className={cx(focusOutlineVariants({ focusOutline }), className) || undefined}
    {...props}
  />
));
DialogClose.displayName = DialogPrimitive.Close.displayName;

/**
 * The scrim. `surface-overlay` is the theme's own scrim color, so a theme that
 * redefines it moves every OGDialog with it. The opacity is the theme's
 * `scrimOpacity` role, which defaults to 80% because that leaves the themes
 * whose overlay is black (dark, and both high-contrast
 * modes) rendering exactly as before, and puts the light theme's gray scrim at
 * 4.3:1 against the dialog it frames, past the 3:1 floor for a non-text
 * boundary, and between the two other dialog families' scrims. Exported so a
 * caller that has to animate its own backdrop, a shared-layout morph whose dim
 * outlives the dialog's mount, consumes this appearance instead of restating it
 * in feature code.
 */
export const DIALOG_SCRIM_CLASS = 'bg-scrim';

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
        'fixed inset-0',
        DIALOG_SCRIM_CLASS,
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
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
  /**
   * Drop the default centering, surface and enter/exit classes so the caller owns the
   * dialog's geometry and animation (e.g. a shared-layout morph). Dialog semantics —
   * focus trap, Escape, scroll lock, aria wiring — are unchanged.
   */
  bare?: boolean;
  /** Keep the portal mounted while closed so the caller can animate the exit itself. */
  forceMount?: true;
  focusOutline?: FocusOutline;
};

/** Positioning and appearance a `bare` content opts out of. */
const DIALOG_SURFACE_CLASSES =
  /** `shadow-lg` is a black shadow, which carries no separation against
   *  a pure black surface, so high contrast trades it for a real edge. The
   *  theme's own edge is `dialogStroke`, none by default. The
   *  centering `translate-*` is the `translate` property, which the enter and
   *  exit keyframes' `transform` composes with instead of replacing, so the
   *  slide names only the 2% the surface travels. */
  'left-[50%] top-[50%] grid max-h-[90vh] w-full translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto rounded-2xl border-(length:--theme-dialog-stroke) border-border-light bg-surface-dialog py-6 px-theme-dialog-x shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-bottom-[2%] data-[state=open]:slide-in-from-bottom-[2%] high-contrast:border high-contrast:border-solid high-contrast:border-border-medium high-contrast:shadow-none';

const DialogContent: React.ForwardRefExoticComponent<
  Omit<DialogPrimitive.DialogContentProps & React.RefAttributes<HTMLDivElement>, 'ref'> & {
    showCloseButton?: boolean;
    disableScroll?: boolean;
    overlayClassName?: string;
    bare?: boolean;
    forceMount?: true;
    focusOutline?: FocusOutline;
  } & React.RefAttributes<HTMLDivElement>
> = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Content>, DialogContentProps>(
  (
    {
      className,
      overlayClassName,
      showCloseButton = true,
      bare = false,
      forceMount,
      focusOutline,
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
    const closeOnEscapeRef = React.useRef<(event: KeyboardEvent) => void>(() => undefined);
    const composedRef = React.useCallback(
      (node: HTMLDivElement | null) => {
        if (contentRef.current != null) dialogEscapeHandlers.delete(contentRef.current);
        contentRef.current = node;
        if (node != null)
          dialogEscapeHandlers.set(node, (event) => closeOnEscapeRef.current(event));
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
          if (node != null) dialogEscapeHandlers.delete(node);
          contentRef.current = null;
          (cleanup as () => void)();
        };
      },
      [ref],
    );

    /**
     * What `takeEscape` runs for this dialog when it is the one in front. Closing
     * goes through a hidden `Dialog.Close`, which drives Radix's own close path
     * and therefore works for controlled and uncontrolled dialogs alike.
     */
    const escapeFallbackRef = React.useRef<HTMLButtonElement>(null);
    closeOnEscapeRef.current = (event) => {
      propsOnEscapeKeyDown?.(event);
      if (event.defaultPrevented) return;
      event.preventDefault();
      escapeFallbackRef.current?.click();
    };
    React.useEffect(listen, []);

    /* Handle Escape key to prevent closing dialog if a tooltip or dropdown has focus
    (this is a workaround in order to achieve WCAG compliance which requires
    that our tooltips be dismissable with Escape key) */
    const handleEscapeKeyDown = React.useCallback(
      (event: KeyboardEvent) => {
        if (event.defaultPrevented) return;
        const content = contentRef.current;
        const ownerDocument = content?.ownerDocument ?? document;
        if (escapeBelongsToPopup(ownerDocument)) {
          event.preventDefault();
          return;
        }

        const frontmost = frontmostDialog(ownerDocument);
        const closeFrontmost = frontmost && dialogEscapeHandlers.get(frontmost);
        if (frontmost != null && frontmost !== content) {
          closeFrontmost?.(event);
          event.preventDefault();
          return;
        }
        propsOnEscapeKeyDown?.(event);
      },
      [propsOnEscapeKeyDown],
    );

    return (
      <DialogPortal forceMount={forceMount}>
        <DialogOverlay className={overlayClassName} />
        <DialogPrimitive.Content
          ref={composedRef}
          style={{ ...style, zIndex: contentZIndex }}
          onEscapeKeyDown={handleEscapeKeyDown}
          className={cn(
            'text-text-primary fixed',
            !bare && DIALOG_SURFACE_CLASSES,
            focusOutlineVariants({ focusOutline }),
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
            <DialogPrimitive.Close className="ring-ring-primary ring-offset-surface-dialog focus:ring-focus-control data-[state=open]:bg-surface-hover data-[state=open]:text-text-secondary min-h-theme-target min-w-theme-target absolute inset-e-4 top-4 inline-flex items-center justify-center rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none">
              <X className="size-theme-icon-lg" aria-hidden="true" />
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
    className={cn('space-y-theme-dialog-header flex flex-col text-center sm:text-start', className)}
    {...props}
  />
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
  Omit<DialogPrimitive.DialogTitleProps & React.RefAttributes<HTMLHeadingElement>, 'ref'> & {
    focusOutline?: FocusOutline;
  } & React.RefAttributes<HTMLHeadingElement>
> = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title> & { focusOutline?: FocusOutline }
>(({ className, focusOutline, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      'font-theme-dialog-title font-theme-dialog-title-weight text-dialog-title text-(length:--theme-dialog-title-size) leading-(--theme-dialog-title-leading) tracking-tight',
      focusOutlineVariants({ focusOutline }),
      className,
    )}
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
    className={cn('text-text-secondary text-sm', className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

/** `Dialog*` are the canonical names. The `OG*` names are the same components under the names the
 *  app has always imported, kept so existing call sites need no change. */
export {
  Dialog,
  DialogPortal,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
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

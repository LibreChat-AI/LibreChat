import {
  cn,
  composerSurfaceClasses,
  composerSurfaceShadow,
  composerPlacementTransition,
} from '@librechat/client';
import type { FormEventHandler, MouseEvent, ReactNode, RefObject } from 'react';

/** Marks an element inside the composer surface that keeps focus when clicked, so the surface
 *  does not pull focus back to the draft. Native controls, popup triggers and popup content are
 *  exempt already. */
export const COMPOSER_FOCUS_OWNER_ATTRIBUTE = 'data-composer-focus-owner';

/** Clicks the surface leaves to their target: controls that take focus, popup triggers (Ariakit
 *  and Radix both emit `aria-haspopup`), popup content (React bubbles through portals), and any
 *  element a caller marks with {@link COMPOSER_FOCUS_OWNER_ATTRIBUTE}. */
const FOCUS_OWNER_SELECTOR = [
  'a',
  'input',
  'select',
  'textarea',
  'label',
  '[aria-haspopup]:not([aria-haspopup="false"])',
  '[role="combobox"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  `[${COMPOSER_FOCUS_OWNER_ATTRIBUTE}]`,
].join(', ');

export interface ComposerFrameProps {
  onSubmit: FormEventHandler<HTMLFormElement>;
  /** A forced direction mirrors the whole composer; `auto` leaves layout to the page. */
  direction: 'ltr' | 'rtl' | 'auto';
  /** Lets the composer span the whole chat column instead of the reading width. */
  maximizeChatSpace: boolean;
  /** The bottom margin that keeps the composer clear of what sits under it. */
  clearanceClassName?: string;
  /** The draft has focus: the surface lifts. */
  focused: boolean;
  /** A temporary chat: the surface carries the temporary accent. */
  isTemporary: boolean;
  /** The surface element, for popups anchored to the whole composer. */
  surfaceRef?: RefObject<HTMLDivElement>;
  /** A click on the surface that no control claimed; the host focuses the draft. */
  onFocusDraft: () => void;
  /** The selection quote control, beside the composer column. */
  quote?: ReactNode;
  /** The steering queue above the composer. */
  queue?: ReactNode;
  /** Context chips on a rail tucked under the top of the surface; nothing renders without them. */
  contextRail?: ReactNode;
  /** The command popovers and panels that float over the surface. */
  popovers?: ReactNode;
  /** The hint line under the surface. */
  hints?: ReactNode;
  /** The surface's content: header, tray, text field, status lines and the action bar. */
  children: ReactNode;
}

/** The composer's layout: the form, the column the queue and context rail stack in, the surface
 *  that holds the draft, and the hints under it. */
export default function ComposerFrame({
  onSubmit,
  direction,
  maximizeChatSpace,
  clearanceClassName,
  focused,
  isTemporary,
  surfaceRef,
  onFocusDraft,
  quote,
  queue,
  contextRail,
  popovers,
  hints,
  children,
}: ComposerFrameProps): React.JSX.Element {
  const handleSurfaceClick = (event: MouseEvent<HTMLDivElement>) => {
    const owner =
      event.target instanceof Element ? event.target.closest(FOCUS_OWNER_SELECTOR) : null;
    if (owner && !owner.contains(event.currentTarget)) {
      return;
    }
    onFocusDraft();
  };

  return (
    <form
      dir={direction === 'auto' ? undefined : direction}
      onSubmit={onSubmit}
      className={cn(
        'mx-auto flex w-full flex-row gap-3 sm:px-2',
        composerPlacementTransition(),
        maximizeChatSpace ? 'max-w-full' : 'md:max-w-3xl xl:max-w-4xl',
        clearanceClassName,
      )}
    >
      {/* `min-w-0`: one long unbroken word in a queued message would otherwise stretch the
          composer past the thread; zeroing it lets the chips inside truncate instead. */}
      <div className="relative flex h-full min-w-0 flex-1 items-stretch md:flex-col">
        {quote}
        <div className="relative flex w-full flex-col">
          {queue}
          {contextRail != null && typeof contextRail !== 'boolean' && (
            <div
              data-testid="composer-context-rail"
              className="border-border-light bg-surface-secondary mx-4 -mb-3 flex min-w-0 flex-wrap items-center gap-1.5 rounded-t-2xl border px-2 pt-2 pb-5"
            >
              {contextRail}
            </div>
          )}
          <div className="flex w-full items-center">
            {popovers}
            <div
              ref={surfaceRef}
              data-testid="composer-surface"
              onClick={handleSurfaceClick}
              className={cn(
                /* Squared off at the bottom below `sm`, where the surface runs to the viewport
                   floor and the action row is the last thing in it. */
                'rounded-t-theme-surface-lg sm:rounded-theme-surface-lg relative flex w-full grow flex-col overflow-hidden',
                composerSurfaceClasses(),
                focused ? composerSurfaceShadow.focused : composerSurfaceShadow.blurred,
                /* The temporary accent layers a series-6 tint over the opaque surface, at half
                   alpha in the standard palettes and opaque in the contrast modes, where only
                   that clears the 3:1 non-text floor. */
                isTemporary &&
                  'border-series-6/50 from-series-6/10 to-series-6/10 high-contrast:border-series-6 bg-linear-to-b',
              )}
            >
              {children}
            </div>
          </div>
          {hints}
        </div>
      </div>
    </form>
  );
}

import React, { useEffect, useRef, useState } from 'react';
import type { TOptions } from 'i18next';
import type { TranslationKeys } from '~/hooks/useLocalize';
import { cn } from '~/utils';

interface ConvoLinkProps {
  isActiveConvo: boolean;
  isPopoverActive: boolean;
  isHovered: boolean;
  isSharedBadgeVisible: boolean;
  title: string | null;
  onRename: () => void;
  isSmallScreen: boolean;
  localize: (key: TranslationKeys, options?: TOptions) => string;
  /** Shortcuts the row responds to, declared on the element that takes focus so
   *  assistive tech announces them when the user arrives here. */
  keyShortcuts?: string;
  children: React.ReactNode;
}

const TITLE_SPEED_PX_PER_SECOND = 30;
const TITLE_START_DELAY_MS = 600;
const TITLE_HOLD_MS = 2000;

/** Legacy engines expose only `addListener` on MediaQueryList. */
const observeMediaQuery = (query: MediaQueryList, onChange: () => void) => {
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }

  query.addListener(onChange);
  return () => query.removeListener(onChange);
};

const ConvoLink: React.FC<ConvoLinkProps> = ({
  isActiveConvo,
  isPopoverActive,
  isHovered,
  isSharedBadgeVisible,
  title,
  onRename,
  isSmallScreen,
  localize,
  keyShortcuts,
  children,
}) => {
  const [isOverflowing, setIsOverflowing] = useState(false);
  const titleRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const displayTitle = title || localize('com_ui_untitled');

  useEffect(() => {
    const viewport = titleRef.current;
    const text = textRef.current;
    if (!viewport || !text) {
      return;
    }

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let animation: Animation | undefined;
    let frame = 0;

    const start = () => {
      animation?.cancel();
      cancelAnimationFrame(frame);
      delete viewport.dataset.titleRevealed;
      const overflow = text.getBoundingClientRect().width - viewport.getBoundingClientRect().width;
      setIsOverflowing(overflow > 0);
      if (!isHovered || isSmallScreen || reducedMotion.matches || overflow <= 0) {
        return;
      }

      const style = getComputedStyle(viewport);
      const direction = style.direction === 'rtl' ? 1 : -1;
      const revealDuration = parseFloat(style.getPropertyValue('--convo-title-reveal-duration'));
      const travelDuration = (overflow / TITLE_SPEED_PX_PER_SECOND) * 1000;
      const duration = travelDuration + TITLE_HOLD_MS;
      const end = `translateX(${direction * overflow}px)`;

      animation = text.animate(
        [
          { transform: 'translateX(0)' },
          { transform: end, offset: travelDuration / duration },
          { transform: end },
        ],
        {
          duration,
          delay: TITLE_START_DELAY_MS,
          iterations: Infinity,
          easing: 'linear',
        },
      );

      /** The fade retreats as the ending arrives, so the last characters read
       * clearly without the text overscrolling past the available width. CSS owns
       * the mask because Web Animations cannot carry the `-webkit-` fallback that
       * older WebKit needs. */
      const revealFrom = Math.max(0, travelDuration - revealDuration);
      const tick = () => {
        const currentTime = typeof animation?.currentTime === 'number' ? animation.currentTime : 0;
        const elapsed = currentTime - TITLE_START_DELAY_MS;
        viewport.dataset.titleRevealed = String(elapsed > 0 && elapsed % duration >= revealFrom);
        frame = requestAnimationFrame(tick);
      };

      tick();
    };

    const observer = new ResizeObserver(start);
    observer.observe(viewport);
    observer.observe(text);
    const unobserveMediaQuery = observeMediaQuery(reducedMotion, start);
    start();

    return () => {
      observer.disconnect();
      unobserveMediaQuery();
      animation?.cancel();
      cancelAnimationFrame(frame);
      delete viewport.dataset.titleRevealed;
    };
  }, [isHovered, isSmallScreen, displayTitle]);

  return (
    <button
      type="button"
      className={cn(
        'flex w-full min-w-0 grow cursor-pointer items-center gap-2 overflow-hidden rounded-lg px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-text-primary',
        isActiveConvo || isPopoverActive ? 'bg-surface-active-alt' : '',
      )}
      aria-current={isActiveConvo ? 'page' : undefined}
      aria-keyshortcuts={keyShortcuts}
      aria-label={
        isSharedBadgeVisible
          ? localize('com_ui_conversation_label_shared', {
              title: title || localize('com_ui_untitled'),
            })
          : localize('com_ui_conversation_label', {
              title: title || localize('com_ui_untitled'),
            })
      }
    >
      {children}
      <span
        ref={titleRef}
        className={cn(
          'min-w-0 flex-1 overflow-hidden whitespace-nowrap [--convo-title-fade-width:24px] [--convo-title-reveal-duration:800ms] [mask-position:left] [mask-repeat:no-repeat] [mask-size:100%_100%] [text-align:start] [transition-duration:0ms] [transition-property:mask-size] [transition-timing-function:linear] [&:dir(rtl)]:[mask-position:right]',
          isOverflowing &&
            '[mask-image:linear-gradient(to_right,currentColor_calc(100%_-_var(--convo-title-fade-width)),transparent)] [&:dir(rtl)]:[mask-image:linear-gradient(to_left,currentColor_calc(100%_-_var(--convo-title-fade-width)),transparent)]',
          'data-[title-revealed=true]:[mask-size:calc(100%_+_var(--convo-title-fade-width))_100%] data-[title-revealed=true]:[transition-duration:var(--convo-title-reveal-duration)]',
        )}
        onDoubleClick={(e) => {
          if (isSmallScreen) {
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          onRename();
        }}
      >
        <span ref={textRef} className="inline-block">
          {displayTitle}
        </span>
      </span>
    </button>
  );
};

export default ConvoLink;

import React, { useLayoutEffect, useMemo, useRef } from 'react';
import {
  measureWords,
  tokenizeWords,
  wordOffset,
  WHITESPACE_TOKEN,
  type WordBox,
} from './descriptionMorph';
import {
  EASE_OUT_CSS,
  WORD_FADE_MS,
  WORD_RETURN_MS,
  WORD_SETTLE_MS,
  WORD_TRAVEL_MS,
} from './morph';

interface DescriptionWordsProps {
  text: string;
  /**
   * Supplies the card's description paragraph: the wrapping the words arrive
   * from, and the one they go back to before the surface is handed over. Null
   * once the card has left the list, which leaves every word to the dissolve.
   * Asked at the moment of the morph rather than held as a ref, so it cannot
   * depend on which side of the grid React attached first.
   */
  source: () => HTMLElement | null;
  /** `closing` runs the return trip, inside the dialog's handoff window. */
  phase: 'open' | 'closing';
}

/**
 * The dialog's description, morphed word by word out of the card's.
 *
 * Each word the card showed travels from where that paragraph wrapped it to
 * where this one does, on top of the shared layout animation that carries the
 * paragraph itself — the card's wrapping resolves into the dialog's rather than
 * being replaced by it. The words only move, on the morph's own duration and
 * curve, so the copy reads as one of the fields travelling beside the title
 * rather than an effect of its own: no per-word delay, no blur, no scaling. The
 * lines the card's clamp hid have nowhere to travel from, so they fade in over
 * the same span.
 *
 * The words are written to directly rather than re-rendered: a paragraph can be
 * hundreds of transitions, every one of them a transform or an opacity, so the
 * whole re-wrap runs on the compositor without a frame of React or
 * animation-loop work per word. (There is no WebGPU path for this: WebGPU draws
 * into a canvas and cannot lay out or paint DOM text. Keeping every animated
 * property off the layout and paint paths is what hands this to the GPU.)
 *
 * Assistive technology reads the copy once, from the flat string; the words
 * themselves are decoration and are hidden from it.
 */
export default function DescriptionWords({ text, source, phase }: DescriptionWordsProps) {
  const tokens = useMemo(() => tokenizeWords(text), [text]);
  const spansRef = useRef<Array<HTMLSpanElement | null>>([]);
  const animatedPhaseRef = useRef<'open' | 'closing'>();
  const settleRef = useRef<number>();

  useLayoutEffect(() => {
    const spans = spansRef.current;
    const clearStyles = () => {
      for (const span of spans) {
        if (span != null) {
          span.style.cssText = '';
        }
      }
    };
    const cleanup = () => {
      window.clearTimeout(settleRef.current);
      settleRef.current = undefined;
      clearStyles();
    };
    /* One run per phase, so new copy landing under an open dialog is text at
       rest rather than a second morph. A phase that comes back — a reopen
       interrupting a close — does run again: the words are on their way back to
       the card's wrapping and have to turn around, not stay there. */
    if (spans.length === 0 || animatedPhaseRef.current === phase) {
      /* The previous effect's cleanup runs before this same-phase guard. Clear
         again here so reused spans cannot retain compositor hints when copy
         changed during the phase. Clearing keeps refreshed text at rest instead
         of visibly replaying an opening morph for the new copy. */
      cleanup();
      return;
    }
    animatedPhaseRef.current = phase;
    cleanup();

    const paragraph = source();
    const sourceBoxes = paragraph == null ? null : measureWords(paragraph, tokens);
    /* Every box is read before any style is written, so the two paragraphs are
       laid out once for the whole phase instead of once per word. */
    const targets: Array<WordBox | undefined> = spans.map((span) =>
      span == null ? undefined : { x: span.offsetLeft, y: span.offsetTop },
    );
    const travels: Array<string | undefined> = new Array(spans.length);
    for (let index = 0; index < spans.length; index++) {
      if (spans[index] == null) {
        continue;
      }
      const box = sourceBoxes?.[index];
      const target = targets[index];
      if (box != null && box.visible && target != null) {
        travels[index] = wordOffset(box, target);
      }
    }

    if (phase === 'closing') {
      for (let index = 0; index < spans.length; index++) {
        const span = spans[index];
        if (span == null) {
          continue;
        }
        span.style.willChange = 'transform, opacity';
        const travel = travels[index];
        if (travel != null) {
          span.style.transition = `transform ${WORD_RETURN_MS}ms ${EASE_OUT_CSS}`;
          span.style.transform = travel;
        } else {
          /* The lines the card cannot show leave the way they arrived. */
          span.style.transition = `opacity ${WORD_RETURN_MS}ms ${EASE_OUT_CSS}`;
          span.style.opacity = '0';
        }
      }
      return cleanup;
    }

    for (let index = 0; index < spans.length; index++) {
      const span = spans[index];
      if (span == null) {
        continue;
      }
      span.style.transformOrigin = '0 0';
      span.style.willChange = 'transform, opacity';
      span.style.transition = 'none';
      const travel = travels[index];
      if (travel != null) {
        span.style.transform = travel;
      } else {
        span.style.opacity = '0';
      }
    }
    /* Forcing one style recalculation between the two writes is what makes the
       browser interpolate them, and doing it here rather than on the next frame
       is what starts the words on the same frame as the surface. A frame later
       would be a second animation, a frame behind. */
    void document.body.offsetHeight;
    for (let index = 0; index < spans.length; index++) {
      const span = spans[index];
      if (span == null) {
        continue;
      }
      if (travels[index] != null) {
        span.style.transition = `transform ${WORD_TRAVEL_MS}ms ${EASE_OUT_CSS}`;
        span.style.transform = 'none';
      } else {
        span.style.transition = `opacity ${WORD_FADE_MS}ms ${EASE_OUT_CSS}`;
        span.style.opacity = '1';
      }
    }
    /* Layer promotion is worth it for the flight and a liability at rest. */
    settleRef.current = window.setTimeout(() => {
      clearStyles();
      settleRef.current = undefined;
    }, WORD_SETTLE_MS);

    return cleanup;
  }, [phase, source, tokens]);

  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {tokens.map((token, index) =>
          WHITESPACE_TOKEN.test(token) ? (
            token
          ) : (
            <span
              key={`${index}-${token}`}
              ref={(node) => {
                spansRef.current[index] = node;
              }}
              className="inline-block"
            >
              {token}
            </span>
          ),
        )}
      </span>
    </>
  );
}

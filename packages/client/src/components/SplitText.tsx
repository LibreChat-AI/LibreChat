import { useEffect, useMemo, useRef, useState } from 'react';
import { useSprings, animated, SpringConfig } from '@react-spring/web';
import useRemScale from '~/hooks/useRemScale';

interface SegmenterOptions {
  granularity?: 'grapheme' | 'word' | 'sentence';
  localeMatcher?: 'lookup' | 'best fit';
}

interface SegmentData {
  segment: string;
  index: number;
  input: string;
  isWordLike?: boolean;
}

interface Segments {
  [Symbol.iterator](): IterableIterator<SegmentData>;
}

interface IntlSegmenter {
  segment(input: string): Segments;
}

interface IntlSegmenterConstructor {
  new (locales?: string | string[], options?: SegmenterOptions): IntlSegmenter;
}

declare global {
  interface Intl {
    Segmenter: IntlSegmenterConstructor;
  }
}

interface SplitTextProps {
  text?: string;
  className?: string;
  delay?: number;
  animationFrom?: { opacity: number; transform: string };
  animationTo?: { opacity: number; transform: string };
  easing?: SpringConfig['easing'];
  threshold?: number;
  rootMargin?: string;
  textAlign?: 'left' | 'right' | 'center' | 'justify' | 'start' | 'end';
  onLetterAnimationComplete?: () => void;
  onLineCountChange?: (lineCount: number) => void;
}

let segmenter: IntlSegmenter | null | undefined;

const getSegmenter = (): IntlSegmenter | null => {
  if (segmenter === undefined) {
    segmenter =
      typeof Intl !== 'undefined' && 'Segmenter' in Intl
        ? new (Intl as typeof Intl & { Segmenter: IntlSegmenterConstructor }).Segmenter('en', {
            granularity: 'grapheme',
          })
        : null;
  }
  return segmenter;
};

const splitGraphemes = (text: string): string[] => {
  const instance = getSegmenter();
  if (instance) {
    return Array.from(instance.segment(text)).map((s: SegmentData) => s.segment);
  }
  return [...text];
};

const JOINING_SCRIPT =
  /[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Nko}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}\p{Script=Mongolian}]/u;
const RTL_SCRIPTS = [
  'Arabic',
  'Hebrew',
  'Syriac',
  'Thaana',
  'Nko',
  'Samaritan',
  'Mandaic',
  'Adlam',
  'Hanifi_Rohingya',
]
  .map((script) => `\\p{Script=${script}}`)
  .join('');
const RTL_LETTER = new RegExp(`[${RTL_SCRIPTS}]`, 'u');
const LTR_LETTER = new RegExp(`(?![${RTL_SCRIPTS}])\\p{L}`, 'u');

/**
 * Whether the text must reach the browser as one run. Every animated box is an atomic inline,
 * so letters in separate boxes cannot join (Arabic, Persian) and words in separate boxes are not
 * reordered against each other, which scrambles a right-to-left name inside a left-to-right
 * greeting.
 */
const needsWholeText = (text: string): boolean =>
  JOINING_SCRIPT.test(text) || (RTL_LETTER.test(text) && LTR_LETTER.test(text));

const SplitText: React.FC<SplitTextProps> = ({
  text = '',
  className = '',
  delay = 100,
  animationFrom = { opacity: 0, transform: 'translate3d(0,40px,0)' },
  animationTo = { opacity: 1, transform: 'translate3d(0,0,0)' },
  easing = (t: number) => t,
  threshold = 0.1,
  rootMargin = '-100px',
  textAlign = 'center',
  onLetterAnimationComplete,
  onLineCountChange,
}) => {
  const whole = useMemo(() => needsWholeText(text), [text]);
  const { words, letterCount, offsets } = useMemo(() => {
    if (whole) {
      return { words: [[text]], letterCount: 1, offsets: [0] };
    }
    const split = text.split(' ').map(splitGraphemes);
    const starts: number[] = [];
    let total = 0;
    for (const w of split) {
      starts.push(total);
      total += w.length;
    }
    return { words: split, letterCount: total, offsets: starts };
  }, [text, whole]);
  const [inView, setInView] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  const animatedCount = useRef(0);
  const remScale = useRemScale();

  const [springs] = useSprings(
    letterCount,
    (i) => ({
      from: animationFrom,
      to: inView
        ? async (next) => {
            await next(animationTo);
            animatedCount.current += 1;
            if (animatedCount.current === letterCount && onLetterAnimationComplete) {
              onLetterAnimationComplete();
            }
          }
        : animationFrom,
      delay: i * delay,
      config: { easing },
    }),
    [inView, text, delay, animationFrom, animationTo, easing, onLetterAnimationComplete],
  );

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          if (ref.current) {
            observer.unobserve(ref.current);
          }
        }
      },
      { threshold, rootMargin },
    );

    if (ref.current) {
      observer.observe(ref.current);
    }

    return () => observer.disconnect();
  }, [threshold, rootMargin]);

  useEffect(() => {
    const element = ref.current;
    if (!element || !inView || !onLineCountChange) {
      return;
    }
    const timeout = setTimeout(() => {
      const style = getComputedStyle(element);
      const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
      onLineCountChange(Math.round(element.offsetHeight / lineHeight));
    }, 100);
    return () => clearTimeout(timeout);
  }, [inView, text, onLineCountChange, remScale]);

  return (
    <>
      <p
        ref={ref}
        dir="auto"
        className={`split-parent inline overflow-hidden ${className}`}
        style={{ textAlign, whiteSpace: 'normal', wordWrap: 'break-word' }}
      >
        {/* The paragraph's auto direction ignores word boxes with their own dir. */}
        <span className="sr-only">{text}</span>
        {/* A whole run wraps like ordinary text, and its taller line keeps Arabic-script
            descenders inside the parent's overflow clip. */}
        {words.map((word, wordIndex) => (
          <span
            key={wordIndex}
            dir="auto"
            aria-hidden="true"
            className={whole ? undefined : 'inline-block whitespace-nowrap'}
          >
            {word.map((letter, letterIndex) => {
              const index = offsets[wordIndex] + letterIndex;

              return (
                <animated.span
                  key={index}
                  style={springs[index]}
                  className={`inline-block transform transition-opacity will-change-transform ${whole ? 'leading-snug' : ''}`}
                >
                  {letter}
                </animated.span>
              );
            })}
            {wordIndex < words.length - 1 && (
              <span style={{ display: 'inline-block', width: '0.3em' }}>&nbsp;</span>
            )}
          </span>
        ))}
      </p>
    </>
  );
};

export default SplitText;

import { useLayoutEffect, useRef } from 'react';
import { JSX } from 'react/jsx-runtime';
import { cn } from '~/utils/';
import './Spinner.css';

const ROTATION_NAME = 'librechat-spinner-rotate';
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

const pending = new Set<SVGSVGElement>();

/** Only the spinner's own rotation is pinned: `className` can add other animations. */
const isRotation = (animation: Animation): boolean =>
  (animation as Partial<CSSAnimation>).animationName === ROTATION_NAME;

/** Reads every pending animation before writing any start time: a write dirties style, so
 *  interleaving them would force one style recalculation per spinner. */
function pinPending() {
  const animations = [...pending].flatMap((svg) => svg.getAnimations?.().filter(isRotation) ?? []);
  pending.clear();
  animations.forEach((animation) => {
    animation.startTime = 0;
  });
}

function schedulePin(svg: SVGSVGElement) {
  pending.add(svg);
  if (pending.size === 1) {
    queueMicrotask(pinPending);
  }
}

interface SpinnerProps {
  className?: string;
  size?: string | number;
  color?: string;
  bgOpacity?: number;
  speed?: number;
  /** Stroke width in viewBox units (the box is 40 wide); thinner reads as a quieter ring. */
  strokeWidth?: number;
}

/**
 * Accessible loading spinner.
 *
 * Animation is defined in Spinner.css (extracted into the package style bundle),
 * never an embedded <style> tag: stylesheet text inside the SVG becomes part of
 * the ancestor's textContent, leaking raw CSS into label readouts of any control
 * that wraps a spinner.
 */
export default function Spinner({
  className = 'm-auto',
  size = 20,
  color = 'currentColor',
  bgOpacity = 0.1,
  speed = 0.75,
  strokeWidth = 5,
}: SpinnerProps): JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null);

  /** Every spinner starts its rotation at the document timeline origin, so one that mounts
   *  while others spin joins them in phase instead of restarting at zero. A spinner mounted
   *  under reduced motion has no rotation yet, so it is pinned again when the preference
   *  changes and the rotation begins. */
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) {
      return;
    }
    schedulePin(svg);
    const query = window.matchMedia?.(REDUCED_MOTION);
    const onChange = () => schedulePin(svg);
    query?.addEventListener('change', onChange);
    return () => {
      pending.delete(svg);
      query?.removeEventListener('change', onChange);
    };
  }, [speed]);

  const cssVars = {
    '--spinner-speed': `${speed}s`,
  } as React.CSSProperties;

  return (
    <svg
      ref={svgRef}
      className={cn(className, 'spinner')}
      width={size}
      height={size}
      viewBox="0 0 40 40"
      xmlns="http://www.w3.org/2000/svg"
      style={cssVars}
      aria-hidden="true"
      focusable="false"
      role="presentation"
    >
      <circle
        cx="20"
        cy="20"
        r="14.5"
        pathLength="100"
        strokeWidth={strokeWidth}
        fill="none"
        stroke={color}
        strokeOpacity={bgOpacity}
      />
      <circle
        cx="20"
        cy="20"
        r="14.5"
        pathLength="100"
        strokeWidth={strokeWidth}
        fill="none"
        stroke={color}
        strokeDasharray="25 75"
        strokeLinecap="round"
      />
    </svg>
  );
}

import { JSX } from 'react/jsx-runtime';
import { cn } from '~/utils/';
import './Spinner.css';

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
  const cssVars = {
    '--spinner-speed': `${speed}s`,
  } as React.CSSProperties;

  return (
    <svg
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

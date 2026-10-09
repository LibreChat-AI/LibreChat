import { JSX } from 'react/jsx-runtime';
import type { SVGProps } from 'react';
import { cn } from '~/utils';

/** Verified mark for a first-party item: a scalloped badge filled with
 *  `currentColor` (pair it with `text-status-verified`) carrying a check in
 *  `text-on-status`. The badge is painted, never stroked — an outline would
 *  read as a light halo against the card it sits on. */
export default function VerifiedIcon({
  className,
  ...props
}: SVGProps<SVGSVGElement>): JSX.Element {
  const labelled = props['aria-label'] != null || props['aria-labelledby'] != null;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      height="1em"
      width="1em"
      xmlns="http://www.w3.org/2000/svg"
      role={labelled ? 'img' : undefined}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
      className={cn('h-4 w-4', className)}
      {...props}
    >
      <path
        d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"
        fill="currentColor"
      />
      <path
        d="m8.4 12.3 2.5 2.5 4.7-4.7"
        className="stroke-text-on-status"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

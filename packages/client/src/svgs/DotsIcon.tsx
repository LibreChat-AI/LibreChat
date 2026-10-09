import React from 'react';
import { JSX } from 'react/jsx-runtime';

export default function DotsIcon({
  className = 'h-4 w-4 shrink-0 text-text-secondary',
}: {
  className?: string;
}): JSX.Element {
  return (
    <svg
      stroke="currentColor"
      fill="none"
      strokeWidth="2"
      viewBox="0 0 24 24"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      height="1em"
      width="1em"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </svg>
  );
}

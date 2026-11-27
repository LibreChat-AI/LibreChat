import React from 'react';
import { JSX } from 'react/jsx-runtime';
import { cn } from '~/utils/';

export default function CrossIcon({
  className = '',
}: {
  className?: string | undefined;
}): JSX.Element {
  return (
    <svg
      stroke="currentColor"
      fill="none"
      strokeWidth="2"
      viewBox="0 0 24 24"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn(className, 'h-4 w-4')}
      height="1em"
      width="1em"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

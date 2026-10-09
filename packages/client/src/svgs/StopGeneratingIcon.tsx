import { JSX } from 'react/jsx-runtime';
import { cn } from '~/utils';

export default function StopGeneratingIcon({
  className = '',
}: {
  className?: string;
}): JSX.Element {
  return (
    <svg
      stroke="currentColor"
      fill="none"
      strokeWidth="2.5"
      viewBox="0 0 24 24"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('h-3 w-3 text-text-secondary', className)}
      height="1em"
      width="1em"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
    </svg>
  );
}

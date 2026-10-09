import { JSX } from 'react/jsx-runtime';
import { cn } from '~/utils';

export default function AssistantIcon({
  className = '',
  size = '1em',
}: {
  className?: string;
  size?: string | number;
}): JSX.Element {
  const unit = 24;
  const height = size;
  const width = size;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${unit} ${unit}`}
      stroke="currentColor"
      fill="none"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('h-2/3 w-2/3 text-text-secondary', className)}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  );
}

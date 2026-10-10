import { JSX } from 'react/jsx-runtime';
import { cn } from '~/utils';
export default function CodeyIcon({
  size = 25,
  className = '',
}: {
  size?: number;
  className?: string;
}): JSX.Element {
  return (
    <svg
      // width="100%"
      // height="100%"
      width={size}
      height={size}
      className={cn('fill-text-primary', className)}
      viewBox="0 0 18 18"
      preserveAspectRatio="xMidYMid meet"
      focusable="false"
      aria-hidden="true"
    >
      <path
        d="M2 4.006C2 2.898 2.897 2 4.006 2h9.988C15.102 2 16 2.897 16 4.006v9.988A2.005 2.005 0 0 1 13.994 16H4.006A2.005 2.005 0 0 1 2 13.994V4.006zM13.992 9l.003-.003L10.997 6 9.75 7.247 11.503 9 9.75 10.753 10.997 12l2.997-2.997L13.992 9zm-9.99 0L4 8.997 6.997 6l1.247 1.247L6.492 9l1.753 1.753L6.997 12 4 9.003 4.003 9z"
        fillRule="evenodd"
      />
    </svg>
  );
}

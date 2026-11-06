import { JSX } from 'react/jsx-runtime';

/**
 * `size-[1.125rem]` is the 18px default expressed in rem: the CSS dimensions win over
 * the attributes below, so the glyph follows every scaled container it sits in without
 * each caller having to size it.
 */
export default function UserIcon({
  className = 'size-[1.125rem]',
}: {
  className?: string | undefined;
} = {}): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

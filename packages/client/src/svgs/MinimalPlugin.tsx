import { JSX } from 'react/jsx-runtime';

export default function MinimalPlugin({
  size,
  className = 'icon-md',
}: {
  size?: number;
  className?: string;
}): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M15.4646 19C15.2219 20.6961 13.7632 22 12 22C10.2368 22 8.77806 20.6961 8.53544 19H6C4.34315 19 3 17.6569 3 16V13.5C3 12.9477 3.44772 12.5 4 12.5H4.5C5.32843 12.5 6 11.8284 6 11C6 10.1716 5.32843 9.5 4.5 9.5H4C3.44772 9.5 3 9.05229 3 8.5L3 6C3 4.34315 4.34315 3 6 3L18 3C19.6569 3 21 4.34315 21 6L21 16C21 17.6569 19.6569 19 18 19H15.4646ZM12 20C12.8284 20 13.5 19.3284 13.5 18.5V18C13.5 17.4477 13.9477 17 14.5 17H18C18.5523 17 19 16.5523 19 16L19 6C19 5.44772 18.5523 5 18 5L6 5C5.44772 5 5 5.44772 5 6V7.53544C6.69615 7.77806 8 9.23676 8 11C8 12.7632 6.69615 14.2219 5 14.4646L5 16C5 16.5523 5.44771 17 6 17H9.5C10.0523 17 10.5 17.4477 10.5 18V18.5C10.5 19.3284 11.1716 20 12 20Z"
        fill="currentColor"
      ></path>
    </svg>
  );
}

import React from 'react';
import { JSX } from 'react/jsx-runtime';

export default function LogOutIcon(): JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="icon-md"
      aria-hidden="true"
    >
      <path
        d="M11 3H7C5.89543 3 5 3.89543 5 5V19C5 20.1046 5.89543 21 7 21H11"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      ></path>
      <path
        d="M20 12H11M20 12L16 16M20 12L16 8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      ></path>
    </svg>
  );
}

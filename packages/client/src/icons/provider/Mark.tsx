import type { ComponentType, SVGProps } from 'react';
import type { BrandMark } from './marks';

type MarkProps = SVGProps<SVGSVGElement> & { size?: number };

/** Builds an SVG component for a brand mark; the registry treats it like any component art. */
export function createMark(mark: BrandMark): ComponentType<MarkProps> {
  function Mark({ size, className }: MarkProps) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={mark.viewBox}
        width={size}
        height={size}
        fill="currentColor"
        aria-hidden="true"
        focusable="false"
        className={className}
      >
        {mark.paths.map(({ d, evenOdd }) => (
          <path
            key={d}
            d={d}
            fillRule={evenOdd ? 'evenodd' : undefined}
            clipRule={evenOdd ? 'evenodd' : undefined}
          />
        ))}
      </svg>
    );
  }
  return Mark;
}

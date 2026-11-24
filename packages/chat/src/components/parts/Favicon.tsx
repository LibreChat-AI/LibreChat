import { cn } from '@librechat/client';
import type { ValidSource } from 'librechat-data-provider';
import { getCleanDomain } from './sources';

const faviconUrl = (domain: string): string =>
  `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;

/** The icon of a site a search read or a citation points at. */
export default function Favicon({
  domain,
  className = '',
}: {
  domain: string;
  className?: string;
}): React.JSX.Element {
  return (
    <img
      src={faviconUrl(domain)}
      alt={domain}
      className={cn('size-4 shrink-0 rounded-full', className)}
      loading="lazy"
    />
  );
}

/**
 * The icons of a few sources, overlapping, for a row that names how many sites were read. `start`
 * and `end` pick the sources to show; a negative `start` takes the last ones.
 */
export function StackedFavicons({
  sources,
  start = 0,
  end = 3,
}: {
  sources: ValidSource[];
  start?: number;
  end?: number;
}): React.JSX.Element {
  const shown = start < 0 ? sources.slice(start) : sources.slice(start, end);
  return (
    <div className="relative flex">
      {shown.map((source, i) => (
        <Favicon
          key={`icon-${i}`}
          domain={getCleanDomain(source.link)}
          className={i > 0 ? 'ms-[-0.375rem]' : ''}
        />
      ))}
    </div>
  );
}

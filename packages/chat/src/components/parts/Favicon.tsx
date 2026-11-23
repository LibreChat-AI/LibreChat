import { cn } from '@librechat/client';

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

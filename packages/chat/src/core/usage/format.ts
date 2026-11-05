import { normalizeTokenCount } from './types';

let tokenFormatter: Intl.NumberFormat | undefined;

/** A token count in compact notation for the active locale (1.2K, 32K), without a trailing `.0`. */
export function formatTokens(count: number): string {
  tokenFormatter ??= new Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: 1,
  });
  const formatted = tokenFormatter.format(normalizeTokenCount(count));
  return formatted.replace(/\.0(?=[A-Za-z]|$)/, '');
}

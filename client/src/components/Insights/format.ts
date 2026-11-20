export function formatValue(value: number, locale: string) {
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatExactValue(value: number, locale: string) {
  return new Intl.NumberFormat(locale).format(value);
}

export function formatMetric(value: number, locale: string, format?: 'currency', compact = false) {
  if (format !== 'currency') {
    return compact ? formatValue(value, locale) : formatExactValue(value, locale);
  }
  const subCent = value !== 0 && Math.abs(value) < 0.01;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    ...(subCent ? { maximumSignificantDigits: 6 } : { maximumFractionDigits: 4 }),
  }).format(value);
}

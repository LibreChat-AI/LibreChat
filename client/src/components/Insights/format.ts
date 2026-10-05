export function formatExactValue(value: number, locale: string) {
  return new Intl.NumberFormat(locale).format(value);
}

export function formatMoney(value: number, locale: string) {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 4,
  }).format(value);
}

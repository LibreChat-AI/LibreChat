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

/** Display currency for the context cost. `rate` is a static USD to local
 *  multiplier (no live FX); `code` is an ISO-4217 currency for Intl formatting. */
export interface CurrencyConfig {
  code: string;
  rate: number;
}

const DEFAULT_CURRENCY: CurrencyConfig = { code: 'USD', rate: 1 };
const currencyFormatters = new Map<string, Intl.NumberFormat>();
const currencyDigits = new Map<string, number>();
let supportedCurrencies: Set<string> | null | undefined;

/** `Intl.supportedValuesOf` is absent from older runtimes and from this package's lib target. */
function listCurrencies(): string[] | null {
  const supportedValuesOf: unknown = Reflect.get(Intl, 'supportedValuesOf');
  if (typeof supportedValuesOf !== 'function') {
    return null;
  }
  const values: unknown = supportedValuesOf.call(Intl, 'currency');
  return Array.isArray(values) ? values.filter((v) => typeof v === 'string') : null;
}

/** True only for codes recognized as ISO-4217. `Intl.NumberFormat` accepts any
 *  well-formed three-letter code (e.g. `EUU`, `RMB`) without throwing, so the
 *  ISO-4217 set is the real guard against typo'd / non-ISO codes. */
function isSupportedCurrency(code: unknown): code is string {
  if (typeof code !== 'string' || code.length === 0) {
    return false;
  }
  const upper = code.toUpperCase();
  if (supportedCurrencies === undefined) {
    const codes = listCurrencies();
    supportedCurrencies = codes != null ? new Set(codes) : null;
  }
  if (supportedCurrencies != null) {
    return supportedCurrencies.has(upper);
  }
  /** Older runtime without `supportedValuesOf`: accept any code Intl can build. */
  try {
    new Intl.NumberFormat(undefined, { style: 'currency', currency: upper });
    return true;
  } catch {
    return false;
  }
}

/** Default fraction digits for a validated currency: USD: 2, JPY: 0, KWD: 3. */
function maxFractionDigits(code: string): number {
  const cached = currencyDigits.get(code);
  if (cached !== undefined) {
    return cached;
  }
  const digits =
    new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  currencyDigits.set(code, digits);
  return digits;
}

function currencyFormatter(code: string, minDigits: number, maxDigits: number): Intl.NumberFormat {
  const key = `${code}:${minDigits}:${maxDigits}`;
  let formatter = currencyFormatters.get(key);
  if (formatter == null) {
    formatter = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: minDigits,
      maximumFractionDigits: maxDigits,
    });
    currencyFormatters.set(key, formatter);
  }
  return formatter;
}

export function formatCost(usd: number, currency: CurrencyConfig = DEFAULT_CURRENCY): string {
  /** Resolve to a safe (code, rate): an unsupported code falls back to USD AND
   *  rate 1 (never present a converted amount under the wrong symbol). A
   *  non-finite/negative rate (e.g. a partial admin override that set `code`
   *  before `rate`) falls back to 1 so a cost never renders as `NaN`. */
  let code = DEFAULT_CURRENCY.code;
  let rate = 1;
  if (isSupportedCurrency(currency?.code)) {
    code = currency.code.toUpperCase();
    const candidate: number = currency.rate;
    rate = Number.isFinite(candidate) && candidate > 0 ? candidate : 1;
  }
  const base = maxFractionDigits(code);

  const amount = (Number.isFinite(usd) && usd > 0 ? usd : 0) * rate;
  /** The currency's own minor unit: USD/EUR: 0.01, JPY: 1, KWD: 0.001. */
  const smallest = Math.pow(10, -base);

  if (amount <= 0) {
    return currencyFormatter(code, base, base).format(0);
  }
  if (amount < smallest) {
    return `<${currencyFormatter(code, base, base).format(smallest)}`;
  }
  if (amount < 1 && base > 0) {
    /** Extra precision for sub-unit costs; trailing zeros trim to the currency's
     *  own scale (min = base). */
    return currencyFormatter(code, base, base + 2).format(amount);
  }
  return currencyFormatter(code, base, base).format(amount);
}

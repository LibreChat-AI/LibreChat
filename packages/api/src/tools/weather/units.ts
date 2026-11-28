const TEMPERATURE_KEYS = new Set([
  'temp',
  'feels_like',
  'dew_point',
  'day',
  'min',
  'max',
  'night',
  'eve',
  'morn',
  'afternoon',
  'morning',
  'evening',
]);

/**
 * Map user-friendly units to OpenWeather units.
 * Defaults to Celsius if not specified.
 */
export function mapUnitsToOpenWeather(unit?: string): string {
  if (!unit) {
    return 'metric';
  }
  switch (unit) {
    case 'Celsius':
      return 'metric';
    case 'Kelvin':
      return 'standard';
    case 'Fahrenheit':
      return 'imperial';
    default:
      return 'metric';
  }
}

export function unitSuffix(units: string): string {
  if (units === 'imperial') {
    return '°F';
  }
  if (units === 'standard') {
    return ' K';
  }
  return '°C';
}

export function roundDegree(value: number): number {
  return Math.round(value);
}

/**
 * Recursively round temperature fields in the API response.
 */
export function roundTemperatures<T>(obj: T): T {
  if (Array.isArray(obj)) {
    return obj.map((item) => roundTemperatures(item)) as T;
  }
  if (obj && typeof obj === 'object') {
    const record = obj as { [key: string]: unknown };
    for (const key of Object.keys(record)) {
      const value = record[key];
      if (value && typeof value === 'object') {
        record[key] = roundTemperatures(value);
      } else if (typeof value === 'number' && TEMPERATURE_KEYS.has(key)) {
        record[key] = Math.round(value);
      }
    }
  }
  return obj;
}

import type {
  CurrentForecastResult,
  DailyAggregationResult,
  OneCallRecord,
  OneCallResponse,
  OpenWeatherArgs,
  OpenWeatherDeps,
  OpenWeatherOneCallVersion,
  OverviewResult,
  WeatherAlert,
} from './types';
import {
  collectAlertIds,
  dateStringInTimeZone,
  normalizeCurrentForecast,
  normalizeDailyAggregation,
  omitRecordAlerts,
  selectDailyRecord,
  synthesizeOverview,
  unixAtLocalMidnight,
} from './normalize';
import { mapUnitsToOpenWeather, roundTemperatures } from './units';

export const OPENWEATHER_API_ORIGIN: string = 'https://api.openweathermap.org';
export const DEFAULT_OPENWEATHER_ONECALL_VERSION: OpenWeatherOneCallVersion = '4.0';

const GEOCODE_PATH = '/geo/1.0/direct';
const CURRENT_PATH = '/data/4.0/onecall/current';
const MINUTELY_PATH = '/data/4.0/onecall/timeline/1min';
const HOURLY_PATH = '/data/4.0/onecall/timeline/1h';
const DAILY_PATH = '/data/4.0/onecall/timeline/1day';
const ALERT_PATH_PREFIX = '/data/4.0/onecall/alert/';
const ONE_CALL_3_PATH = '/data/3.0/onecall';
const HOURLY_PAGE_LIMIT = 1;
const HOURLY_RECORD_LIMIT = 20;
const HOURLY_PAGE_SIZE = 20;
const DAILY_PAGE_SIZE = 10;
const MINUTELY_COUNT = 60;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ALERT_PATH_HAZARD = /[/\\]|\.\.|%(?:2e|2f|5c)/i;
const EXCLUDE_PARTS = new Set(['current', 'minutely', 'hourly', 'daily', 'alerts']);
const COORDINATE_ACTIONS = new Set([
  'current_forecast',
  'timestamp',
  'daily_aggregation',
  'overview',
]);

class OpenWeatherApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'OpenWeatherApiError';
    this.status = status;
  }
}

export function resolveOpenWeatherOneCallVersion(value?: string | null): OpenWeatherOneCallVersion {
  return value?.trim() === '3.0' ? '3.0' : DEFAULT_OPENWEATHER_ONECALL_VERSION;
}

function resolvedOneCallVersion(deps: OpenWeatherDeps): OpenWeatherOneCallVersion {
  return deps.oneCallVersion === '3.0' ? '3.0' : DEFAULT_OPENWEATHER_ONECALL_VERSION;
}

export function getOpenWeatherHelp(version: OpenWeatherOneCallVersion = '4.0'): string {
  if (version === '3.0') {
    return JSON.stringify(
      {
        title: 'OpenWeather One Call API 3.0 Help',
        description: 'Guidance on using the OpenWeather One Call API 3.0.',
        endpoints: {
          current_and_forecast: {
            endpoint: 'data/3.0/onecall',
            data_provided: [
              'Current weather',
              'Minute forecast (1h)',
              'Hourly forecast (48h)',
              'Daily forecast (8 days)',
              'Government weather alerts',
            ],
            required_params: [['lat', 'lon'], ['city']],
            optional_params: ['exclude', 'units (Celsius/Kelvin/Fahrenheit)', 'lang'],
            usage_example: {
              city: 'Knoxville, Tennessee',
              units: 'Fahrenheit',
              lang: 'en',
            },
          },
          weather_for_timestamp: {
            endpoint: 'data/3.0/onecall/timemachine',
            data_provided: [
              'Historical weather (since 1979-01-01)',
              'Future forecast up to 4 days ahead',
            ],
            required_params: [
              ['lat', 'lon', 'date (YYYY-MM-DD)'],
              ['city', 'date (YYYY-MM-DD)'],
            ],
            optional_params: ['units (Celsius/Kelvin/Fahrenheit)', 'lang', 'tz'],
            usage_example: {
              city: 'Knoxville, Tennessee',
              date: '2020-03-04',
              units: 'Fahrenheit',
              lang: 'en',
            },
          },
          daily_aggregation: {
            endpoint: 'data/3.0/onecall/day_summary',
            data_provided: [
              'Aggregated weather data for a specific date (1979-01-02 to 1.5 years ahead)',
            ],
            required_params: [
              ['lat', 'lon', 'date (YYYY-MM-DD)'],
              ['city', 'date (YYYY-MM-DD)'],
            ],
            optional_params: ['units (Celsius/Kelvin/Fahrenheit)', 'lang', 'tz'],
            usage_example: {
              city: 'Knoxville, Tennessee',
              date: '2020-03-04',
              units: 'Celsius',
              lang: 'en',
            },
          },
          weather_overview: {
            endpoint: 'data/3.0/onecall/overview',
            data_provided: ['Human-readable weather summary (today/tomorrow)'],
            required_params: [['lat', 'lon'], ['city']],
            optional_params: ['date (YYYY-MM-DD)', 'units (Celsius/Kelvin/Fahrenheit)'],
            usage_example: {
              city: 'Knoxville, Tennessee',
              date: '2024-05-13',
              units: 'Celsius',
            },
          },
        },
        notes: [
          'This deployment is using One Call 3.0 via OPENWEATHER_ONECALL_VERSION=3.0.',
          'New OpenWeather keys should use the 4.0 default (unset or OPENWEATHER_ONECALL_VERSION=4.0).',
          'If lat/lon not provided, you can specify a city name and it will be geocoded.',
          'For the timestamp action, provide a date in YYYY-MM-DD format instead of a Unix timestamp.',
          'By default, temperatures are returned in Celsius.',
          'You can specify units as Celsius, Kelvin, or Fahrenheit.',
          'All temperatures are rounded to the nearest degree.',
        ],
        errors: [
          '400: Bad Request (missing/invalid params)',
          '401: Unauthorized (check API key)',
          '404: Not Found (no data or city)',
          '429: Too many requests',
          '5xx: Internal error',
        ],
      },
      null,
      2,
    );
  }

  return JSON.stringify(
    {
      title: 'OpenWeather One Call API 4.0 Help',
      description: 'Guidance on using the OpenWeather One Call API 4.0.',
      endpoints: {
        current_and_forecast: {
          endpoint: 'data/4.0/onecall/current + timeline/1h + timeline/1day',
          data_provided: [
            'Current weather',
            'Hourly forecast (up to 20h, one page)',
            'Daily forecast (up to 10 days)',
            'Resolved weather alerts when IDs are present',
          ],
          required_params: [['lat', 'lon'], ['city']],
          optional_params: ['exclude', 'units (Celsius/Kelvin/Fahrenheit)', 'lang'],
          usage_example: {
            city: 'Knoxville, Tennessee',
            units: 'Fahrenheit',
            lang: 'en',
          },
        },
        weather_for_timestamp: {
          endpoint: 'data/4.0/onecall/timeline/1h',
          data_provided: [
            'Hourly weather around a date (up to 20h per page; history since 1979, forecast up to 48h ahead)',
          ],
          required_params: [
            ['lat', 'lon', 'date (YYYY-MM-DD)'],
            ['city', 'date (YYYY-MM-DD)'],
          ],
          optional_params: ['units (Celsius/Kelvin/Fahrenheit)', 'lang', 'tz'],
          usage_example: {
            city: 'Knoxville, Tennessee',
            date: '2020-03-04',
            units: 'Fahrenheit',
            lang: 'en',
          },
        },
        daily_aggregation: {
          endpoint: 'data/4.0/onecall/timeline/1day',
          data_provided: [
            'Daily weather for a specific date (history since 1979, forecast up to 1.5 years ahead)',
          ],
          required_params: [
            ['lat', 'lon', 'date (YYYY-MM-DD)'],
            ['city', 'date (YYYY-MM-DD)'],
          ],
          optional_params: ['units (Celsius/Kelvin/Fahrenheit)', 'lang', 'tz'],
          usage_example: {
            city: 'Knoxville, Tennessee',
            date: '2020-03-04',
            units: 'Celsius',
            lang: 'en',
          },
        },
        weather_overview: {
          endpoint: 'synthesized from data/4.0/onecall/current or timeline/1day',
          data_provided: [
            'Human-readable weather summary. One Call 4.0 has no overview endpoint, so this is composed from current or daily data.',
          ],
          required_params: [['lat', 'lon'], ['city']],
          optional_params: ['date (YYYY-MM-DD)', 'units (Celsius/Kelvin/Fahrenheit)', 'tz'],
          usage_example: {
            city: 'Knoxville, Tennessee',
            date: '2024-05-13',
            units: 'Celsius',
          },
        },
      },
      notes: [
        'If lat/lon not provided, you can specify a city name and it will be geocoded.',
        'For the timestamp action, provide a date in YYYY-MM-DD format instead of a Unix timestamp.',
        'By default, temperatures are returned in Celsius.',
        'You can specify units as Celsius, Kelvin, or Fahrenheit.',
        'All temperatures are rounded to the nearest degree.',
        'One Call 4.0 bills per HTTP call. current_forecast uses current + hourly (one page, up to 20h) + daily. The 1-hour timeline returns at most 20 records per response. Minute precipitation is omitted by default; include +minutely in exclude to fetch it (extra billed call).',
        'Existing One Call 3.0 subscriptions still work. Set OPENWEATHER_ONECALL_VERSION=3.0 to keep using /data/3.0. Default is 4.0 for new keys.',
        'current_forecast maps 4.0 split endpoints onto the previous current/hourly/daily contract. Failed endpoints are noted in errors instead of failing the whole action.',
        'daily_aggregation maps 4.0 daily temp.morn/day/eve/night onto morning/afternoon/evening/night. Period humidity/cloud/pressure/wind and precipitation.total are omitted when 4.0 does not provide a documented daily accumulation. rain.1h / snow.1h are mm/h rates, not a daily total.',
        'Date-based actions honour tz (IANA name or ±HH:MM) as the local day boundary.',
        'Weather alert IDs are resolved through /onecall/alert/{id} only when alerts are present. exclude=alerts skips that.',
      ],
      errors: [
        '400: Bad Request (missing/invalid params)',
        '401: Unauthorized (check API key)',
        '404: Not Found (no data or city)',
        '429: Too many requests',
        '5xx: Internal error',
      ],
    },
    null,
    2,
  );
}

export function convertDateToUnix(dateStr: string, timeZone?: string): number {
  if (!DATE_PATTERN.test(dateStr)) {
    throw new Error('Invalid date format. Expected YYYY-MM-DD.');
  }
  const parts = dateStr.split('-');
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  if (isNaN(year) || isNaN(month) || isNaN(day)) {
    throw new Error('Invalid date format. Expected YYYY-MM-DD with valid numbers.');
  }

  const utcMidnight = Date.UTC(year, month - 1, day, 0, 0, 0);
  if (isNaN(utcMidnight)) {
    throw new Error('Invalid date provided. Cannot parse into a valid date.');
  }

  return unixAtLocalMidnight(year, month, day, timeZone);
}

export function isOpenWeatherPaginationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'api.openweathermap.org' &&
      parsed.pathname.startsWith('/data/4.0/onecall/')
    );
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is { [key: string]: unknown } {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asIdArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((item) => {
    if (typeof item === 'string' && item.length > 0) {
      return [item];
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      return [String(item)];
    }
    return [];
  });
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((item): item is string => typeof item === 'string');
  return items;
}

function parseWeatherCondition(value: unknown): OneCallRecord['weather'] {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const conditions = value.flatMap((item) => {
    if (!isObject(item)) {
      return [];
    }
    return [
      {
        id: asNumber(item.id),
        main: asString(item.main),
        description: asString(item.description),
        icon: asString(item.icon),
      },
    ];
  });
  return conditions;
}

function parsePrecipitation(value: unknown): OneCallRecord['rain'] {
  if (typeof value === 'number') {
    return value;
  }
  if (!isObject(value)) {
    return undefined;
  }
  return { '1h': asNumber(value['1h']) };
}

function parseTemperature(value: unknown): OneCallRecord['temp'] {
  if (typeof value === 'number') {
    return value;
  }
  if (!isObject(value)) {
    return undefined;
  }
  return {
    day: asNumber(value.day),
    min: asNumber(value.min),
    max: asNumber(value.max),
    night: asNumber(value.night),
    eve: asNumber(value.eve),
    morn: asNumber(value.morn),
  };
}

function parseOneCallRecord(value: unknown): OneCallRecord | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  return {
    dt: asNumber(value.dt),
    sunrise: asNumber(value.sunrise),
    sunset: asNumber(value.sunset),
    moonrise: asNumber(value.moonrise),
    moonset: asNumber(value.moonset),
    moon_phase: asNumber(value.moon_phase),
    temp: parseTemperature(value.temp),
    feels_like: parseTemperature(value.feels_like),
    pressure: asNumber(value.pressure),
    humidity: asNumber(value.humidity),
    dew_point: asNumber(value.dew_point),
    uvi: asNumber(value.uvi),
    clouds: asNumber(value.clouds),
    visibility: asNumber(value.visibility),
    wind_speed: asNumber(value.wind_speed),
    wind_deg: asNumber(value.wind_deg),
    wind_gust: asNumber(value.wind_gust),
    pop: asNumber(value.pop),
    precipitation: asNumber(value.precipitation),
    rain: parsePrecipitation(value.rain),
    snow: parsePrecipitation(value.snow),
    weather: parseWeatherCondition(value.weather),
    alerts: asIdArray(value.alerts),
  };
}

function parseOneCallResponse(body: unknown): OneCallResponse {
  if (!isObject(body)) {
    return {};
  }
  const data = Array.isArray(body.data)
    ? body.data.flatMap((item) => {
        const record = parseOneCallRecord(item);
        return record ? [record] : [];
      })
    : undefined;
  return {
    lat: asNumber(body.lat),
    lon: asNumber(body.lon),
    timezone: asString(body.timezone),
    timezone_offset: asNumber(body.timezone_offset),
    data,
    next: asString(body.next),
    prev: asString(body.prev),
  };
}

function isEnglishAlertLanguage(language?: string): boolean {
  return language != null && /^en(?:-|$)/i.test(language);
}

function parseAlertDescription(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.length > 0 ? value : undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const entries = value.flatMap((item) => {
    if (!isObject(item)) {
      return [];
    }
    const description = asString(item.description);
    if (description == null || description.length === 0) {
      return [];
    }
    return [{ language: asString(item.language), description }];
  });
  if (entries.length === 0) {
    return undefined;
  }
  if (entries.length === 1) {
    return entries[0].description;
  }

  const preferred = entries.find((entry) => isEnglishAlertLanguage(entry.language)) ?? entries[0];
  const rest = entries.filter((entry) => entry !== preferred);
  return [preferred, ...rest]
    .map((entry) =>
      entry.language != null ? `[${entry.language}] ${entry.description}` : entry.description,
    )
    .join('\n');
}

function parseWeatherAlert(body: unknown, id: string): WeatherAlert | undefined {
  const source = isObject(body) && isObject(body.data) ? body.data : body;
  if (!isObject(source)) {
    return undefined;
  }
  return {
    id,
    sender_name: asString(source.sender_name),
    event: asString(source.event),
    start: asNumber(source.start),
    end: asNumber(source.end),
    description: parseAlertDescription(source.description),
    tags: asStringArray(source.tags),
  };
}

function isSafeAlertId(id: string): boolean {
  if (id.length === 0 || id.includes('\0')) {
    return false;
  }
  return !ALERT_PATH_HAZARD.test(id);
}

function readErrorMessage(body: unknown): string {
  if (isObject(body) && typeof body.message === 'string') {
    return body.message;
  }
  try {
    return JSON.stringify(body);
  } catch {
    return 'Unknown error';
  }
}

function parseExclude(exclude?: string): Set<string> {
  if (!exclude) {
    return new Set();
  }
  return new Set(
    exclude
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter((part) => EXCLUDE_PARTS.has(part)),
  );
}

function requestsMinutely(exclude?: string): boolean {
  if (!exclude) {
    return false;
  }
  return exclude.split(',').some((part) => part.trim().toLowerCase() === '+minutely');
}

function buildUrl(path: string, params: URLSearchParams): string {
  return `${OPENWEATHER_API_ORIGIN}${path}?${params.toString()}`;
}

function locationParams(args: {
  apiKey: string;
  lat: number;
  lon: number;
  units: string;
  lang?: string;
}): URLSearchParams {
  const params = new URLSearchParams({
    appid: args.apiKey,
    units: args.units,
    lat: String(args.lat),
    lon: String(args.lon),
  });
  if (args.lang) {
    params.append('lang', args.lang);
  }
  return params;
}

async function fetchOpenWeatherBody(
  url: string,
  fetchImpl: OpenWeatherDeps['fetch'],
): Promise<unknown> {
  const response = await fetchImpl(url);
  const body: unknown = await response.json();
  if (!response.ok) {
    throw new OpenWeatherApiError(
      response.status,
      `OpenWeather API request failed with status ${response.status}: ${readErrorMessage(body)}`,
    );
  }
  return body;
}

async function fetchOpenWeatherJson(
  url: string,
  fetchImpl: OpenWeatherDeps['fetch'],
): Promise<OneCallResponse> {
  return parseOneCallResponse(await fetchOpenWeatherBody(url, fetchImpl));
}

async function fetchTimeline(
  path: string,
  params: URLSearchParams,
  fetchImpl: OpenWeatherDeps['fetch'],
  options?: { pages?: number; maxRecords?: number },
): Promise<OneCallResponse> {
  const first = await fetchOpenWeatherJson(buildUrl(path, params), fetchImpl);
  const pageLimit = options?.pages ?? 1;
  const maxRecords = options?.maxRecords;
  const data = [...(first.data ?? [])];
  let next = first.next;
  let pageCount = 1;

  while (
    next &&
    pageCount < pageLimit &&
    (maxRecords == null || data.length < maxRecords) &&
    isOpenWeatherPaginationUrl(next)
  ) {
    const extra = await fetchOpenWeatherJson(next, fetchImpl);
    if (extra.data) {
      data.push(...extra.data);
    }
    next = extra.next;
    pageCount += 1;
  }

  if (maxRecords != null && data.length > maxRecords) {
    data.length = maxRecords;
  }

  return {
    lat: first.lat,
    lon: first.lon,
    timezone: first.timezone,
    timezone_offset: first.timezone_offset,
    data,
  };
}

async function geocodeCity(
  city: string,
  deps: OpenWeatherDeps,
): Promise<{ lat: number; lon: number }> {
  const params = new URLSearchParams({
    q: city,
    limit: '1',
    appid: deps.apiKey,
  });
  const url = buildUrl(GEOCODE_PATH, params);
  const response = await deps.fetch(url);
  const body: unknown = await response.json();
  if (!response.ok || !Array.isArray(body) || body.length === 0) {
    throw new Error(`Could not find coordinates for city: ${city}`);
  }
  const first = body[0];
  if (!isObject(first) || typeof first.lat !== 'number' || typeof first.lon !== 'number') {
    throw new Error(`Could not find coordinates for city: ${city}`);
  }
  return { lat: first.lat, lon: first.lon };
}

function stringifyResult(
  value: CurrentForecastResult | DailyAggregationResult | OverviewResult | OneCallResponse,
): string {
  return JSON.stringify(roundTemperatures(value));
}

function stripAlertsFromForecast(result: CurrentForecastResult): CurrentForecastResult {
  return {
    ...result,
    current: result.current != null ? omitRecordAlerts(result.current) : result.current,
    minutely: result.minutely?.map(omitRecordAlerts),
    hourly: result.hourly?.map(omitRecordAlerts),
    daily: result.daily?.map(omitRecordAlerts),
  };
}

async function resolveAlerts(
  records: Array<OneCallRecord | undefined>,
  deps: OpenWeatherDeps,
): Promise<{ alerts: WeatherAlert[]; errors: string[] }> {
  const ids = collectAlertIds(records);
  if (ids.length === 0) {
    return { alerts: [], errors: [] };
  }

  const settled = await Promise.allSettled(
    ids.map(async (id) => {
      if (!isSafeAlertId(id)) {
        throw new Error(`Skipping unsafe alert id`);
      }
      const params = new URLSearchParams({ appid: deps.apiKey });
      const body = await fetchOpenWeatherBody(
        buildUrl(`${ALERT_PATH_PREFIX}${encodeURIComponent(id)}`, params),
        deps.fetch,
      );
      const alert = parseWeatherAlert(body, id);
      if (alert == null) {
        throw new Error(`Could not parse alert ${id}`);
      }
      return alert;
    }),
  );

  const alerts: WeatherAlert[] = [];
  const errors: string[] = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    const id = ids[i];
    if (result.status === 'fulfilled') {
      alerts.push(result.value);
    } else {
      const message = result.reason instanceof Error ? result.reason.message : 'Unknown error';
      errors.push(`alert ${id}: ${message}`);
    }
  }
  return { alerts, errors };
}

type ForecastPartName = 'current' | 'hourly' | 'daily' | 'minutely';

async function currentForecast(
  args: OpenWeatherArgs,
  coords: { lat: number; lon: number },
  units: string,
  deps: OpenWeatherDeps,
): Promise<string> {
  const excluded = parseExclude(args.exclude);
  const includeCurrent = !excluded.has('current');
  const includeHourly = !excluded.has('hourly');
  const includeDaily = !excluded.has('daily');
  const includeMinutely = !excluded.has('minutely') && requestsMinutely(args.exclude);
  const includeAlerts = !excluded.has('alerts');
  const params = () =>
    locationParams({
      apiKey: deps.apiKey,
      lat: coords.lat,
      lon: coords.lon,
      units,
      lang: args.lang,
    });

  const requests: Array<{ name: ForecastPartName; promise: Promise<OneCallResponse> }> = [];
  if (includeCurrent) {
    requests.push({
      name: 'current',
      promise: fetchOpenWeatherJson(buildUrl(CURRENT_PATH, params()), deps.fetch),
    });
  }
  if (includeHourly) {
    const hourlyParams = params();
    hourlyParams.set('cnt', String(HOURLY_PAGE_SIZE));
    requests.push({
      name: 'hourly',
      promise: fetchTimeline(HOURLY_PATH, hourlyParams, deps.fetch, {
        pages: HOURLY_PAGE_LIMIT,
        maxRecords: HOURLY_RECORD_LIMIT,
      }),
    });
  }
  if (includeDaily) {
    const dailyParams = params();
    dailyParams.set('cnt', String(DAILY_PAGE_SIZE));
    requests.push({
      name: 'daily',
      promise: fetchTimeline(DAILY_PATH, dailyParams, deps.fetch),
    });
  }
  if (includeMinutely) {
    const minutelyParams = params();
    minutelyParams.set('cnt', String(MINUTELY_COUNT));
    requests.push({
      name: 'minutely',
      promise: fetchOpenWeatherJson(buildUrl(MINUTELY_PATH, minutelyParams), deps.fetch),
    });
  }

  const settled = await Promise.allSettled(requests.map((request) => request.promise));
  const parts: {
    current?: OneCallResponse;
    hourly?: OneCallResponse;
    daily?: OneCallResponse;
    minutely?: OneCallResponse;
  } = {};
  const partErrors: Array<{ name: ForecastPartName; message: string }> = [];

  for (let i = 0; i < settled.length; i++) {
    const name = requests[i].name;
    const result = settled[i];
    if (result.status === 'fulfilled') {
      parts[name] = result.value;
    } else {
      const message = result.reason instanceof Error ? result.reason.message : 'Unknown error';
      partErrors.push({ name, message });
    }
  }

  if (
    parts.current == null &&
    parts.hourly == null &&
    parts.daily == null &&
    parts.minutely == null
  ) {
    return `Error: ${partErrors[0]?.message ?? 'OpenWeather API request failed'}`;
  }

  const result = normalizeCurrentForecast(parts);
  const errors = partErrors.map(({ name, message }) => `${name}: ${message}`);

  if (includeAlerts) {
    const resolved = await resolveAlerts(
      [
        result.current,
        ...(result.hourly ?? []),
        ...(result.daily ?? []),
        ...(result.minutely ?? []),
      ],
      deps,
    );
    if (resolved.alerts.length > 0) {
      result.alerts = resolved.alerts;
    }
    errors.push(...resolved.errors);
  } else {
    const stripped = stripAlertsFromForecast(result);
    result.current = stripped.current;
    result.minutely = stripped.minutely;
    result.hourly = stripped.hourly;
    result.daily = stripped.daily;
  }

  if (errors.length > 0) {
    result.errors = errors;
  }

  return stringifyResult(result);
}

async function timestampForecast(
  args: OpenWeatherArgs,
  coords: { lat: number; lon: number },
  units: string,
  deps: OpenWeatherDeps,
): Promise<string> {
  if (!args.date) {
    return "Error: For timestamp action, a 'date' in YYYY-MM-DD format is required.";
  }
  const start = convertDateToUnix(args.date, args.tz);
  const params = locationParams({
    apiKey: deps.apiKey,
    lat: coords.lat,
    lon: coords.lon,
    units,
    lang: args.lang,
  });
  params.set('start', String(start));
  params.set('cnt', String(HOURLY_PAGE_SIZE));
  const response = await fetchTimeline(HOURLY_PATH, params, deps.fetch);
  return stringifyResult(response);
}

async function dailyAggregation(
  args: OpenWeatherArgs,
  coords: { lat: number; lon: number },
  units: string,
  deps: OpenWeatherDeps,
): Promise<string> {
  if (!args.date) {
    return 'Error: date (YYYY-MM-DD) is required for daily_aggregation action.';
  }
  const start = convertDateToUnix(args.date, args.tz);
  const params = locationParams({
    apiKey: deps.apiKey,
    lat: coords.lat,
    lon: coords.lon,
    units,
    lang: args.lang,
  });
  params.set('start', String(start));
  params.set('cnt', String(DAILY_PAGE_SIZE));
  const response = await fetchTimeline(DAILY_PATH, params, deps.fetch);
  return stringifyResult(normalizeDailyAggregation(response, args.date, units, args.tz));
}

async function overviewForecast(
  args: OpenWeatherArgs,
  coords: { lat: number; lon: number },
  units: string,
  deps: OpenWeatherDeps,
): Promise<string> {
  const params = locationParams({
    apiKey: deps.apiKey,
    lat: coords.lat,
    lon: coords.lon,
    units,
    lang: args.lang,
  });

  if (args.date) {
    const start = convertDateToUnix(args.date, args.tz);
    params.set('start', String(start));
    params.set('cnt', String(DAILY_PAGE_SIZE));
    const daily = await fetchTimeline(DAILY_PATH, params, deps.fetch);
    const zone = args.tz ?? daily.timezone;
    const record = selectDailyRecord(daily.data ?? [], args.date, zone);
    return stringifyResult(
      synthesizeOverview({
        daily: record,
        date: args.date,
        units,
        lat: daily.lat ?? coords.lat,
        lon: daily.lon ?? coords.lon,
        timezone: zone,
      }),
    );
  }

  const current = await fetchOpenWeatherJson(buildUrl(CURRENT_PATH, params), deps.fetch);
  const record: OneCallRecord | undefined = current.data?.[0];
  const zone = args.tz ?? current.timezone;
  const date =
    record?.dt != null
      ? dateStringInTimeZone(record.dt, zone)
      : dateStringInTimeZone(Math.floor(Date.now() / 1000), zone);
  return stringifyResult(
    synthesizeOverview({
      current: record,
      date,
      units,
      lat: current.lat ?? coords.lat,
      lon: current.lon ?? coords.lon,
      timezone: zone,
    }),
  );
}

async function executeOneCall3(
  args: OpenWeatherArgs,
  coords: { lat: number; lon: number },
  units: string,
  deps: OpenWeatherDeps,
): Promise<string> {
  const params = new URLSearchParams({
    appid: deps.apiKey,
    units,
    lat: String(coords.lat),
    lon: String(coords.lon),
  });
  if (args.lang) {
    params.append('lang', args.lang);
  }

  let path: string;
  switch (args.action) {
    case 'current_forecast':
      path = ONE_CALL_3_PATH;
      if (args.exclude) {
        params.append('exclude', args.exclude);
      }
      break;
    case 'timestamp':
      if (!args.date) {
        return "Error: For timestamp action, a 'date' in YYYY-MM-DD format is required.";
      }
      path = `${ONE_CALL_3_PATH}/timemachine`;
      params.append('dt', String(convertDateToUnix(args.date, args.tz)));
      break;
    case 'daily_aggregation':
      if (!args.date) {
        return 'Error: date (YYYY-MM-DD) is required for daily_aggregation action.';
      }
      path = `${ONE_CALL_3_PATH}/day_summary`;
      params.append('date', args.date);
      if (args.tz) {
        params.append('tz', args.tz);
      }
      break;
    case 'overview':
      path = `${ONE_CALL_3_PATH}/overview`;
      if (args.date) {
        params.append('date', args.date);
      }
      break;
    default:
      return `Error: Unknown action: ${args.action}`;
  }

  const body = await fetchOpenWeatherBody(buildUrl(path, params), deps.fetch);
  return JSON.stringify(roundTemperatures(body));
}

export async function executeOpenWeather(
  args: OpenWeatherArgs,
  deps: OpenWeatherDeps,
): Promise<string> {
  try {
    const { action, city, lat, lon, units } = args;
    const owmUnits = mapUnitsToOpenWeather(units);
    const version = resolvedOneCallVersion(deps);

    if (action === 'help') {
      return getOpenWeatherHelp(version);
    }

    if (!COORDINATE_ACTIONS.has(action)) {
      return `Error: Unknown action: ${action}`;
    }

    let finalLat = lat;
    let finalLon = lon;
    if ((finalLat == null || finalLon == null) && city) {
      const coords = await geocodeCity(city, deps);
      finalLat = coords.lat;
      finalLon = coords.lon;
    }

    if (typeof finalLat !== 'number' || typeof finalLon !== 'number') {
      return "Error: lat and lon are required and must be numbers for this action (or specify 'city').";
    }

    const coords = { lat: finalLat, lon: finalLon };

    if (version === '3.0') {
      return await executeOneCall3(args, coords, owmUnits, deps);
    }

    switch (action) {
      case 'current_forecast':
        return await currentForecast(args, coords, owmUnits, deps);
      case 'timestamp':
        return await timestampForecast(args, coords, owmUnits, deps);
      case 'daily_aggregation':
        return await dailyAggregation(args, coords, owmUnits, deps);
      case 'overview':
        return await overviewForecast(args, coords, owmUnits, deps);
      default:
        return `Error: Unknown action: ${action}`;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return `Error: ${message}`;
  }
}

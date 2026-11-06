import type {
  CurrentForecastResult,
  DailyAggregationResult,
  DailyTemperature,
  OneCallRecord,
  OneCallResponse,
  OverviewResult,
} from './types';

import { roundDegree, unitSuffix } from './units';

const OFFSET_PATTERN = /^([+-])(\d{2}):(\d{2})$/;

export function isDailyTemperature(value: OneCallRecord['temp']): value is DailyTemperature {
  return value != null && typeof value === 'object';
}

export function utcDateString(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseUtcOffsetSeconds(timeZone: string): number | undefined {
  if (timeZone === 'UTC' || timeZone === 'utc' || timeZone === 'Z') {
    return 0;
  }
  const match = OFFSET_PATTERN.exec(timeZone);
  if (!match) {
    return undefined;
  }
  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 14 || minutes > 59) {
    return undefined;
  }
  return sign * (hours * 3600 + minutes * 60);
}

function localWallTimeAsUtcMs(instantMs: number, timeZone: string): number | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(instantMs));
    const read = (type: Intl.DateTimeFormatPartTypes): number => {
      const value = parts.find((part) => part.type === type)?.value;
      return value != null ? Number(value) : NaN;
    };
    let hour = read('hour');
    if (hour === 24) {
      hour = 0;
    }
    const utcMs = Date.UTC(
      read('year'),
      read('month') - 1,
      read('day'),
      hour,
      read('minute'),
      read('second'),
    );
    return Number.isFinite(utcMs) ? utcMs : undefined;
  } catch {
    return undefined;
  }
}

export function dateStringInTimeZone(unixSeconds: number, timeZone?: string): string {
  if (!timeZone) {
    return utcDateString(unixSeconds);
  }
  const offsetSeconds = parseUtcOffsetSeconds(timeZone);
  if (offsetSeconds != null) {
    return utcDateString(unixSeconds + offsetSeconds);
  }
  const partsMs = localWallTimeAsUtcMs(unixSeconds * 1000, timeZone);
  if (partsMs == null) {
    return utcDateString(unixSeconds);
  }
  return utcDateString(Math.floor(partsMs / 1000));
}

export function unixAtLocalMidnight(
  year: number,
  month: number,
  day: number,
  timeZone?: string,
): number {
  const utcMidnightMs = Date.UTC(year, month - 1, day, 0, 0, 0);
  if (!timeZone) {
    return Math.floor(utcMidnightMs / 1000);
  }

  const offsetSeconds = parseUtcOffsetSeconds(timeZone);
  if (offsetSeconds != null) {
    return Math.floor(utcMidnightMs / 1000) - offsetSeconds;
  }

  const asUtc = localWallTimeAsUtcMs(utcMidnightMs, timeZone);
  if (asUtc == null) {
    return Math.floor(utcMidnightMs / 1000);
  }
  let resultMs = utcMidnightMs - (asUtc - utcMidnightMs);
  const asUtcAgain = localWallTimeAsUtcMs(resultMs, timeZone);
  if (asUtcAgain != null) {
    resultMs = utcMidnightMs - (asUtcAgain - resultMs);
  }
  return Math.floor(resultMs / 1000);
}

export function stripPagination(response: OneCallResponse): OneCallResponse {
  return {
    lat: response.lat,
    lon: response.lon,
    timezone: response.timezone,
    timezone_offset: response.timezone_offset,
    data: response.data,
  };
}

export function collectAlertIds(records: Array<OneCallRecord | undefined>): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const record of records) {
    for (const id of record?.alerts ?? []) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

export function omitRecordAlerts(record: OneCallRecord): OneCallRecord {
  if (record.alerts == null) {
    return record;
  }
  const rest = { ...record };
  delete rest.alerts;
  return rest;
}

export function normalizeCurrentForecast(parts: {
  current?: OneCallResponse;
  hourly?: OneCallResponse;
  daily?: OneCallResponse;
  minutely?: OneCallResponse;
}): CurrentForecastResult {
  const meta = parts.current ?? parts.hourly ?? parts.daily ?? parts.minutely;
  const result: CurrentForecastResult = {
    lat: meta?.lat,
    lon: meta?.lon,
    timezone: meta?.timezone,
    timezone_offset: meta?.timezone_offset,
  };

  if (parts.current?.data?.[0] != null) {
    result.current = parts.current.data[0];
  }
  if (parts.minutely?.data != null) {
    result.minutely = parts.minutely.data;
  }
  if (parts.hourly?.data != null) {
    result.hourly = parts.hourly.data;
  }
  if (parts.daily?.data != null) {
    result.daily = parts.daily.data;
  }

  return result;
}

export function selectDailyRecord(
  records: OneCallRecord[],
  requestedDate: string,
  timeZone?: string,
): OneCallRecord | undefined {
  return records.find(
    (record) =>
      typeof record.dt === 'number' && dateStringInTimeZone(record.dt, timeZone) === requestedDate,
  );
}

function definedFields<T extends object>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, field]) => field !== undefined);
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries) as T;
}

export function normalizeDailyAggregation(
  response: OneCallResponse,
  requestedDate: string,
  units: string,
  timeZone?: string,
): DailyAggregationResult {
  const zone = timeZone ?? response.timezone;
  const record = selectDailyRecord(response.data ?? [], requestedDate, zone);
  const temp = isDailyTemperature(record?.temp) ? record.temp : undefined;

  return {
    lat: response.lat,
    lon: response.lon,
    tz: zone,
    date: requestedDate,
    units,
    temperature: definedFields({
      min: temp?.min,
      max: temp?.max,
      morning: temp?.morn,
      afternoon: temp?.day,
      evening: temp?.eve,
      night: temp?.night,
    }),
  };
}

function formatOverviewFromCurrent(record: OneCallRecord, units: string): string | undefined {
  if (typeof record.temp !== 'number') {
    return undefined;
  }
  const suffix = unitSuffix(units);
  const feels =
    typeof record.feels_like === 'number'
      ? ` with a real feel of ${roundDegree(record.feels_like)}${suffix}`
      : '';
  const description = record.weather?.[0]?.description;
  const sky = description ? ` The sky is ${description}.` : '';
  return `Currently, the temperature is ${roundDegree(record.temp)}${suffix}${feels}.${sky}`.trim();
}

function formatOverviewFromDaily(record: OneCallRecord, units: string): string | undefined {
  if (!isDailyTemperature(record.temp)) {
    return undefined;
  }
  const suffix = unitSuffix(units);
  const min = record.temp.min;
  const max = record.temp.max;
  const description = record.weather?.[0]?.description;
  const sky = description ? ` ${description.charAt(0).toUpperCase()}${description.slice(1)}.` : '';
  if (typeof min === 'number' && typeof max === 'number') {
    return `Temperatures range from ${roundDegree(min)}${suffix} to ${roundDegree(max)}${suffix}.${sky}`.trim();
  }
  if (typeof record.temp.day === 'number') {
    return `The daytime temperature is ${roundDegree(record.temp.day)}${suffix}.${sky}`.trim();
  }
  return undefined;
}

export function synthesizeOverview(params: {
  current?: OneCallRecord;
  daily?: OneCallRecord;
  date: string;
  units: string;
  lat?: number;
  lon?: number;
  timezone?: string;
}): OverviewResult {
  const weather_overview =
    (params.current != null
      ? formatOverviewFromCurrent(params.current, params.units)
      : undefined) ??
    (params.daily != null ? formatOverviewFromDaily(params.daily, params.units) : undefined) ??
    'Weather overview is unavailable for this location.';

  return {
    lat: params.lat,
    lon: params.lon,
    tz: params.timezone,
    date: params.date,
    units: params.units,
    weather_overview,
  };
}

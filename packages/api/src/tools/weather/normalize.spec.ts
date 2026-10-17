import type { OneCallRecord, OneCallResponse } from './types';
import {
  collectAlertIds,
  dateStringInTimeZone,
  normalizeCurrentForecast,
  normalizeDailyAggregation,
  omitRecordAlerts,
  selectDailyRecord,
  stripPagination,
  synthesizeOverview,
  unixAtLocalMidnight,
  utcDateString,
} from './normalize';

const currentResponse: OneCallResponse = {
  lat: 35.9606,
  lon: -83.9207,
  timezone: 'America/New_York',
  timezone_offset: -18000,
  data: [
    {
      dt: 1583280000,
      temp: 20.4,
      feels_like: 18.6,
      weather: [{ description: 'clear sky' }],
    },
  ],
};

const dailyResponse: OneCallResponse = {
  lat: 35.9606,
  lon: -83.9207,
  timezone: 'America/New_York',
  data: [
    {
      dt: 1583298000,
      temp: { morn: 10.2, day: 20.4, eve: 15.6, night: 8.1, min: 7.4, max: 21.9 },
      humidity: 70,
      clouds: 12,
      pressure: 1016,
      wind_speed: 4.2,
      wind_deg: 180,
      weather: [{ description: 'few clouds' }],
    },
  ],
  next: 'https://api.openweathermap.org/data/4.0/onecall/timeline/1day?appid=SECRET',
};

describe('OpenWeather 4.0 normalizers', () => {
  it('formats a unix timestamp as a UTC YYYY-MM-DD date', () => {
    expect(utcDateString(1583280000)).toBe('2020-03-04');
  });

  it('formats a unix timestamp in an offset or IANA timezone', () => {
    expect(dateStringInTimeZone(1583280000, '-05:00')).toBe('2020-03-03');
    expect(dateStringInTimeZone(1583298000, '-05:00')).toBe('2020-03-04');
    expect(dateStringInTimeZone(1583298000, 'America/New_York')).toBe('2020-03-04');
  });

  it('converts a calendar date to local midnight unix seconds', () => {
    expect(unixAtLocalMidnight(2020, 3, 4)).toBe(1583280000);
    expect(unixAtLocalMidnight(2020, 3, 4, '-05:00')).toBe(1583298000);
    expect(unixAtLocalMidnight(2020, 3, 4, 'America/New_York')).toBe(1583298000);
    expect(unixAtLocalMidnight(2020, 7, 4, 'America/New_York')).toBe(
      Math.floor(Date.UTC(2020, 6, 4, 4) / 1000),
    );
  });

  it('lifts 4.0 data arrays into the current/hourly/daily/minutely contract', () => {
    const result = normalizeCurrentForecast({
      current: currentResponse,
      hourly: { data: [{ dt: 1, temp: 19 }] },
      daily: dailyResponse,
      minutely: { data: [{ dt: 1, precipitation: 0 }] },
    });

    expect(result.lat).toBe(35.9606);
    expect(result.lon).toBe(-83.9207);
    expect(result.timezone).toBe('America/New_York');
    expect(result.current?.temp).toBe(20.4);
    expect(result.hourly?.[0].temp).toBe(19);
    expect(result.daily?.[0].temp).toEqual(dailyResponse.data?.[0].temp);
    expect(result.minutely?.[0].precipitation).toBe(0);
  });

  it('maps a 4.0 daily record onto the day-summary temperature fields only', () => {
    const result = normalizeDailyAggregation(dailyResponse, '2020-03-04', 'metric');

    expect(result.date).toBe('2020-03-04');
    expect(result.units).toBe('metric');
    expect(result.tz).toBe('America/New_York');
    expect(result.temperature).toEqual({
      min: 7.4,
      max: 21.9,
      morning: 10.2,
      afternoon: 20.4,
      evening: 15.6,
      night: 8.1,
    });
    expect(result.humidity).toBeUndefined();
    expect(result.cloud_cover).toBeUndefined();
    expect(result.pressure).toBeUndefined();
    expect(result.wind).toBeUndefined();
    expect(result.precipitation).toBeUndefined();
  });

  it.each([
    ['rain-only hourly rate', { rain: { '1h': 2 } }],
    ['snow-only hourly rate', { snow: { '1h': 3 } }],
    ['mixed hourly rain and snow rates', { rain: { '1h': 2 }, snow: { '1h': 3 } }],
    ['unavailable daily totals', {}],
  ] as const)('omits precipitation.total for %s', (_label, extra) => {
    const response: OneCallResponse = {
      lat: 35.9606,
      lon: -83.9207,
      timezone: 'America/New_York',
      data: [
        {
          dt: 1583298000,
          temp: { morn: 10.2, day: 20.4, eve: 15.6, night: 8.1, min: 7.4, max: 21.9 },
          ...extra,
        },
      ],
    };
    const result = normalizeDailyAggregation(response, '2020-03-04', 'metric');
    expect(result.precipitation).toBeUndefined();
  });

  it('selects the daily record whose UTC date matches the request', () => {
    const records: OneCallRecord[] = [
      { dt: 1583193600, temp: { day: 1 } },
      { dt: 1583280000, temp: { day: 2 } },
    ];
    expect(selectDailyRecord(records, '2020-03-04')?.temp).toEqual({ day: 2 });
  });

  it('selects the daily record whose local date matches when tz is set', () => {
    const records: OneCallRecord[] = [
      { dt: 1583280000, temp: { day: 1 } },
      { dt: 1583298000, temp: { day: 2 } },
    ];
    expect(selectDailyRecord(records, '2020-03-04', 'America/New_York')?.temp).toEqual({ day: 2 });
  });

  it('returns undefined when no daily record matches the requested date', () => {
    const records: OneCallRecord[] = [
      { dt: Math.floor(Date.UTC(2026, 8, 22) / 1000), temp: { day: 22 } },
    ];
    expect(selectDailyRecord(records, '2026-09-21')).toBeUndefined();
    expect(selectDailyRecord(records, '2026-09-21', 'UTC')).toBeUndefined();
  });

  it('does not label a different day as the requested daily_aggregation date', () => {
    const response: OneCallResponse = {
      lat: 1,
      lon: 2,
      timezone: 'UTC',
      data: [
        {
          dt: Math.floor(Date.UTC(2026, 8, 22) / 1000),
          temp: { morn: 10, day: 22, eve: 16, night: 8, min: 7, max: 23 },
        },
      ],
    };
    const result = normalizeDailyAggregation(response, '2026-09-21', 'metric', 'UTC');
    expect(result.date).toBe('2026-09-21');
    expect(result.temperature).toBeUndefined();
    expect(result.precipitation).toBeUndefined();
  });

  it('stringifies numeric alert ids and drops duplicates', () => {
    expect(collectAlertIds([{ alerts: ['abc', 'abc'] }, { alerts: ['def'] }])).toEqual([
      'abc',
      'def',
    ]);
  });

  it('omits alert ids from a record', () => {
    expect(omitRecordAlerts({ temp: 20, alerts: ['abc'] })).toEqual({ temp: 20 });
  });

  it('drops next/prev so pagination URLs never leave the client', () => {
    const stripped = stripPagination(dailyResponse);
    expect(stripped.next).toBeUndefined();
    expect(stripped.prev).toBeUndefined();
    expect(stripped.data).toEqual(dailyResponse.data);
  });

  it('synthesizes an overview from current conditions with rounded temperatures', () => {
    const result = synthesizeOverview({
      current: currentResponse.data?.[0],
      date: '2020-03-04',
      units: 'metric',
      lat: 35.96,
      lon: -83.92,
      timezone: 'America/New_York',
    });

    expect(result.weather_overview).toBe(
      'Currently, the temperature is 20°C with a real feel of 19°C. The sky is clear sky.',
    );
    expect(result.units).toBe('metric');
    expect(result.date).toBe('2020-03-04');
  });

  it('synthesizes an overview from a daily record when current weather is absent', () => {
    const result = synthesizeOverview({
      daily: dailyResponse.data?.[0],
      date: '2020-03-04',
      units: 'imperial',
    });

    expect(result.weather_overview).toBe('Temperatures range from 7°F to 22°F. Few clouds.');
  });
});

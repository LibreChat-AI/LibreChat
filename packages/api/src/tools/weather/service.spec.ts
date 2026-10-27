import type { OpenWeatherFetcher } from './types';
import {
  convertDateToUnix,
  executeOpenWeather,
  getOpenWeatherHelp,
  isOpenWeatherPaginationUrl,
  resolveOpenWeatherOneCallVersion,
} from './service';
import { OPEN_WEATHER_TOOL_DESCRIPTION } from '../registry/definitions';

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function createFetch(handler: (url: URL) => ReturnType<typeof jsonResponse>): {
  fetch: OpenWeatherFetcher;
  urls: string[];
} {
  const urls: string[] = [];
  const fetch: OpenWeatherFetcher = async (url) => {
    urls.push(url);
    return handler(new URL(url));
  };
  return { fetch, urls };
}

describe('executeOpenWeather', () => {
  const apiKey = 'test-api-key';
  const geoBody = [{ lat: 35.9606, lon: -83.9207 }];

  it('resolves OPENWEATHER_ONECALL_VERSION to 4.0 unless it is exactly 3.0', () => {
    expect(resolveOpenWeatherOneCallVersion()).toBe('4.0');
    expect(resolveOpenWeatherOneCallVersion(undefined)).toBe('4.0');
    expect(resolveOpenWeatherOneCallVersion('4.0')).toBe('4.0');
    expect(resolveOpenWeatherOneCallVersion('3.0')).toBe('3.0');
    expect(resolveOpenWeatherOneCallVersion(' 3.0 ')).toBe('3.0');
    expect(resolveOpenWeatherOneCallVersion('3')).toBe('4.0');
  });

  it('describes One Call API 4.0 in the tool string and default help payload', () => {
    expect(OPEN_WEATHER_TOOL_DESCRIPTION).toContain('One Call API 4.0');
    const help = JSON.parse(getOpenWeatherHelp()) as {
      title: string;
      notes: string[];
    };
    expect(help.title).toBe('OpenWeather One Call API 4.0 Help');
    expect(help.notes.some((note) => note.includes('OPENWEATHER_ONECALL_VERSION=3.0'))).toBe(true);
    expect(help.notes.some((note) => note.includes('up to 20h'))).toBe(true);
  });

  it('describes One Call API 3.0 when that product is selected', () => {
    const help = JSON.parse(getOpenWeatherHelp('3.0')) as { title: string };
    expect(help.title).toBe('OpenWeather One Call API 3.0 Help');
  });

  it('converts a calendar date to a UTC unix timestamp and rejects non-ISO dates', () => {
    expect(convertDateToUnix('2020-03-04')).toBe(1583280000);
    expect(convertDateToUnix('2020-03-04', '-05:00')).toBe(1583298000);
    expect(convertDateToUnix('2020-03-04', 'America/New_York')).toBe(1583298000);
    expect(() => convertDateToUnix('03-04-2020')).toThrow(
      'Invalid date format. Expected YYYY-MM-DD.',
    );
  });

  it('accepts only https OpenWeather 4.0 pagination URLs', () => {
    expect(
      isOpenWeatherPaginationUrl(
        'https://api.openweathermap.org/data/4.0/onecall/timeline/1h?start=1',
      ),
    ).toBe(true);
    expect(
      isOpenWeatherPaginationUrl(
        'http://api.openweathermap.org/data/4.0/onecall/timeline/1h?start=1',
      ),
    ).toBe(false);
    expect(isOpenWeatherPaginationUrl('https://evil.example/data/4.0/onecall/timeline/1h')).toBe(
      false,
    );
  });

  it('geocodes a city and combines 4.0 current, hourly, and daily without minutely', async () => {
    const { fetch, urls } = createFetch((url) => {
      if (url.pathname === '/geo/1.0/direct') {
        return jsonResponse(geoBody);
      }
      if (url.pathname === '/data/4.0/onecall/current') {
        return jsonResponse({
          lat: 35.9606,
          lon: -83.9207,
          timezone: 'America/New_York',
          data: [{ temp: 293.15, feels_like: 295.15 }],
        });
      }
      if (url.pathname === '/data/4.0/onecall/timeline/1h') {
        return jsonResponse({ data: [{ dt: 1, temp: 291.4 }] });
      }
      if (url.pathname === '/data/4.0/onecall/timeline/1day') {
        return jsonResponse({
          data: [{ temp: { day: 293.15, night: 283.15 } }],
        });
      }
      throw new Error(`unexpected url ${url.toString()}`);
    });

    const result = JSON.parse(
      await executeOpenWeather(
        { action: 'current_forecast', city: 'Knoxville, Tennessee', units: 'Kelvin' },
        { apiKey, fetch },
      ),
    ) as {
      current: { temp: number; feels_like: number };
      daily: Array<{ temp: { day: number; night: number } }>;
      hourly: Array<{ temp: number }>;
    };

    expect(result.current.temp).toBe(293);
    expect(result.current.feels_like).toBe(295);
    expect(result.daily[0].temp.day).toBe(293);
    expect(result.daily[0].temp.night).toBe(283);
    expect(result.hourly[0].temp).toBe(291);

    const paths = urls.map((url) => new URL(url).pathname);
    expect(paths).toContain('/geo/1.0/direct');
    expect(paths).toContain('/data/4.0/onecall/current');
    expect(paths).toContain('/data/4.0/onecall/timeline/1h');
    expect(paths).toContain('/data/4.0/onecall/timeline/1day');
    expect(paths).not.toContain('/data/4.0/onecall/timeline/1min');
    expect(urls.some((url) => url.includes('/data/3.0/'))).toBe(false);

    const hourlyUrl = urls.find((url) => url.includes('/timeline/1h'));
    expect(hourlyUrl).toContain('cnt=20');

    const currentUrl = urls.find((url) => url.includes('/onecall/current'));
    expect(currentUrl).toContain('units=standard');
    expect(currentUrl).toContain('appid=test-api-key');
  });

  it('skips excluded current_forecast parts', async () => {
    const { fetch, urls } = createFetch((url) => {
      if (url.pathname === '/data/4.0/onecall/current') {
        return jsonResponse({ data: [{ temp: 20 }] });
      }
      throw new Error(`unexpected url ${url.toString()}`);
    });

    const result = JSON.parse(
      await executeOpenWeather(
        {
          action: 'current_forecast',
          lat: 35.96,
          lon: -83.92,
          exclude: 'hourly,daily,minutely',
        },
        { apiKey, fetch },
      ),
    ) as { current: { temp: number }; hourly?: unknown; daily?: unknown; minutely?: unknown };

    expect(result.current.temp).toBe(20);
    expect(result.hourly).toBeUndefined();
    expect(result.daily).toBeUndefined();
    expect(result.minutely).toBeUndefined();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/data/4.0/onecall/current');
  });

  it('fetches minutely only when +minutely is requested', async () => {
    const { fetch, urls } = createFetch((url) => {
      if (url.pathname === '/data/4.0/onecall/timeline/1min') {
        return jsonResponse({ data: [{ dt: 1, precipitation: 0.2 }] });
      }
      throw new Error(`unexpected url ${url.toString()}`);
    });

    const result = JSON.parse(
      await executeOpenWeather(
        {
          action: 'current_forecast',
          lat: 35.96,
          lon: -83.92,
          exclude: 'current,hourly,daily,+minutely',
        },
        { apiKey, fetch },
      ),
    ) as { minutely: Array<{ precipitation: number }> };

    expect(result.minutely[0].precipitation).toBe(0.2);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/timeline/1min');
    expect(urls[0]).toContain('cnt=60');
  });

  it('uses timeline/1h with start for timestamp and strips pagination secrets', async () => {
    const { fetch, urls } = createFetch((url) => {
      if (url.pathname === '/data/4.0/onecall/timeline/1h') {
        return jsonResponse({
          lat: 35.96,
          data: [{ dt: 1583280000, temp: 283.15, feels_like: 280.15 }],
          next: 'https://api.openweathermap.org/data/4.0/onecall/timeline/1h?appid=SECRET&start=2',
        });
      }
      throw new Error(`unexpected url ${url.toString()}`);
    });

    const raw = await executeOpenWeather(
      { action: 'timestamp', lat: 35.96, lon: -83.92, date: '2020-03-04', units: 'Kelvin' },
      { apiKey, fetch },
    );
    const parsed = JSON.parse(raw) as {
      data: Array<{ temp: number; feels_like: number }>;
      next?: string;
    };

    expect(urls[0]).toContain('/data/4.0/onecall/timeline/1h');
    expect(urls[0]).toContain(`start=${1583280000}`);
    expect(urls[0]).toContain('cnt=20');
    expect(parsed.data[0].temp).toBe(283);
    expect(parsed.data[0].feels_like).toBe(280);
    expect(parsed.next).toBeUndefined();
    expect(raw).not.toContain('SECRET');
    expect(raw).not.toContain('appid=');
  });

  it('does not follow hourly next links by default so one billed page is at most 20h', async () => {
    const { fetch, urls } = createFetch((url) => {
      if (!url.pathname.endsWith('/timeline/1h')) {
        return jsonResponse({ data: [] });
      }
      return jsonResponse({
        data: Array.from({ length: 20 }, (_, i) => ({ dt: i, temp: 10 })),
        next: 'https://api.openweathermap.org/data/4.0/onecall/timeline/1h?start=20&appid=SECRET',
      });
    });

    const parsed = JSON.parse(
      await executeOpenWeather(
        { action: 'current_forecast', lat: 1, lon: 2, exclude: 'current,daily,minutely' },
        { apiKey, fetch },
      ),
    ) as { hourly: Array<{ dt: number }> };

    expect(parsed.hourly).toHaveLength(20);
    expect(parsed.hourly[0].dt).toBe(0);
    expect(parsed.hourly[19].dt).toBe(19);
    expect(urls.filter((url) => url.includes('/timeline/1h'))).toHaveLength(1);
    expect(JSON.stringify(parsed)).not.toContain('SECRET');
  });

  it('refuses to follow pagination off of api.openweathermap.org', async () => {
    const { fetch, urls } = createFetch((url) => {
      if (url.pathname.endsWith('/timeline/1h')) {
        return jsonResponse({
          data: [{ dt: 1, temp: 10 }],
          next: 'https://evil.example/data/4.0/onecall/timeline/1h?appid=SECRET',
        });
      }
      return jsonResponse({ data: [] });
    });

    const parsed = JSON.parse(
      await executeOpenWeather(
        { action: 'current_forecast', lat: 1, lon: 2, exclude: 'current,daily,minutely' },
        { apiKey, fetch },
      ),
    ) as { hourly: Array<{ dt: number }> };

    expect(parsed.hourly).toHaveLength(1);
    expect(urls.filter((url) => url.includes('evil.example'))).toHaveLength(0);
  });

  it('keeps successful current_forecast parts when another endpoint fails', async () => {
    const { fetch } = createFetch((url) => {
      if (url.pathname === '/data/4.0/onecall/current') {
        return jsonResponse({ data: [{ temp: 21.4 }] });
      }
      if (url.pathname === '/data/4.0/onecall/timeline/1h') {
        return jsonResponse({ message: 'plan does not include hourly' }, 401);
      }
      if (url.pathname === '/data/4.0/onecall/timeline/1day') {
        return jsonResponse({ data: [{ temp: { day: 22 } }] });
      }
      throw new Error(`unexpected url ${url.toString()}`);
    });

    const parsed = JSON.parse(
      await executeOpenWeather({ action: 'current_forecast', lat: 1, lon: 2 }, { apiKey, fetch }),
    ) as {
      current: { temp: number };
      daily: Array<{ temp: { day: number } }>;
      hourly?: unknown;
      errors: string[];
    };

    expect(parsed.current.temp).toBe(21);
    expect(parsed.daily[0].temp.day).toBe(22);
    expect(parsed.hourly).toBeUndefined();
    expect(parsed.errors.some((error) => error.startsWith('hourly:'))).toBe(true);
  });

  it('stringifies numeric alert ids and resolves them only when present', async () => {
    const { fetch, urls } = createFetch((url) => {
      if (url.pathname === '/data/4.0/onecall/current') {
        return jsonResponse({
          data: [{ temp: 20, alerts: [1684952747, 'abc-1'] }],
        });
      }
      if (url.pathname === '/data/4.0/onecall/alert/1684952747') {
        return jsonResponse({
          sender_name: 'NWS',
          event: 'Flood Warning',
          start: 1,
          end: 2,
          description: 'Flooding expected',
          tags: ['Flood'],
        });
      }
      if (url.pathname === '/data/4.0/onecall/alert/abc-1') {
        return jsonResponse({ event: 'Wind Advisory', sender_name: 'NWS' });
      }
      throw new Error(`unexpected url ${url.toString()}`);
    });

    const parsed = JSON.parse(
      await executeOpenWeather(
        { action: 'current_forecast', lat: 1, lon: 2, exclude: 'hourly,daily' },
        { apiKey, fetch },
      ),
    ) as {
      current: { alerts: string[] };
      alerts: Array<{ id: string; event?: string }>;
    };

    expect(parsed.current.alerts).toEqual(['1684952747', 'abc-1']);
    expect(parsed.alerts).toEqual([
      {
        id: '1684952747',
        sender_name: 'NWS',
        event: 'Flood Warning',
        start: 1,
        end: 2,
        description: 'Flooding expected',
        tags: ['Flood'],
      },
      { id: 'abc-1', event: 'Wind Advisory', sender_name: 'NWS' },
    ]);
    expect(urls.some((url) => url.includes('/onecall/alert/1684952747'))).toBe(true);
    expect(urls.some((url) => url.includes('/onecall/alert/abc-1'))).toBe(true);
  });

  it('resolves the documented 4.0 opaque alert id and multilingual descriptions', async () => {
    const officialAlertId =
      '2.49.0.0.250.0.FR.20260827100603.644023:FR615:a512b287066f8f19b5b02accccec835d';
    const officialAlert = {
      id: officialAlertId,
      sender_name: 'METEO-FRANCE',
      event: '',
      start: 1787817940,
      end: 1787868000,
      description: [
        {
          language: 'fr-FR',
          description:
            "Des phénomènes habituels dans la région mais occasionnellement et localement dangereux sont prévus (exemple : mistral, orage d'été, montée des eaux, fortes vagues submergeant le littoral).",
        },
        {
          language: 'en-GB',
          description:
            'Moderate damages may occur, especially in vulnerable or in exposed areas and to people who carry out weather-related activities.',
        },
      ],
      tags: ['Thunderstorm'],
    };

    const { fetch, urls } = createFetch((url) => {
      if (url.pathname === '/data/4.0/onecall/current') {
        return jsonResponse({
          data: [{ temp: 20, alerts: [officialAlertId] }],
        });
      }
      if (url.pathname.startsWith('/data/4.0/onecall/alert/')) {
        const requestedId = decodeURIComponent(
          url.pathname.slice('/data/4.0/onecall/alert/'.length),
        );
        if (requestedId === officialAlertId) {
          return jsonResponse(officialAlert);
        }
      }
      throw new Error(`unexpected url ${url.toString()}`);
    });

    const parsed = JSON.parse(
      await executeOpenWeather(
        { action: 'current_forecast', lat: 1, lon: 2, exclude: 'hourly,daily' },
        { apiKey, fetch },
      ),
    ) as {
      current: { alerts: string[] };
      alerts: Array<{
        id: string;
        sender_name?: string;
        event?: string;
        description?: string;
        tags?: string[];
      }>;
    };

    expect(parsed.current.alerts).toEqual([officialAlertId]);
    expect(parsed.alerts).toHaveLength(1);
    expect(parsed.alerts[0].id).toBe(officialAlertId);
    expect(parsed.alerts[0].sender_name).toBe('METEO-FRANCE');
    expect(parsed.alerts[0].event).toBe('');
    expect(parsed.alerts[0].tags).toEqual(['Thunderstorm']);
    expect(parsed.alerts[0].description).toContain(
      'Moderate damages may occur, especially in vulnerable or in exposed areas and to people who carry out weather-related activities.',
    );
    expect(parsed.alerts[0].description).toContain(
      "Des phénomènes habituels dans la région mais occasionnellement et localement dangereux sont prévus (exemple : mistral, orage d'été, montée des eaux, fortes vagues submergeant le littoral).",
    );
    expect(urls.some((url) => url.includes(encodeURIComponent(officialAlertId)))).toBe(true);
  });

  it('skips path-navigating alert ids without requesting the detail endpoint', async () => {
    const { fetch, urls } = createFetch((url) => {
      if (url.pathname === '/data/4.0/onecall/current') {
        return jsonResponse({
          data: [{ temp: 20, alerts: ['../secret', 'foo/bar', 'abc-1'] }],
        });
      }
      if (url.pathname === '/data/4.0/onecall/alert/abc-1') {
        return jsonResponse({ event: 'Wind Advisory', sender_name: 'NWS' });
      }
      throw new Error(`unexpected url ${url.toString()}`);
    });

    const parsed = JSON.parse(
      await executeOpenWeather(
        { action: 'current_forecast', lat: 1, lon: 2, exclude: 'hourly,daily' },
        { apiKey, fetch },
      ),
    ) as { alerts?: Array<{ id: string }>; errors?: string[] };

    expect(parsed.alerts).toEqual([{ id: 'abc-1', event: 'Wind Advisory', sender_name: 'NWS' }]);
    expect(parsed.errors?.some((error) => error.includes('../secret'))).toBe(true);
    expect(parsed.errors?.some((error) => error.includes('foo/bar'))).toBe(true);
    expect(urls.some((url) => url.includes('../') || url.includes('foo/bar'))).toBe(false);
  });

  it('does not resolve alerts when they are excluded', async () => {
    const { fetch, urls } = createFetch((url) => {
      if (url.pathname === '/data/4.0/onecall/current') {
        return jsonResponse({
          data: [{ temp: 20, alerts: ['abc-1'] }],
        });
      }
      throw new Error(`unexpected url ${url.toString()}`);
    });

    const parsed = JSON.parse(
      await executeOpenWeather(
        { action: 'current_forecast', lat: 1, lon: 2, exclude: 'hourly,daily,alerts' },
        { apiKey, fetch },
      ),
    ) as { current: { alerts?: string[] }; alerts?: unknown };

    expect(parsed.current.alerts).toBeUndefined();
    expect(parsed.alerts).toBeUndefined();
    expect(urls.some((url) => url.includes('/onecall/alert/'))).toBe(false);
  });

  it('maps timeline/1day onto the daily_aggregation contract', async () => {
    const { fetch, urls } = createFetch((url) => {
      if (url.pathname === '/data/4.0/onecall/timeline/1day') {
        return jsonResponse({
          timezone: 'America/New_York',
          data: [
            {
              dt: 1583298000,
              temp: { morn: 283.15, day: 293.15, eve: 288.15, night: 280 },
            },
          ],
        });
      }
      throw new Error(`unexpected url ${url.toString()}`);
    });

    const parsed = JSON.parse(
      await executeOpenWeather(
        {
          action: 'daily_aggregation',
          lat: 35.96,
          lon: -83.92,
          date: '2020-03-04',
          units: 'Kelvin',
          tz: 'America/New_York',
        },
        { apiKey, fetch },
      ),
    ) as { temperature: { morning: number; afternoon: number; evening: number }; tz: string };

    expect(urls[0]).toContain('/data/4.0/onecall/timeline/1day');
    expect(urls[0]).toContain(`start=${1583298000}`);
    expect(parsed.temperature.morning).toBe(283);
    expect(parsed.temperature.afternoon).toBe(293);
    expect(parsed.temperature.evening).toBe(288);
    expect(parsed.tz).toBe('America/New_York');
  });

  it('returns no daily_aggregation temperature when the requested date is absent', async () => {
    const { fetch } = createFetch((url) => {
      if (url.pathname === '/data/4.0/onecall/timeline/1day') {
        return jsonResponse({
          timezone: 'UTC',
          data: [
            {
              dt: Math.floor(Date.UTC(2026, 8, 22) / 1000),
              temp: { morn: 10, day: 22, eve: 16, night: 8, min: 7, max: 23 },
            },
          ],
        });
      }
      throw new Error(`unexpected url ${url.toString()}`);
    });

    const parsed = JSON.parse(
      await executeOpenWeather(
        {
          action: 'daily_aggregation',
          lat: 1,
          lon: 2,
          date: '2026-09-21',
          units: 'Celsius',
        },
        { apiKey, fetch },
      ),
    ) as { date: string; temperature?: { afternoon?: number } };

    expect(parsed.date).toBe('2026-09-21');
    expect(parsed.temperature).toBeUndefined();
  });

  it.each([
    ['rain-only hourly rate', { rain: { '1h': 2 } }],
    ['snow-only hourly rate', { snow: { '1h': 3 } }],
    ['mixed hourly rain and snow rates', { rain: { '1h': 2 }, snow: { '1h': 3 } }],
    ['unavailable daily totals', {}],
  ] as const)('omits daily_aggregation precipitation.total for %s', async (_label, extra) => {
    const { fetch } = createFetch((url) => {
      if (url.pathname === '/data/4.0/onecall/timeline/1day') {
        return jsonResponse({
          timezone: 'America/New_York',
          data: [
            {
              dt: 1583298000,
              temp: { morn: 10.2, day: 20.4, eve: 15.6, night: 8.1, min: 7.4, max: 21.9 },
              ...extra,
            },
          ],
        });
      }
      throw new Error(`unexpected url ${url.toString()}`);
    });

    const parsed = JSON.parse(
      await executeOpenWeather(
        {
          action: 'daily_aggregation',
          lat: 35.96,
          lon: -83.92,
          date: '2020-03-04',
          tz: 'America/New_York',
        },
        { apiKey, fetch },
      ),
    ) as { precipitation?: { total?: number }; temperature?: { afternoon?: number } };

    expect(parsed.temperature?.afternoon).toBe(20);
    expect(parsed.precipitation).toBeUndefined();
  });

  it('synthesizes overview from current weather when 4.0 has no overview endpoint', async () => {
    const { fetch, urls } = createFetch((url) => {
      if (url.pathname === '/data/4.0/onecall/current') {
        return jsonResponse({
          lat: 35.9606,
          lon: -83.9207,
          timezone: 'America/New_York',
          data: [
            {
              dt: 1704585600,
              temp: 2,
              feels_like: -2,
              weather: [{ description: 'clear sky' }],
            },
          ],
        });
      }
      throw new Error(`unexpected url ${url.toString()}`);
    });

    const parsed = JSON.parse(
      await executeOpenWeather(
        { action: 'overview', lat: 35.9606, lon: -83.9207, units: 'Celsius' },
        { apiKey, fetch },
      ),
    ) as { weather_overview: string; units: string; date: string };

    expect(urls[0]).toContain('/data/4.0/onecall/current');
    expect(parsed.units).toBe('metric');
    expect(parsed.date).toBe('2024-01-06');
    expect(parsed.weather_overview).toContain('2°C');
    expect(parsed.weather_overview).toContain('-2°C');
    expect(parsed.weather_overview.length).toBeGreaterThan(0);
  });

  it('does not synthesize a dated overview from a different day', async () => {
    const { fetch } = createFetch((url) => {
      if (url.pathname === '/data/4.0/onecall/timeline/1day') {
        return jsonResponse({
          lat: 1,
          lon: 2,
          timezone: 'UTC',
          data: [
            {
              dt: Math.floor(Date.UTC(2026, 8, 22) / 1000),
              temp: { min: 7.4, max: 21.9, day: 22 },
              weather: [{ description: 'few clouds' }],
            },
          ],
        });
      }
      throw new Error(`unexpected url ${url.toString()}`);
    });

    const parsed = JSON.parse(
      await executeOpenWeather(
        {
          action: 'overview',
          lat: 1,
          lon: 2,
          date: '2026-09-21',
          units: 'Celsius',
        },
        { apiKey, fetch },
      ),
    ) as { date: string; weather_overview: string };

    expect(parsed.date).toBe('2026-09-21');
    expect(parsed.weather_overview).toBe('Weather overview is unavailable for this location.');
    expect(parsed.weather_overview).not.toContain('22');
    expect(parsed.weather_overview).not.toContain('7');
  });

  it('uses One Call 3.0 endpoints when that product is selected', async () => {
    const { fetch, urls } = createFetch((url) => {
      if (url.pathname === '/geo/1.0/direct') {
        return jsonResponse(geoBody);
      }
      if (url.pathname === '/data/3.0/onecall') {
        return jsonResponse({
          lat: 35.9606,
          current: { temp: 20.4, feels_like: 18.6 },
        });
      }
      throw new Error(`unexpected url ${url.toString()}`);
    });

    const parsed = JSON.parse(
      await executeOpenWeather(
        { action: 'current_forecast', city: 'Knoxville, Tennessee' },
        { apiKey, fetch, oneCallVersion: '3.0' },
      ),
    ) as { current: { temp: number; feels_like: number } };

    expect(parsed.current.temp).toBe(20);
    expect(parsed.current.feels_like).toBe(19);
    expect(urls.some((url) => url.includes('/data/3.0/onecall'))).toBe(true);
    expect(urls.some((url) => url.includes('/data/4.0/'))).toBe(false);

    const help = JSON.parse(
      await executeOpenWeather({ action: 'help' }, { apiKey, fetch, oneCallVersion: '3.0' }),
    ) as { title: string };
    expect(help.title).toBe('OpenWeather One Call API 3.0 Help');
  });

  it('passes tz through to the 3.0 day_summary endpoint', async () => {
    const { fetch, urls } = createFetch((url) => {
      if (url.pathname === '/data/3.0/onecall/day_summary') {
        return jsonResponse({
          date: '2020-03-04',
          temperature: { morning: 10.2, afternoon: 20.4, evening: 15.6 },
        });
      }
      throw new Error(`unexpected url ${url.toString()}`);
    });

    const parsed = JSON.parse(
      await executeOpenWeather(
        {
          action: 'daily_aggregation',
          lat: 35.96,
          lon: -83.92,
          date: '2020-03-04',
          tz: '-05:00',
        },
        { apiKey, fetch, oneCallVersion: '3.0' },
      ),
    ) as { temperature: { morning: number } };

    expect(parsed.temperature.morning).toBe(10);
    expect(urls[0]).toContain('/data/3.0/onecall/day_summary');
    expect(urls[0]).toContain('date=2020-03-04');
    expect(urls[0]).toContain('tz=-05%3A00');
  });

  it('returns the original error strings for missing dates and missing coordinates', async () => {
    const fetch: OpenWeatherFetcher = async () => {
      throw new Error('fetch should not run');
    };

    expect(
      await executeOpenWeather({ action: 'timestamp', lat: 1, lon: 2 }, { apiKey, fetch }),
    ).toBe("Error: For timestamp action, a 'date' in YYYY-MM-DD format is required.");
    expect(
      await executeOpenWeather({ action: 'daily_aggregation', lat: 1, lon: 2 }, { apiKey, fetch }),
    ).toBe('Error: date (YYYY-MM-DD) is required for daily_aggregation action.');
    expect(await executeOpenWeather({ action: 'current_forecast' }, { apiKey, fetch })).toBe(
      "Error: lat and lon are required and must be numbers for this action (or specify 'city').",
    );
    expect(await executeOpenWeather({ action: 'unknown_action' }, { apiKey, fetch })).toBe(
      'Error: Unknown action: unknown_action',
    );
  });

  it('returns a descriptive error when geocoding finds nothing', async () => {
    const { fetch } = createFetch(() => jsonResponse([]));
    const result = await executeOpenWeather(
      { action: 'current_forecast', city: 'NowhereCity' },
      { apiKey, fetch },
    );
    expect(result).toBe('Error: Could not find coordinates for city: NowhereCity');
  });

  it('returns OpenWeather HTTP failures without calling a live API', async () => {
    const { fetch } = createFetch((url) => {
      if (url.pathname === '/geo/1.0/direct') {
        return jsonResponse(geoBody);
      }
      return jsonResponse({ message: 'Not found' }, 404);
    });

    const result = await executeOpenWeather(
      {
        action: 'current_forecast',
        city: 'Knoxville, Tennessee',
        exclude: 'hourly,daily,minutely',
      },
      { apiKey, fetch },
    );
    expect(result).toBe('Error: OpenWeather API request failed with status 404: Not found');
  });
});

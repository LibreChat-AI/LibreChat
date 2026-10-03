const OpenWeather = require('../OpenWeather');
const fetch = require('node-fetch');

process.env.OPENWEATHER_API_KEY = 'test-api-key';

jest.mock('node-fetch', () => jest.fn());

const GEO = { lat: 35.9606, lon: -83.9207 };

function jsonResponse(body, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

function mockOpenWeather({
  geo = [GEO],
  current,
  hourly,
  daily,
  minutely,
  errorStatus,
  errorBody,
} = {}) {
  fetch.mockImplementation((url) => {
    if (url.includes('geo/1.0/direct')) {
      return jsonResponse(geo);
    }
    if (errorStatus) {
      return jsonResponse(errorBody ?? { message: 'Not found' }, errorStatus);
    }
    if (url.includes('/data/4.0/onecall/current')) {
      return jsonResponse(
        current ?? {
          lat: GEO.lat,
          lon: GEO.lon,
          data: [{ temp: 293.15, feels_like: 295.15 }],
        },
      );
    }
    if (url.includes('/timeline/1day')) {
      return jsonResponse(
        daily ?? {
          data: [
            { dt: 1583280000, temp: { day: 293.15, night: 283.15, morn: 283.15, eve: 288.15 } },
          ],
        },
      );
    }
    if (url.includes('/timeline/1h')) {
      return jsonResponse(
        hourly ?? {
          data: [{ dt: 1583280000, temp: 283.15, feels_like: 280.15 }],
        },
      );
    }
    if (url.includes('/timeline/1min')) {
      return jsonResponse(minutely ?? { data: [{ dt: 1, precipitation: 0 }] });
    }
    return Promise.reject(new Error(`Unexpected fetch call: ${url}`));
  });
}

describe('OpenWeather Tool', () => {
  let tool;

  beforeAll(() => {
    tool = new OpenWeather();
  });

  beforeEach(() => {
    fetch.mockReset();
  });

  test('action=help returns help instructions', async () => {
    const result = await tool.call({
      action: 'help',
    });

    expect(typeof result).toBe('string');
    const parsed = JSON.parse(result);
    expect(parsed.title).toBe('OpenWeather One Call API 4.0 Help');
  });

  test('current_forecast with a city and successful geocoding + forecast', async () => {
    mockOpenWeather({
      daily: { data: [{ temp: { day: 293.15, night: 283.15 } }] },
    });

    const result = await tool.call({
      action: 'current_forecast',
      city: 'Knoxville, Tennessee',
      units: 'Kelvin',
    });

    const parsed = JSON.parse(result);
    expect(parsed.current.temp).toBe(293);
    expect(parsed.current.feels_like).toBe(295);
    expect(parsed.daily[0].temp.day).toBe(293);
    expect(parsed.daily[0].temp.night).toBe(283);
    expect(fetch.mock.calls.every(([url]) => !url.includes('/data/3.0/'))).toBe(true);
    expect(fetch.mock.calls.some(([url]) => url.includes('/data/4.0/onecall/current'))).toBe(true);
    expect(fetch.mock.calls.some(([url]) => url.includes('/timeline/1h'))).toBe(true);
    expect(fetch.mock.calls.every(([url]) => !url.includes('/timeline/1min'))).toBe(true);
    expect(fetch.mock.calls.some(([url]) => url.includes('units=standard'))).toBe(true);
  });

  test('timestamp action with valid date returns mocked historical data', async () => {
    mockOpenWeather();

    const result = await tool.call({
      action: 'timestamp',
      city: 'Knoxville, Tennessee',
      date: '2020-03-04',
      units: 'Kelvin',
    });

    const parsed = JSON.parse(result);
    expect(parsed.data[0].temp).toBe(283);
    expect(parsed.data[0].feels_like).toBe(280);
    expect(fetch.mock.calls.some(([url]) => url.includes('/data/4.0/onecall/timeline/1h'))).toBe(
      true,
    );
    expect(fetch.mock.calls.some(([url]) => url.includes('start=1583280000'))).toBe(true);
  });

  test('daily_aggregation action returns aggregated weather data', async () => {
    mockOpenWeather();

    const result = await tool.call({
      action: 'daily_aggregation',
      city: 'Knoxville, Tennessee',
      date: '2020-03-04',
      units: 'Kelvin',
    });

    const parsed = JSON.parse(result);
    expect(parsed.temperature.morning).toBe(283);
    expect(parsed.temperature.afternoon).toBe(293);
    expect(parsed.temperature.evening).toBe(288);
    expect(fetch.mock.calls.some(([url]) => url.includes('/data/4.0/onecall/timeline/1day'))).toBe(
      true,
    );
  });

  test('overview action returns weather summary', async () => {
    mockOpenWeather({
      current: {
        date: '2024-01-07',
        lat: 35.9606,
        lon: -83.9207,
        timezone: 'UTC',
        data: [
          {
            dt: 1704585600,
            temp: 2,
            feels_like: -2,
            weather: [{ description: 'clear sky' }],
          },
        ],
      },
    });

    const result = await tool.call({
      action: 'overview',
      city: 'Knoxville, Tennessee',
      units: 'Celsius',
    });

    const parsed = JSON.parse(result);
    expect(parsed).toHaveProperty('weather_overview');
    expect(typeof parsed.weather_overview).toBe('string');
    expect(parsed.weather_overview.length).toBeGreaterThan(0);
    expect(parsed).toHaveProperty('date');
    expect(parsed).toHaveProperty('units');
    expect(parsed.units).toBe('metric');
    expect(fetch.mock.calls.some(([url]) => url.includes('/data/4.0/onecall/current'))).toBe(true);
  });

  test('temperature units are correctly converted', async () => {
    mockOpenWeather({ current: { data: [{ temp: 293.15 }] } });
    let result = await tool.call({
      action: 'current_forecast',
      city: 'Knoxville, Tennessee',
      units: 'Kelvin',
    });
    expect(JSON.parse(result).current.temp).toBe(293);
    expect(fetch.mock.calls.some(([url]) => url.includes('units=standard'))).toBe(true);

    fetch.mockReset();
    mockOpenWeather({ current: { data: [{ temp: 20 }] } });
    result = await tool.call({
      action: 'current_forecast',
      city: 'Knoxville, Tennessee',
      units: 'Celsius',
    });
    expect(JSON.parse(result).current.temp).toBe(20);
    expect(fetch.mock.calls.some(([url]) => url.includes('units=metric'))).toBe(true);

    fetch.mockReset();
    mockOpenWeather({ current: { data: [{ temp: 68 }] } });
    result = await tool.call({
      action: 'current_forecast',
      city: 'Knoxville, Tennessee',
      units: 'Fahrenheit',
    });
    expect(JSON.parse(result).current.temp).toBe(68);
    expect(fetch.mock.calls.some(([url]) => url.includes('units=imperial'))).toBe(true);
  });

  test('OPENWEATHER_ONECALL_VERSION=3.0 uses the legacy One Call 3.0 path', async () => {
    const previous = process.env.OPENWEATHER_ONECALL_VERSION;
    process.env.OPENWEATHER_ONECALL_VERSION = '3.0';
    fetch.mockImplementation((url) => {
      if (url.includes('geo/1.0/direct')) {
        return jsonResponse([GEO]);
      }
      if (url.includes('/data/3.0/onecall')) {
        return jsonResponse({
          lat: GEO.lat,
          lon: GEO.lon,
          current: { temp: 20.4, feels_like: 18.6 },
        });
      }
      return Promise.reject(new Error(`Unexpected fetch call: ${url}`));
    });

    try {
      const result = await tool.call({
        action: 'current_forecast',
        city: 'Knoxville, Tennessee',
        units: 'Celsius',
      });
      const parsed = JSON.parse(result);
      expect(parsed.current.temp).toBe(20);
      expect(fetch.mock.calls.some(([url]) => url.includes('/data/3.0/onecall'))).toBe(true);
      expect(fetch.mock.calls.every(([url]) => !url.includes('/data/4.0/'))).toBe(true);
    } finally {
      if (previous == null) {
        delete process.env.OPENWEATHER_ONECALL_VERSION;
      } else {
        process.env.OPENWEATHER_ONECALL_VERSION = previous;
      }
    }
  });

  test('timestamp action without a date returns an error message', async () => {
    const result = await tool.call({
      action: 'timestamp',
      lat: 35.9606,
      lon: -83.9207,
    });
    expect(result).toMatch(
      /Error: For timestamp action, a 'date' in YYYY-MM-DD format is required./,
    );
  });

  test('daily_aggregation action without a date returns an error message', async () => {
    const result = await tool.call({
      action: 'daily_aggregation',
      lat: 35.9606,
      lon: -83.9207,
    });
    expect(result).toMatch(/Error: date \(YYYY-MM-DD\) is required for daily_aggregation action./);
  });

  test('unknown action returns an error due to schema validation', async () => {
    await expect(
      tool.call({
        action: 'unknown_action',
      }),
    ).rejects.toThrow(/Received tool input did not match expected schema/);
  });

  test('geocoding failure returns a descriptive error', async () => {
    mockOpenWeather({ geo: [] });

    const result = await tool.call({
      action: 'current_forecast',
      city: 'NowhereCity',
    });
    expect(result).toMatch(/Error: Could not find coordinates for city: NowhereCity/);
  });

  test('API request failure returns an error', async () => {
    mockOpenWeather({ errorStatus: 404, errorBody: { message: 'Not found' } });

    const result = await tool.call({
      action: 'current_forecast',
      city: 'Knoxville, Tennessee',
    });
    expect(result).toMatch(/Error: OpenWeather API request failed with status 404: Not found/);
  });

  test('invalid date format returns an error', async () => {
    mockOpenWeather();

    const result = await tool.call({
      action: 'timestamp',
      city: 'Knoxville, Tennessee',
      date: '03-04-2020',
    });
    expect(result).toMatch(/Error: Invalid date format. Expected YYYY-MM-DD./);
  });
});

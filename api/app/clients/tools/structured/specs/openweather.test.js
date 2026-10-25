// __tests__/openweather.test.js
const OpenWeather = require('../OpenWeather');
const fetch = require('node-fetch');

// Mock environment variable
process.env.OPENWEATHER_API_KEY = 'test-api-key';

// Mock the fetch function globally
jest.mock('node-fetch', () => jest.fn());

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
    expect(parsed.title).toBe('OpenWeather One Call API 3.0 Help');
  });

  test('current_forecast with a city and successful geocoding + forecast', async () => {
    // Mock geocoding response
    fetch.mockImplementationOnce((url) => {
      if (url.includes('geo/1.0/direct')) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ lat: 35.9606, lon: -83.9207 }],
        });
      }
      return Promise.reject('Unexpected fetch call for geocoding');
    });

    // Mock forecast response
    fetch.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({
          current: { temp: 293.15, feels_like: 295.15 },
          daily: [{ temp: { day: 293.15, night: 283.15 } }],
        }),
      }),
    );

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
  });

  test('timestamp action with valid date returns mocked historical data', async () => {
    // Mock geocoding response
    fetch.mockImplementationOnce((url) => {
      if (url.includes('geo/1.0/direct')) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ lat: 35.9606, lon: -83.9207 }],
        });
      }
      return Promise.reject('Unexpected fetch call for geocoding');
    });

    // Mock historical weather response
    fetch.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({
          data: [
            {
              dt: 1583280000,
              temp: 283.15,
              feels_like: 280.15,
              humidity: 75,
              weather: [{ description: 'clear sky' }],
            },
          ],
        }),
      }),
    );

    const result = await tool.call({
      action: 'timestamp',
      city: 'Knoxville, Tennessee',
      date: '2020-03-04',
      units: 'Kelvin',
    });

    const parsed = JSON.parse(result);
    expect(parsed.data[0].temp).toBe(283);
    expect(parsed.data[0].feels_like).toBe(280);
  });

  test('daily_aggregation action returns aggregated weather data', async () => {
    // Mock geocoding response
    fetch.mockImplementationOnce((url) => {
      if (url.includes('geo/1.0/direct')) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ lat: 35.9606, lon: -83.9207 }],
        });
      }
      return Promise.reject('Unexpected fetch call for geocoding');
    });

    // Mock daily aggregation response
    fetch.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({
          date: '2020-03-04',
          temperature: {
            morning: 283.15,
            afternoon: 293.15,
            evening: 288.15,
          },
          humidity: {
            morning: 75,
            afternoon: 60,
            evening: 70,
          },
        }),
      }),
    );

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
  });

  test('overview action returns weather summary', async () => {
    // Mock geocoding response
    fetch.mockImplementationOnce((url) => {
      if (url.includes('geo/1.0/direct')) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ lat: 35.9606, lon: -83.9207 }],
        });
      }
      return Promise.reject('Unexpected fetch call for geocoding');
    });

    // Mock overview response
    fetch.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({
          date: '2024-01-07',
          lat: 35.9606,
          lon: -83.9207,
          tz: '+00:00',
          units: 'metric',
          weather_overview:
            'Currently, the temperature is 2°C with a real feel of -2°C. The sky is clear with moderate wind.',
        }),
      }),
    );

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
  });

  test('temperature units are correctly converted', async () => {
    // Mock geocoding response for all three calls
    const geocodingMock = Promise.resolve({
      ok: true,
      json: async () => [{ lat: 35.9606, lon: -83.9207 }],
    });

    // Mock weather response for Kelvin
    const kelvinMock = Promise.resolve({
      ok: true,
      json: async () => ({
        current: { temp: 293.15 },
      }),
    });

    // Mock weather response for Celsius
    const celsiusMock = Promise.resolve({
      ok: true,
      json: async () => ({
        current: { temp: 20 },
      }),
    });

    // Mock weather response for Fahrenheit
    const fahrenheitMock = Promise.resolve({
      ok: true,
      json: async () => ({
        current: { temp: 68 },
      }),
    });

    // Test Kelvin
    fetch.mockImplementationOnce(() => geocodingMock).mockImplementationOnce(() => kelvinMock);

    let result = await tool.call({
      action: 'current_forecast',
      city: 'Knoxville, Tennessee',
      units: 'Kelvin',
    });
    let parsed = JSON.parse(result);
    expect(parsed.current.temp).toBe(293);

    // Test Celsius
    fetch.mockImplementationOnce(() => geocodingMock).mockImplementationOnce(() => celsiusMock);

    result = await tool.call({
      action: 'current_forecast',
      city: 'Knoxville, Tennessee',
      units: 'Celsius',
    });
    parsed = JSON.parse(result);
    expect(parsed.current.temp).toBe(20);

    // Test Fahrenheit
    fetch.mockImplementationOnce(() => geocodingMock).mockImplementationOnce(() => fahrenheitMock);

    result = await tool.call({
      action: 'current_forecast',
      city: 'Knoxville, Tennessee',
      units: 'Fahrenheit',
    });
    parsed = JSON.parse(result);
    expect(parsed.current.temp).toBe(68);
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
    fetch.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        json: async () => [],
      }),
    );

    const result = await tool.call({
      action: 'current_forecast',
      city: 'NowhereCity',
    });
    expect(result).toMatch(/Error: Could not find coordinates for city: NowhereCity/);
  });

  test('API request failure returns an error', async () => {
    // Mock geocoding success
    fetch.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        json: async () => [{ lat: 35.9606, lon: -83.9207 }],
      }),
    );

    // Mock weather request failure
    fetch.mockImplementationOnce(() =>
      Promise.resolve({
        ok: false,
        status: 404,
        json: async () => ({ message: 'Not found' }),
      }),
    );

    const result = await tool.call({
      action: 'current_forecast',
      city: 'Knoxville, Tennessee',
    });
    expect(result).toMatch(/Error: OpenWeather API request failed with status 404: Not found/);
  });

  test('invalid date format returns an error', async () => {
    // Mock geocoding response first
    fetch.mockImplementationOnce((url) => {
      if (url.includes('geo/1.0/direct')) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ lat: 35.9606, lon: -83.9207 }],
        });
      }
      return Promise.reject('Unexpected fetch call for geocoding');
    });

    // Mock timestamp API response
    fetch.mockImplementationOnce((url) => {
      if (url.includes('onecall/timemachine')) {
        throw new Error('Invalid date format. Expected YYYY-MM-DD.');
      }
      return Promise.reject('Unexpected fetch call');
    });

    const result = await tool.call({
      action: 'timestamp',
      city: 'Knoxville, Tennessee',
      date: '03-04-2020', // Wrong format
    });
    expect(result).toMatch(/Error: Invalid date format. Expected YYYY-MM-DD./);
  });

  test('a failed request does not echo the API key to the model', async () => {
    fetch.mockImplementationOnce((url) =>
      Promise.reject(new Error(`request to ${url} failed, reason: getaddrinfo ENOTFOUND`)),
    );

    const result = await tool.call({ action: 'current_forecast', lat: 35.96, lon: -83.92 });

    expect(result).toMatch(/^Error: request to .*appid=\[REDACTED\]/);
    expect(result).not.toContain('test-api-key');
  });
});

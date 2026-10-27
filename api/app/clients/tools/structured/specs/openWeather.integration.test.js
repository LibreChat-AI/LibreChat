// __tests__/openWeather.integration.test.js
const OpenWeather = require('../OpenWeather');

describe('OpenWeather Tool (Integration Test)', () => {
  let tool;

  beforeAll(() => {
    tool = new OpenWeather({ override: true });
    console.log('API Key present:', !!process.env.OPENWEATHER_API_KEY);
  });

  test('current_forecast with a real API key returns current weather', async () => {
    // Check if API key is available
    if (!process.env.OPENWEATHER_API_KEY) {
      console.warn('Skipping real API test, no OPENWEATHER_API_KEY found.');
      return;
    }

    try {
      const result = await tool.call({
        action: 'current_forecast',
        city: 'London',
        units: 'Celsius',
      });

      console.log('Raw API response:', result);

      const parsed = JSON.parse(result);
      expect(parsed).toHaveProperty('current');
      expect(typeof parsed.current.temp).toBe('number');
    } catch (error) {
      console.error('Test failed with error:', error);
      throw error;
    }
  });

  test('timestamp action with real API key returns historical data', async () => {
    if (!process.env.OPENWEATHER_API_KEY) {
      console.warn('Skipping real API test, no OPENWEATHER_API_KEY found.');
      return;
    }

    try {
      // Use a date from yesterday to ensure data availability
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const dateStr = yesterday.toISOString().split('T')[0];

      const result = await tool.call({
        action: 'timestamp',
        city: 'London',
        date: dateStr,
        units: 'Celsius',
      });

      console.log('Timestamp API response:', result);

      const parsed = JSON.parse(result);
      expect(parsed).toHaveProperty('data');
      expect(Array.isArray(parsed.data)).toBe(true);
      expect(parsed.data[0]).toHaveProperty('temp');
    } catch (error) {
      console.error('Timestamp test failed with error:', error);
      throw error;
    }
  });

  test('daily_aggregation action with real API key returns aggregated data', async () => {
    if (!process.env.OPENWEATHER_API_KEY) {
      console.warn('Skipping real API test, no OPENWEATHER_API_KEY found.');
      return;
    }

    try {
      // Use yesterday's date for aggregation
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const dateStr = yesterday.toISOString().split('T')[0];

      const result = await tool.call({
        action: 'daily_aggregation',
        city: 'London',
        date: dateStr,
        units: 'Celsius',
      });

      console.log('Daily aggregation API response:', result);

      const parsed = JSON.parse(result);
      expect(parsed).toHaveProperty('temperature');
      expect(parsed.temperature).toHaveProperty('morning');
      expect(parsed.temperature).toHaveProperty('afternoon');
      expect(parsed.temperature).toHaveProperty('evening');
    } catch (error) {
      console.error('Daily aggregation test failed with error:', error);
      throw error;
    }
  });

  test('overview action with real API key returns weather summary', async () => {
    if (!process.env.OPENWEATHER_API_KEY) {
      console.warn('Skipping real API test, no OPENWEATHER_API_KEY found.');
      return;
    }

    try {
      const result = await tool.call({
        action: 'overview',
        city: 'London',
        units: 'Celsius',
      });

      console.log('Overview API response:', result);

      const parsed = JSON.parse(result);
      // One Call 4.0 has no /overview endpoint; this sentence is synthesized from
      // current (or daily) conditions rather than OpenWeather's generated summary.
      expect(parsed).toHaveProperty('weather_overview');
      expect(typeof parsed.weather_overview).toBe('string');
      expect(parsed.weather_overview.length).toBeGreaterThan(0);
      expect(parsed).toHaveProperty('date');
      expect(parsed).toHaveProperty('units');
      expect(parsed.units).toBe('metric');
    } catch (error) {
      console.error('Overview test failed with error:', error);
      throw error;
    }
  });

  test('different temperature units return correct values', async () => {
    if (!process.env.OPENWEATHER_API_KEY) {
      console.warn('Skipping real API test, no OPENWEATHER_API_KEY found.');
      return;
    }

    try {
      // Test Celsius
      let result = await tool.call({
        action: 'current_forecast',
        city: 'London',
        units: 'Celsius',
      });
      let parsed = JSON.parse(result);
      const celsiusTemp = parsed.current.temp;

      // Test Kelvin
      result = await tool.call({
        action: 'current_forecast',
        city: 'London',
        units: 'Kelvin',
      });
      parsed = JSON.parse(result);
      const kelvinTemp = parsed.current.temp;

      // Test Fahrenheit
      result = await tool.call({
        action: 'current_forecast',
        city: 'London',
        units: 'Fahrenheit',
      });
      parsed = JSON.parse(result);
      const fahrenheitTemp = parsed.current.temp;

      // Verify temperature conversions are roughly correct
      // K = C + 273.15
      // F = (C * 9/5) + 32
      const celsiusToKelvin = Math.round(celsiusTemp + 273.15);
      const celsiusToFahrenheit = Math.round((celsiusTemp * 9) / 5 + 32);

      console.log('Temperature comparisons:', {
        celsius: celsiusTemp,
        kelvin: kelvinTemp,
        fahrenheit: fahrenheitTemp,
        calculatedKelvin: celsiusToKelvin,
        calculatedFahrenheit: celsiusToFahrenheit,
      });

      // Allow for some rounding differences
      expect(Math.abs(kelvinTemp - celsiusToKelvin)).toBeLessThanOrEqual(1);
      expect(Math.abs(fahrenheitTemp - celsiusToFahrenheit)).toBeLessThanOrEqual(1);
    } catch (error) {
      console.error('Temperature units test failed with error:', error);
      throw error;
    }
  });

  test('language parameter returns localized data', async () => {
    if (!process.env.OPENWEATHER_API_KEY) {
      console.warn('Skipping real API test, no OPENWEATHER_API_KEY found.');
      return;
    }

    try {
      // Test with English
      let result = await tool.call({
        action: 'current_forecast',
        city: 'Paris',
        units: 'Celsius',
        lang: 'en',
      });
      let parsed = JSON.parse(result);
      const englishDescription = parsed.current.weather[0].description;

      // Test with French
      result = await tool.call({
        action: 'current_forecast',
        city: 'Paris',
        units: 'Celsius',
        lang: 'fr',
      });
      parsed = JSON.parse(result);
      const frenchDescription = parsed.current.weather[0].description;

      console.log('Language comparison:', {
        english: englishDescription,
        french: frenchDescription,
      });

      // Verify descriptions are different (indicating translation worked)
      expect(englishDescription).not.toBe(frenchDescription);
    } catch (error) {
      console.error('Language test failed with error:', error);
      throw error;
    }
  });
});

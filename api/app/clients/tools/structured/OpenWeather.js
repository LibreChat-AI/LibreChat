const fetch = require('node-fetch');
const { formatToolError } = require('@librechat/api');
const { Tool } = require('@librechat/agents/langchain/tools');
const { getEnvironmentVariable } = require('@librechat/agents/langchain/utils/env');

const openWeatherJsonSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['help', 'current_forecast', 'timestamp', 'daily_aggregation', 'overview'],
      description: 'The action to perform',
    },
    city: {
      type: 'string',
      description: 'City name for geocoding if lat/lon not provided',
    },
    lat: {
      type: 'number',
      description: 'Latitude coordinate',
    },
    lon: {
      type: 'number',
      description: 'Longitude coordinate',
    },
    exclude: {
      type: 'string',
      description: 'Parts to exclude from the response',
    },
    units: {
      type: 'string',
      enum: ['Celsius', 'Kelvin', 'Fahrenheit'],
      description: 'Temperature units',
    },
    lang: {
      type: 'string',
      description: 'Language code',
    },
    date: {
      type: 'string',
      description: 'Date in YYYY-MM-DD format for timestamp and daily_aggregation',
    },
    tz: {
      type: 'string',
      description: 'Timezone',
    },
  },
  required: ['action'],
};

/**
 * Map user-friendly units to OpenWeather units.
 * Defaults to Celsius if not specified.
 */
function mapUnitsToOpenWeather(unit) {
  if (!unit) {
    return 'metric';
  } // Default to Celsius
  switch (unit) {
    case 'Celsius':
      return 'metric';
    case 'Kelvin':
      return 'standard';
    case 'Fahrenheit':
      return 'imperial';
    default:
      return 'metric'; // fallback
  }
}

/**
 * Recursively round temperature fields in the API response.
 */
function roundTemperatures(obj) {
  const tempKeys = new Set([
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

  if (Array.isArray(obj)) {
    return obj.map((item) => roundTemperatures(item));
  } else if (obj && typeof obj === 'object') {
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (value && typeof value === 'object') {
        obj[key] = roundTemperatures(value);
      } else if (typeof value === 'number' && tempKeys.has(key)) {
        obj[key] = Math.round(value);
      }
    }
  }
  return obj;
}

class OpenWeather extends Tool {
  name = 'open_weather';
  description =
    'Provides weather data from OpenWeather One Call API 3.0. ' +
    'Actions: help, current_forecast, timestamp, daily_aggregation, overview. ' +
    'If lat/lon not provided, specify "city" for geocoding. ' +
    'Units: "Celsius", "Kelvin", or "Fahrenheit" (default: Celsius). ' +
    'For timestamp action, use "date" in YYYY-MM-DD format.';

  schema = openWeatherJsonSchema;

  static get jsonSchema() {
    return openWeatherJsonSchema;
  }

  constructor(fields = {}) {
    super();
    this.envVar = 'OPENWEATHER_API_KEY';
    this.override = fields.override ?? false;
    this.apiKey = fields[this.envVar] ?? this.getApiKey();
  }

  getApiKey() {
    const key = getEnvironmentVariable(this.envVar);
    if (!key && !this.override) {
      throw new Error(`Missing ${this.envVar} environment variable.`);
    }
    return key;
  }

  async geocodeCity(city) {
    const geocodeUrl = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(
      city,
    )}&limit=1&appid=${this.apiKey}`;
    const res = await fetch(geocodeUrl);
    const data = await res.json();
    if (!res.ok || !Array.isArray(data) || data.length === 0) {
      throw new Error(`Could not find coordinates for city: ${city}`);
    }
    return { lat: data[0].lat, lon: data[0].lon };
  }

  convertDateToUnix(dateStr) {
    const parts = dateStr.split('-');
    if (parts.length !== 3) {
      throw new Error('Invalid date format. Expected YYYY-MM-DD.');
    }
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    const day = parseInt(parts[2], 10);
    if (isNaN(year) || isNaN(month) || isNaN(day)) {
      throw new Error('Invalid date format. Expected YYYY-MM-DD with valid numbers.');
    }

    const dateObj = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
    if (isNaN(dateObj.getTime())) {
      throw new Error('Invalid date provided. Cannot parse into a valid date.');
    }

    return Math.floor(dateObj.getTime() / 1000);
  }

  async _call(args) {
    try {
      const { action, city, lat, lon, exclude, units, lang, date, tz } = args;
      const owmUnits = mapUnitsToOpenWeather(units);

      if (action === 'help') {
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
                optional_params: ['units (Celsius/Kelvin/Fahrenheit)', 'lang'],
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

      let finalLat = lat;
      let finalLon = lon;

      // If lat/lon not provided but city is given, geocode it
      if ((finalLat == null || finalLon == null) && city) {
        const coords = await this.geocodeCity(city);
        finalLat = coords.lat;
        finalLon = coords.lon;
      }

      if (['current_forecast', 'timestamp', 'daily_aggregation', 'overview'].includes(action)) {
        if (typeof finalLat !== 'number' || typeof finalLon !== 'number') {
          return "Error: lat and lon are required and must be numbers for this action (or specify 'city').";
        }
      }

      const baseUrl = 'https://api.openweathermap.org/data/3.0';
      let endpoint = '';
      const params = new URLSearchParams({ appid: this.apiKey, units: owmUnits });

      let dt;
      if (action === 'timestamp') {
        if (!date) {
          return "Error: For timestamp action, a 'date' in YYYY-MM-DD format is required.";
        }
        dt = this.convertDateToUnix(date);
      }

      if (action === 'daily_aggregation' && !date) {
        return 'Error: date (YYYY-MM-DD) is required for daily_aggregation action.';
      }

      switch (action) {
        case 'current_forecast':
          endpoint = '/onecall';
          params.append('lat', String(finalLat));
          params.append('lon', String(finalLon));
          if (exclude) {
            params.append('exclude', exclude);
          }
          if (lang) {
            params.append('lang', lang);
          }
          break;
        case 'timestamp':
          endpoint = '/onecall/timemachine';
          params.append('lat', String(finalLat));
          params.append('lon', String(finalLon));
          params.append('dt', String(dt));
          if (lang) {
            params.append('lang', lang);
          }
          break;
        case 'daily_aggregation':
          endpoint = '/onecall/day_summary';
          params.append('lat', String(finalLat));
          params.append('lon', String(finalLon));
          params.append('date', date);
          if (lang) {
            params.append('lang', lang);
          }
          if (tz) {
            params.append('tz', tz);
          }
          break;
        case 'overview':
          endpoint = '/onecall/overview';
          params.append('lat', String(finalLat));
          params.append('lon', String(finalLon));
          if (date) {
            params.append('date', date);
          }
          break;
        default:
          return `Error: Unknown action: ${action}`;
      }

      const url = `${baseUrl}${endpoint}?${params.toString()}`;
      const response = await fetch(url);
      const json = await response.json();
      if (!response.ok) {
        return `Error: OpenWeather API request failed with status ${response.status}: ${
          json.message || JSON.stringify(json)
        }`;
      }

      const roundedJson = roundTemperatures(json);
      return JSON.stringify(roundedJson);
    } catch (err) {
      return formatToolError(err);
    }
  }
}

module.exports = OpenWeather;

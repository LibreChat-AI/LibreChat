const fetch = require('node-fetch');
const { Tool } = require('@librechat/agents/langchain/tools');
const { getEnvironmentVariable } = require('@librechat/agents/langchain/utils/env');
const {
  executeOpenWeather,
  openWeatherSchema,
  OPEN_WEATHER_TOOL_DESCRIPTION,
  resolveOpenWeatherOneCallVersion,
} = require('@librechat/api');

class OpenWeather extends Tool {
  name = 'open_weather';
  description = OPEN_WEATHER_TOOL_DESCRIPTION;
  schema = openWeatherSchema;

  static get jsonSchema() {
    return openWeatherSchema;
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

  async _call(args) {
    try {
      return await executeOpenWeather(args, {
        apiKey: this.apiKey,
        fetch,
        oneCallVersion: resolveOpenWeatherOneCallVersion(
          getEnvironmentVariable('OPENWEATHER_ONECALL_VERSION'),
        ),
      });
    } catch (err) {
      return `Error: ${err.message}`;
    }
  }
}

module.exports = OpenWeather;

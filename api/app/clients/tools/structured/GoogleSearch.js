const { toolRequestBudget } = require('@librechat/api');
const { Tool } = require('@librechat/agents/langchain/tools');
const { getEnvironmentVariable } = require('@librechat/agents/langchain/utils/env');

const googleSearchJsonSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      minLength: 1,
      description: 'The search query string.',
    },
    max_results: {
      type: 'integer',
      minimum: 1,
      maximum: 10,
      description: 'The maximum number of search results to return. Defaults to 5.',
    },
  },
  required: ['query'],
};

class GoogleSearchResults extends Tool {
  static lc_name() {
    return 'google';
  }

  static get jsonSchema() {
    return googleSearchJsonSchema;
  }

  constructor(fields = {}) {
    super(fields);
    this.name = 'google';
    this.envVarApiKey = 'GOOGLE_SEARCH_API_KEY';
    this.envVarSearchEngineId = 'GOOGLE_CSE_ID';
    this.override = fields.override ?? false;
    this.timeouts = fields.timeouts;
    this.apiKey = fields[this.envVarApiKey] ?? getEnvironmentVariable(this.envVarApiKey);
    this.searchEngineId =
      fields[this.envVarSearchEngineId] ?? getEnvironmentVariable(this.envVarSearchEngineId);

    if (!this.override && (!this.apiKey || !this.searchEngineId)) {
      throw new Error(
        `Missing ${this.envVarApiKey} or ${this.envVarSearchEngineId} environment variable.`,
      );
    }

    this.kwargs = fields?.kwargs ?? {};
    this.name = 'google';
    this.description =
      'A search engine optimized for comprehensive, accurate, and trusted results. Useful for when you need to answer questions about current events.';

    this.schema = googleSearchJsonSchema;
  }

  async _call(input) {
    const { query, max_results = 5 } = input;

    const response = await fetch(
      `https://www.googleapis.com/customsearch/v1?key=${this.apiKey}&cx=${
        this.searchEngineId
      }&q=${encodeURIComponent(query)}&num=${max_results}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: toolRequestBudget(this.timeouts).signal,
      },
    );

    const json = await response.json();
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}: ${json.error.message}`);
    }

    return JSON.stringify(json);
  }
}

module.exports = GoogleSearchResults;

const { fetch } = require('undici');
const { Tool } = require('@librechat/agents/langchain/tools');
const { getEnvironmentVariable } = require('@librechat/agents/langchain/utils/env');
const { getEnvProxyDispatcher } = require('@librechat/api');

const tavilySearchJsonSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      minLength: 1,
      description: 'The search query string.',
    },
    max_results: {
      type: 'number',
      minimum: 1,
      maximum: 10,
      description: 'The maximum number of search results to return. Defaults to 5.',
    },
    search_depth: {
      type: 'string',
      enum: ['basic', 'advanced'],
      description:
        'The depth of the search, affecting result quality and response time (`basic` or `advanced`). Default is basic for quick results and advanced for indepth high quality results but longer response time. Advanced calls equals 2 requests.',
    },
    include_images: {
      type: 'boolean',
      description:
        'Whether to include a list of query-related images in the response. Default is False.',
    },
    include_answer: {
      type: 'boolean',
      description: 'Whether to include answers in the search results. Default is False.',
    },
    include_raw_content: {
      type: 'boolean',
      description: 'Whether to include raw content in the search results. Default is False.',
    },
    include_domains: {
      type: 'array',
      items: { type: 'string' },
      description: 'A list of domains to specifically include in the search results.',
    },
    exclude_domains: {
      type: 'array',
      items: { type: 'string' },
      description: 'A list of domains to specifically exclude from the search results.',
    },
    topic: {
      type: 'string',
      enum: ['general', 'news', 'finance'],
      description:
        'The category of the search. Use news ONLY if query SPECIFCALLY mentions the word "news".',
    },
    time_range: {
      type: 'string',
      enum: ['day', 'week', 'month', 'year', 'd', 'w', 'm', 'y'],
      description: 'The time range back from the current date to filter results.',
    },
    days: {
      type: 'number',
      minimum: 1,
      description: 'Number of days back from the current date to include. Only if topic is news.',
    },
    include_image_descriptions: {
      type: 'boolean',
      description:
        'When include_images is true, also add a descriptive text for each image. Default is false.',
    },
  },
  required: ['query'],
};

class TavilySearchResults extends Tool {
  static lc_name() {
    return 'TavilySearchResults';
  }

  constructor(fields = {}) {
    super(fields);
    this.envVar = 'TAVILY_API_KEY';
    /* Used to initialize the Tool without necessary variables. */
    this.override = fields.override ?? false;
    this.apiKey = fields[this.envVar] ?? this.getApiKey();

    this.kwargs = fields?.kwargs ?? {};
    this.name = 'tavily_search_results_json';
    this.description =
      'A search engine optimized for comprehensive, accurate, and trusted results. Useful for when you need to answer questions about current events.';

    this.schema = tavilySearchJsonSchema;
  }

  static get jsonSchema() {
    return tavilySearchJsonSchema;
  }

  getApiKey() {
    const apiKey = getEnvironmentVariable(this.envVar);
    if (!apiKey && !this.override) {
      throw new Error(`Missing ${this.envVar} environment variable.`);
    }
    return apiKey;
  }

  async _call(input) {
    const { query, ...rest } = input;

    const requestBody = {
      api_key: this.apiKey,
      query,
      ...rest,
      ...this.kwargs,
    };

    const fetchOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Name': 'librechat',
      },
      body: JSON.stringify(requestBody),
    };

    const dispatcher = getEnvProxyDispatcher();
    if (dispatcher) {
      fetchOptions.dispatcher = dispatcher;
    }

    const response = await fetch('https://api.tavily.com/search', fetchOptions);

    const json = await response.json();
    if (!response.ok) {
      throw new Error(
        `Request failed with status ${response.status}: ${json?.detail?.error || json?.error}`,
      );
    }

    return JSON.stringify(json);
  }
}

module.exports = TavilySearchResults;

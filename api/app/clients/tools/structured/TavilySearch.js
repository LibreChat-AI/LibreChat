const { z } = require('zod');
const { fetch } = require('undici');
const { tool } = require('@librechat/agents/langchain/tools');
const { getEnvProxyDispatcher } = require('@librechat/api');
const { getApiKey } = require('./credentials');

function createTavilySearchTool(fields = {}) {
  const envVar = 'TAVILY_API_KEY';
  const override = fields.override ?? false;
  const apiKey = fields.apiKey ?? getApiKey(envVar, override);
  const kwargs = fields?.kwargs ?? {};

  return tool(
    async (input) => {
      const { query, ...rest } = input;

      const requestBody = {
        api_key: apiKey,
        query,
        ...rest,
        ...kwargs,
      };

      const fetchOptions = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
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
        throw new Error(`Request failed with status ${response.status}: ${json.error}`);
      }

      return JSON.stringify(json);
    },
    {
      name: 'tavily_search_results_json',
      description:
        'A search engine optimized for comprehensive, accurate, and trusted results. Useful for when you need to answer questions about current events.',
      schema: z.object({
        query: z.string().min(1).describe('The search query string.'),
        max_results: z
          .number()
          .min(1)
          .max(10)
          .optional()
          .describe('The maximum number of search results to return. Defaults to 5.'),
        search_depth: z
          .enum(['basic', 'advanced'])
          .optional()
          .describe(
            'The depth of the search, affecting result quality and response time (`basic` or `advanced`). Default is basic for quick results and advanced for indepth high quality results but longer response time. Advanced calls equals 2 requests.',
          ),
        include_images: z
          .boolean()
          .optional()
          .describe(
            'Whether to include a list of query-related images in the response. Default is False.',
          ),
        include_answer: z
          .boolean()
          .optional()
          .describe('Whether to include answers in the search results. Default is False.'),
      }),
    },
  );
}

module.exports = createTavilySearchTool;

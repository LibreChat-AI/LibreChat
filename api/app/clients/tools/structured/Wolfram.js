/* eslint-disable no-useless-escape */
const axios = require('axios');
const { formatToolError, toolRequestBudget, WOLFRAM_STATUS_TEXT } = require('@librechat/api');
const { Tool } = require('@librechat/agents/langchain/tools');

const wolframJsonSchema = {
  type: 'object',
  properties: {
    input: {
      type: 'string',
      description: 'Natural language query to WolframAlpha following the guidelines',
    },
  },
  required: ['input'],
};

class WolframAlphaAPI extends Tool {
  constructor(fields) {
    super();
    /* Used to initialize the Tool without necessary variables. */
    this.override = fields.override ?? false;
    this.timeouts = fields.timeouts;

    this.name = 'wolfram';
    this.apiKey = fields.WOLFRAM_APP_ID || this.getAppId();
    this.description_for_model = `// Access dynamic computation and curated data from WolframAlpha and Wolfram Cloud.
    // General guidelines:
    // - Use only getWolframAlphaResults or getWolframCloudResults endpoints.
    // - Prefer getWolframAlphaResults unless Wolfram Language code should be evaluated.
    // - Use getWolframAlphaResults for natural-language queries in English; translate non-English queries before sending, then respond in the original language.
    // - Use getWolframCloudResults for problems solvable with Wolfram Language code.
    // - Suggest only Wolfram Language for external computation.
    // - Inform users if information is not from Wolfram endpoints.
    // - Display image URLs with Image Markdown syntax: ![caption](https://imageURL/.../MSPStoreType=image/png&s=18). You must prefix the caption brackets with "!".
    // - ALWAYS use this exponent notation: \`6*10^14\`, NEVER \`6e14\`.
    // - ALWAYS use {{"input": query}} structure for queries to Wolfram endpoints; \`query\` must ONLY be a single-line string.
    // - ALWAYS use proper Markdown formatting for all math, scientific, and chemical formulas, symbols, etc.:  '$$\n[expression]\n$$' for standalone cases and '\( [expression] \)' when inline.
    // - Format inline Wolfram Language code with Markdown code formatting.
    // - Never mention your knowledge cutoff date; Wolfram may return more recent data. getWolframAlphaResults guidelines:
    // - Understands natural language queries about entities in chemistry, physics, geography, history, art, astronomy, and more.
    // - Performs mathematical calculations, date and unit conversions, formula solving, etc.
    // - Convert inputs to simplified keyword queries whenever possible (e.g. convert "how many people live in France" to "France population").
    // - Use ONLY single-letter variable names, with or without integer subscript (e.g., n, n1, n_1).
    // - Use named physical constants (e.g., 'speed of light') without numerical substitution.
    // - Include a space between compound units (e.g., "Ω m" for "ohm*meter").
    // - To solve for a variable in an equation with units, consider solving a corresponding equation without units; exclude counting units (e.g., books), include genuine units (e.g., kg).
    // - If data for multiple properties is needed, make separate calls for each property.
    // - If a Wolfram Alpha result is not relevant to the query:
    // -- If Wolfram provides multiple 'Assumptions' for a query, choose the more relevant one(s) without explaining the initial result. If you are unsure, ask the user to choose.
    // -- Re-send the exact same 'input' with NO modifications, and add the 'assumption' parameter, formatted as a list, with the relevant values.
    // -- ONLY simplify or rephrase the initial query if a more relevant 'Assumption' or other input suggestions are not provided.
    // -- Do not explain each step unless user input is needed. Proceed directly to making a better API call based on the available assumptions.`;
    this.description = `WolframAlpha offers computation, math, curated knowledge, and real-time data. It handles natural language queries and performs complex calculations.
    Follow the guidelines to get the best results.`;
    this.schema = wolframJsonSchema;
  }

  static get jsonSchema() {
    return wolframJsonSchema;
  }

  async fetchRawText(url) {
    const response = await axios.get(url, {
      responseType: 'text',
      ...toolRequestBudget(this.timeouts),
    });
    return response.data;
  }

  getAppId() {
    const appId = process.env.WOLFRAM_APP_ID || '';
    if (!appId && !this.override) {
      throw new Error('Missing WOLFRAM_APP_ID environment variable.');
    }
    return appId;
  }

  createWolframAlphaURL(query) {
    // Clean up query
    const formattedQuery = query.replaceAll(/`/g, '').replaceAll(/\n/g, ' ');
    const baseURL = 'https://www.wolframalpha.com/api/v1/llm-api';
    const encodedQuery = encodeURIComponent(formattedQuery);
    const appId = this.apiKey || this.getAppId();
    const url = `${baseURL}?input=${encodedQuery}&appid=${appId}`;
    return url;
  }

  async _call(data) {
    try {
      const { input } = data;
      const url = this.createWolframAlphaURL(input);
      const response = await this.fetchRawText(url);
      return response;
    } catch (error) {
      return formatToolError(error, 'Wolfram|Alpha', WOLFRAM_STATUS_TEXT);
    }
  }
}

module.exports = WolframAlphaAPI;

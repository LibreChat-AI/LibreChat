const { logger } = require('@librechat/data-schemas');
const { Tool } = require('@librechat/agents/langchain/tools');
const { SearchClient, AzureKeyCredential } = require('@azure/search-documents');

const azureSearchHostSuffixes = ['.search.windows.net', '.search.azure.us', '.search.azure.cn'];

const isAzureSearchEndpoint = (endpoint) => {
  try {
    const parsed = new URL(endpoint);
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    return (
      parsed.protocol === 'https:' &&
      azureSearchHostSuffixes.some((suffix) => hostname.endsWith(suffix))
    );
  } catch {
    return false;
  }
};

const azureAISearchJsonSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Search word or phrase to Azure AI Search',
    },
  },
  required: ['query'],
};

class AzureAISearch extends Tool {
  // Constants for default values
  static DEFAULT_API_VERSION = '2023-11-01';
  static DEFAULT_QUERY_TYPE = 'simple';
  static DEFAULT_TOP = 5;

  static get jsonSchema() {
    return azureAISearchJsonSchema;
  }

  // Helper function for initializing properties
  _initializeField(field, envVar, defaultValue) {
    return field || process.env[envVar] || defaultValue;
  }

  constructor(fields = {}) {
    super();
    this.name = 'azure-ai-search';
    this.description =
      "Use the 'azure-ai-search' tool to retrieve search results relevant to your input";
    /* Used to initialize the Tool without necessary variables. */
    this.override = fields.override ?? false;

    this.schema = azureAISearchJsonSchema;

    // Initialize properties using helper function
    this.serviceEndpoint = this._initializeField(
      fields.AZURE_AI_SEARCH_SERVICE_ENDPOINT,
      'AZURE_AI_SEARCH_SERVICE_ENDPOINT',
    );
    this.isUserProvidedEndpoint =
      fields.userProvidedAuthFields?.has('AZURE_AI_SEARCH_SERVICE_ENDPOINT') === true;
    this.indexName = this._initializeField(
      fields.AZURE_AI_SEARCH_INDEX_NAME,
      'AZURE_AI_SEARCH_INDEX_NAME',
    );
    this.apiKey = this._initializeField(fields.AZURE_AI_SEARCH_API_KEY, 'AZURE_AI_SEARCH_API_KEY');
    this.apiVersion = this._initializeField(
      fields.AZURE_AI_SEARCH_API_VERSION,
      'AZURE_AI_SEARCH_API_VERSION',
      AzureAISearch.DEFAULT_API_VERSION,
    );
    this.queryType = this._initializeField(
      fields.AZURE_AI_SEARCH_SEARCH_OPTION_QUERY_TYPE,
      'AZURE_AI_SEARCH_SEARCH_OPTION_QUERY_TYPE',
      AzureAISearch.DEFAULT_QUERY_TYPE,
    );
    this.top = this._initializeField(
      fields.AZURE_AI_SEARCH_SEARCH_OPTION_TOP,
      'AZURE_AI_SEARCH_SEARCH_OPTION_TOP',
      AzureAISearch.DEFAULT_TOP,
    );
    this.select = this._initializeField(
      fields.AZURE_AI_SEARCH_SEARCH_OPTION_SELECT,
      'AZURE_AI_SEARCH_SEARCH_OPTION_SELECT',
    );

    // Check for required fields
    if (!this.override && (!this.serviceEndpoint || !this.indexName || !this.apiKey)) {
      throw new Error(
        'Missing AZURE_AI_SEARCH_SERVICE_ENDPOINT, AZURE_AI_SEARCH_INDEX_NAME, or AZURE_AI_SEARCH_API_KEY environment variable.',
      );
    }

    if (this.isUserProvidedEndpoint && !isAzureSearchEndpoint(this.serviceEndpoint)) {
      throw new Error(
        'User-provided Azure AI Search endpoints must use a trusted Azure Search host.',
      );
    }

    if (this.override) {
      return;
    }

    // Create SearchClient
    this.client = new SearchClient(
      this.serviceEndpoint,
      this.indexName,
      new AzureKeyCredential(this.apiKey),
      { apiVersion: this.apiVersion },
    );
  }

  // Improved error handling and logging
  async _call(data) {
    const { query } = data;
    try {
      const searchOption = {
        queryType: this.queryType,
        top: typeof this.top === 'string' ? Number(this.top) : this.top,
      };
      if (this.select) {
        searchOption.select = this.select.split(',');
      }
      const searchResults = await this.client.search(query, searchOption);
      const resultDocuments = [];
      for await (const result of searchResults.results) {
        resultDocuments.push(result.document);
      }
      return JSON.stringify(resultDocuments);
    } catch (error) {
      logger.error('Azure AI Search request failed', error);
      return 'There was an error with Azure AI Search.';
    }
  }
}

module.exports = AzureAISearch;

jest.mock(
  '@azure/search-documents',
  () => ({
    AzureKeyCredential: jest.fn(),
    SearchClient: jest.fn(),
  }),
  { virtual: true },
);

jest.mock(
  '@librechat/agents/langchain/tools',
  () => ({
    Tool: class {},
  }),
  { virtual: true },
);

jest.mock(
  '@librechat/data-schemas',
  () => ({
    logger: { error: jest.fn() },
  }),
  { virtual: true },
);

const AzureAISearch = require('../AzureAISearch');

describe('AzureAISearch', () => {
  const requiredFields = {
    AZURE_AI_SEARCH_API_KEY: 'key',
    AZURE_AI_SEARCH_INDEX_NAME: 'index',
    userProvidedAuthFields: new Set(['AZURE_AI_SEARCH_SERVICE_ENDPOINT']),
  };

  it('rejects a user-provided endpoint outside Azure AI Search', () => {
    expect(
      () =>
        new AzureAISearch({
          ...requiredFields,
          AZURE_AI_SEARCH_SERVICE_ENDPOINT: 'http://127.0.0.1:9000',
        }),
    ).toThrow('User-provided Azure AI Search endpoints must use a trusted Azure Search host.');
  });

  it('accepts a user-provided Azure AI Search endpoint', () => {
    expect(
      () =>
        new AzureAISearch({
          ...requiredFields,
          AZURE_AI_SEARCH_SERVICE_ENDPOINT: 'https://example.search.windows.net',
        }),
    ).not.toThrow();
  });
});

import { extractBaseURL, deriveBaseURL } from './url';

describe('extractBaseURL', () => {
  test.each(['https://api.example/v1beta/models', 'https://api.example/v10/models'])(
    'does not truncate a different API version: %s',
    (url) => expect(extractBaseURL(url)).toBe(url),
  );
  test('keeps Azure v1 and does not discard query or fragment validation inputs', () => {
    expect(extractBaseURL('https://resource.openai.azure.com/openai/v1/images/generations')).toBe(
      'https://resource.openai.azure.com/openai/v1',
    );
    expect(extractBaseURL('https://proxy.example/v1/chat/completions?secret=x#fragment')).toBe(
      'https://proxy.example/v1?secret=x#fragment',
    );
  });
  test('should extract base URL up to /v1 for standard endpoints', () => {
    const url = 'https://localhost:8080/v1/chat/completions';
    expect(extractBaseURL(url)).toBe('https://localhost:8080/v1');
  });

  test('should include /openai in the extracted URL when present', () => {
    const url = 'https://localhost:8080/v1/openai';
    expect(extractBaseURL(url)).toBe('https://localhost:8080/v1/openai');
  });

  test('should stop at /openai and not include any additional paths', () => {
    const url = 'https://fake.open.ai/v1/openai/you-are-cool';
    expect(extractBaseURL(url)).toBe('https://fake.open.ai/v1/openai');
  });

  test('should return the correct base URL for official openai endpoints', () => {
    const url = 'https://api.openai.com/v1/chat/completions';
    expect(extractBaseURL(url)).toBe('https://api.openai.com/v1');
  });

  test('should handle URLs with reverse proxy pattern correctly', () => {
    const url = 'https://gateway.ai.cloudflare.com/v1/ACCOUNT_TAG/GATEWAY/openai/completions';
    expect(extractBaseURL(url)).toBe(
      'https://gateway.ai.cloudflare.com/v1/ACCOUNT_TAG/GATEWAY/openai',
    );
  });

  test('should return input if the URL does not match the expected pattern', () => {
    const url = 'https://someotherdomain.com/notv1';
    expect(extractBaseURL(url)).toBe(url);
  });

  test('should extract base URL up to /v1 for open.ai standard endpoint', () => {
    const url = 'https://open.ai/v1/chat';
    expect(extractBaseURL(url)).toBe('https://open.ai/v1');
  });

  test('should extract base URL up to /v1 for open.ai standard endpoint with additional path', () => {
    const url = 'https://open.ai/v1/chat/completions';
    expect(extractBaseURL(url)).toBe('https://open.ai/v1');
  });

  test('should handle URLs with ACCOUNT/GATEWAY pattern followed by /openai', () => {
    const url = 'https://open.ai/v1/ACCOUNT/GATEWAY/openai/completions';
    expect(extractBaseURL(url)).toBe('https://open.ai/v1/ACCOUNT/GATEWAY/openai');
  });

  test('should include /openai in the extracted URL with additional segments', () => {
    const url = 'https://open.ai/v1/hi/openai';
    expect(extractBaseURL(url)).toBe('https://open.ai/v1/hi/openai');
  });

  test('should handle Azure OpenAI Cloudflare endpoint correctly', () => {
    const url = 'https://gateway.ai.cloudflare.com/v1/account/gateway/azure-openai/completions';
    expect(extractBaseURL(url)).toBe(
      'https://gateway.ai.cloudflare.com/v1/account/gateway/azure-openai',
    );
  });

  test('should include various suffixes in the extracted URL when present', () => {
    const urls = [
      'https://api.example.com/v1/azure-openai/something',
      'https://api.example.com/v1/replicate/anotherthing',
      'https://api.example.com/v1/huggingface/yetanotherthing',
      'https://api.example.com/v1/workers-ai/differentthing',
      'https://api.example.com/v1/aws-bedrock/somethingelse',
    ];

    const expected = [
      /* Note: exception for azure-openai to allow credential injection */
      'https://api.example.com/v1/azure-openai/something',
      'https://api.example.com/v1/replicate',
      'https://api.example.com/v1/huggingface',
      'https://api.example.com/v1/workers-ai',
      'https://api.example.com/v1/aws-bedrock',
    ];

    urls.forEach((url, index) => {
      expect(extractBaseURL(url)).toBe(expected[index]);
    });
  });

  test('should handle URLs with suffixes not immediately after /v1', () => {
    const url = 'https://api.example.com/v1/some/path/azure-openai';
    expect(extractBaseURL(url)).toBe('https://api.example.com/v1/some/path/azure-openai');
  });

  test('should handle URLs with complex paths after the suffix', () => {
    const url = 'https://api.example.com/v1/replicate/deep/path/segment';
    expect(extractBaseURL(url)).toBe('https://api.example.com/v1/replicate');
  });

  test('should leave a regular Azure OpenAI baseURL as is', () => {
    const url = 'https://instance-name.openai.azure.com/openai/deployments/deployment-name';
    expect(extractBaseURL(url)).toBe(url);
  });

  test('should leave a regular Azure OpenAI baseURL with placeholders as is', () => {
    const url = 'https://${INSTANCE_NAME}.openai.azure.com/openai/deployments/${DEPLOYMENT_NAME}';
    expect(extractBaseURL(url)).toBe(url);
  });

  test('should leave an alternate Azure OpenAI baseURL with placeholders as is', () => {
    const url = 'https://${INSTANCE_NAME}.com/resources/deployments/${DEPLOYMENT_NAME}';
    expect(extractBaseURL(url)).toBe(url);
  });

  test('should return undefined for null or empty input', () => {
    expect(extractBaseURL('')).toBe(undefined);
    // @ts-expect-error testing invalid input
    expect(extractBaseURL(null)).toBe(undefined);
    // @ts-expect-error testing invalid input
    expect(extractBaseURL(undefined)).toBe(undefined);
  });
});

describe('deriveBaseURL', () => {
  test('should extract protocol, hostname and port from a URL', () => {
    const fullURL = 'https://api.example.com:8080/v1/models';
    const baseURL = deriveBaseURL(fullURL);
    expect(baseURL).toBe('https://api.example.com:8080');
  });

  test('should handle URLs without port', () => {
    const fullURL = 'https://api.example.com/v1/models';
    const baseURL = deriveBaseURL(fullURL);
    expect(baseURL).toBe('https://api.example.com');
  });

  test('should handle HTTP protocol', () => {
    const fullURL = 'http://localhost:11434/api/tags';
    const baseURL = deriveBaseURL(fullURL);
    expect(baseURL).toBe('http://localhost:11434');
  });

  test('should handle URLs with paths', () => {
    const fullURL = 'https://api.ollama.com/v1/chat/completions';
    const baseURL = deriveBaseURL(fullURL);
    expect(baseURL).toBe('https://api.ollama.com');
  });

  test('should return the original URL if parsing fails', () => {
    const invalidURL = 'not-a-valid-url';
    const result = deriveBaseURL(invalidURL);
    expect(result).toBe(invalidURL);
  });

  test('should handle localhost URLs', () => {
    const fullURL = 'http://localhost:11434';
    const baseURL = deriveBaseURL(fullURL);
    expect(baseURL).toBe('http://localhost:11434');
  });
});

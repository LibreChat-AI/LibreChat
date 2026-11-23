import {
  getAzureCredentials,
  constructAzureURL,
  sanitizeModelName,
  genAzureEndpoint,
} from './azure';

describe('sanitizeModelName', () => {
  test('removes periods from the model name', () => {
    const sanitized = sanitizeModelName('model.name');
    expect(sanitized).toBe('modelname');
  });

  test('leaves model name unchanged if no periods are present', () => {
    const sanitized = sanitizeModelName('modelname');
    expect(sanitized).toBe('modelname');
  });
});

describe('genAzureEndpoint', () => {
  test('generates correct endpoint URL', () => {
    const url = genAzureEndpoint({
      azureOpenAIApiInstanceName: 'instanceName',
      azureOpenAIApiDeploymentName: 'deploymentName',
    });
    expect(url).toBe('https://instanceName.openai.azure.com/openai/deployments/deploymentName');
  });
});

describe('getAzureCredentials', () => {
  beforeEach(() => {
    process.env.AZURE_API_KEY = 'testApiKey';
    process.env.AZURE_OPENAI_API_INSTANCE_NAME = 'instanceName';
    process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME = 'deploymentName';
    process.env.AZURE_OPENAI_API_VERSION = 'v1';
  });

  test('retrieves Azure OpenAI API credentials from environment variables', () => {
    const credentials = getAzureCredentials();
    expect(credentials).toEqual({
      azureOpenAIApiKey: 'testApiKey',
      azureOpenAIApiInstanceName: 'instanceName',
      azureOpenAIApiDeploymentName: 'deploymentName',
      azureOpenAIApiVersion: 'v1',
    });
  });
});

describe('constructAzureURL', () => {
  test('replaces both placeholders when both properties are provided', () => {
    const url = constructAzureURL({
      baseURL: 'https://example.com/${INSTANCE_NAME}/${DEPLOYMENT_NAME}',
      azureOptions: {
        azureOpenAIApiInstanceName: 'instance1',
        azureOpenAIApiDeploymentName: 'deployment1',
      },
    });
    expect(url).toBe('https://example.com/instance1/deployment1');
  });

  test('replaces only INSTANCE_NAME when only azureOpenAIApiInstanceName is provided', () => {
    const url = constructAzureURL({
      baseURL: 'https://example.com/${INSTANCE_NAME}/${DEPLOYMENT_NAME}',
      azureOptions: {
        azureOpenAIApiInstanceName: 'instance2',
      },
    });
    expect(url).toBe('https://example.com/instance2/');
  });

  test('replaces only DEPLOYMENT_NAME when only azureOpenAIApiDeploymentName is provided', () => {
    const url = constructAzureURL({
      baseURL: 'https://example.com/${INSTANCE_NAME}/${DEPLOYMENT_NAME}',
      azureOptions: {
        azureOpenAIApiDeploymentName: 'deployment2',
      },
    });
    expect(url).toBe('https://example.com//deployment2');
  });

  test('does not replace any placeholders when azure object is empty', () => {
    const url = constructAzureURL({
      baseURL: 'https://example.com/${INSTANCE_NAME}/${DEPLOYMENT_NAME}',
      azureOptions: {},
    });
    expect(url).toBe('https://example.com//');
  });

  test('returns baseURL as is when `azureOptions` object is not provided', () => {
    const url = constructAzureURL({
      baseURL: 'https://example.com/${INSTANCE_NAME}/${DEPLOYMENT_NAME}',
    });
    expect(url).toBe('https://example.com/${INSTANCE_NAME}/${DEPLOYMENT_NAME}');
  });

  test('returns baseURL as is when no placeholders are set', () => {
    const url = constructAzureURL({
      baseURL: 'https://example.com/my_custom_instance/my_deployment',
      azureOptions: {
        azureOpenAIApiInstanceName: 'instance1',
        azureOpenAIApiDeploymentName: 'deployment1',
      },
    });
    expect(url).toBe('https://example.com/my_custom_instance/my_deployment');
  });

  test('returns regular Azure OpenAI baseURL with placeholders set', () => {
    const baseURL =
      'https://${INSTANCE_NAME}.openai.azure.com/openai/deployments/${DEPLOYMENT_NAME}';
    const url = constructAzureURL({
      baseURL,
      azureOptions: {
        azureOpenAIApiInstanceName: 'instance1',
        azureOpenAIApiDeploymentName: 'deployment1',
      },
    });
    expect(url).toBe('https://instance1.openai.azure.com/openai/deployments/deployment1');
  });
});

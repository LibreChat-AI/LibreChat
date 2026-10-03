const {
  buildJobSubmissionUrls,
  buildJobStatusUrl,
  buildVideoContentUrl,
} = require('../azureSoraUrls');
const { AzureSora, azureSoraJsonSchema } = require('../AzureSora');

describe('AzureSora URL helpers', () => {
  const endpoint = 'https://demo.openai.azure.com/';

  it('builds both v1 and deployment job submission URLs from the shipped helper', () => {
    const urls = buildJobSubmissionUrls({
      endpoint,
      apiVersion: 'preview',
      deploymentName: 'sora',
    });
    expect(urls).toEqual([
      'https://demo.openai.azure.com/openai/v1/video/generations/jobs?api-version=preview',
      'https://demo.openai.azure.com/openai/deployments/sora/video/generations/jobs?api-version=preview',
    ]);
  });

  it('builds job status and content URLs from the shipped helpers', () => {
    expect(
      buildJobStatusUrl({ endpoint, apiVersion: 'preview', jobId: 'job-1' }),
    ).toBe(
      'https://demo.openai.azure.com/openai/v1/video/generations/jobs/job-1?api-version=preview',
    );
    expect(
      buildVideoContentUrl({ endpoint, apiVersion: 'preview', jobId: 'job-1' }),
    ).toBe(
      'https://demo.openai.azure.com/openai/v1/video/generations/job-1/content/video?api-version=preview',
    );
  });
});

describe('AzureSora tool', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  it('throws when API key and endpoint are missing', () => {
    delete process.env.AZURE_SORA_API_KEY;
    delete process.env.AZURE_API_KEY;
    delete process.env.AZURE_SORA_ENDPOINT;
    delete process.env.AZURE_OPENAI_ENDPOINT;
    expect(() => new AzureSora()).toThrow(/Azure Sora is not configured/);
  });

  it('constructs from env and requires prompt on _call', async () => {
    process.env.AZURE_SORA_API_KEY = 'test-key';
    process.env.AZURE_SORA_ENDPOINT = 'https://demo.openai.azure.com';
    const tool = new AzureSora();
    expect(tool.name).toBe('video_gen_sora_azure');
    expect(azureSoraJsonSchema.required).toEqual(['prompt']);
    await expect(tool._call({})).rejects.toThrow('Missing required field: prompt');
  });
});

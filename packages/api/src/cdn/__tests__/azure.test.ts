import type { BlobServiceClient } from '@azure/storage-blob';

const mockLogger = { info: jest.fn(), error: jest.fn() };

jest.mock('@azure/storage-blob', () => ({
  BlobServiceClient: jest.fn(),
}));

jest.mock('@azure/identity', () => ({
  DefaultAzureCredential: jest.fn(),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: mockLogger,
}));

describe('initializeAzureBlobService', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.AZURE_STORAGE_CONNECTION_STRING;
    delete process.env.AZURE_STORAGE_ENDPOINT_SUFFIX;
    process.env.AZURE_STORAGE_ACCOUNT_NAME = 'testaccount';
  });

  afterEach(() => {
    delete process.env.AZURE_STORAGE_ACCOUNT_NAME;
    delete process.env.AZURE_STORAGE_ENDPOINT_SUFFIX;
  });

  async function load() {
    const { BlobServiceClient: MockBlobServiceClient } = jest.requireMock(
      '@azure/storage-blob',
    ) as {
      BlobServiceClient: jest.MockedClass<typeof BlobServiceClient>;
    };
    const { initializeAzureBlobService } = await import('../azure');
    return { MockBlobServiceClient, initializeAzureBlobService };
  }

  it('should default to the commercial Azure endpoint suffix', async () => {
    const { MockBlobServiceClient, initializeAzureBlobService } = await load();
    await initializeAzureBlobService();
    expect(MockBlobServiceClient).toHaveBeenCalledWith(
      'https://testaccount.blob.core.windows.net',
      expect.anything(),
    );
  });

  it('should use AZURE_STORAGE_ENDPOINT_SUFFIX when set', async () => {
    process.env.AZURE_STORAGE_ENDPOINT_SUFFIX = 'core.usgovcloudapi.net';
    const { MockBlobServiceClient, initializeAzureBlobService } = await load();
    await initializeAzureBlobService();
    expect(MockBlobServiceClient).toHaveBeenCalledWith(
      'https://testaccount.blob.core.usgovcloudapi.net',
      expect.anything(),
    );
  });
});

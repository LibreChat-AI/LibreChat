import type { S3Client } from '@aws-sdk/client-s3';

const mockLogger = { info: jest.fn(), error: jest.fn() };

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: mockLogger,
}));

describe('initializeS3', () => {
  const REQUIRED_ENV = {
    AWS_REGION: 'us-east-1',
    AWS_BUCKET_NAME: 'test-bucket',
    AWS_ACCESS_KEY_ID: 'test-key-id',
    AWS_SECRET_ACCESS_KEY: 'test-secret',
  };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    Object.assign(process.env, REQUIRED_ENV);
    delete process.env.AWS_ENDPOINT_URL;
    delete process.env.AWS_FORCE_PATH_STYLE;
  });

  afterEach(() => {
    for (const key of Object.keys(REQUIRED_ENV)) {
      delete process.env[key];
    }
    delete process.env.AWS_ENDPOINT_URL;
    delete process.env.AWS_FORCE_PATH_STYLE;
  });

  async function load() {
    const { S3Client: MockS3Client } = jest.requireMock('@aws-sdk/client-s3') as {
      S3Client: jest.MockedClass<typeof S3Client>;
    };
    const { initializeS3 } = await import('../s3');
    return { MockS3Client, initializeS3 };
  }

  it('should initialize with region and credentials', async () => {
    const { MockS3Client, initializeS3 } = await load();
    initializeS3();
    expect(MockS3Client).toHaveBeenCalledWith(
      expect.objectContaining({
        region: 'us-east-1',
        credentials: { accessKeyId: 'test-key-id', secretAccessKey: 'test-secret' },
      }),
    );
  });

  it('should include endpoint when AWS_ENDPOINT_URL is set', async () => {
    process.env.AWS_ENDPOINT_URL = 'https://fsn1.your-objectstorage.com';
    const { MockS3Client, initializeS3 } = await load();
    initializeS3();
    expect(MockS3Client).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'https://fsn1.your-objectstorage.com' }),
    );
  });

  it('should only calculate request checksums when S3 requires them', async () => {
    const { MockS3Client, initializeS3 } = await load();
    initializeS3();
    expect(MockS3Client).toHaveBeenCalledWith(
      expect.objectContaining({ requestChecksumCalculation: 'WHEN_REQUIRED' }),
    );
  });

  it('should not include endpoint when AWS_ENDPOINT_URL is not set', async () => {
    const { MockS3Client, initializeS3 } = await load();
    initializeS3();
    const config = MockS3Client.mock.calls[0][0] as Record<string, unknown>;
    expect(config).not.toHaveProperty('endpoint');
  });

  it('should set forcePathStyle when AWS_FORCE_PATH_STYLE is true', async () => {
    process.env.AWS_FORCE_PATH_STYLE = 'true';
    const { MockS3Client, initializeS3 } = await load();
    initializeS3();
    expect(MockS3Client).toHaveBeenCalledWith(expect.objectContaining({ forcePathStyle: true }));
  });

  it('should not set forcePathStyle when AWS_FORCE_PATH_STYLE is false', async () => {
    process.env.AWS_FORCE_PATH_STYLE = 'false';
    const { MockS3Client, initializeS3 } = await load();
    initializeS3();
    const config = MockS3Client.mock.calls[0][0] as Record<string, unknown>;
    expect(config).not.toHaveProperty('forcePathStyle');
  });

  it('should not set forcePathStyle when AWS_FORCE_PATH_STYLE is not set', async () => {
    const { MockS3Client, initializeS3 } = await load();
    initializeS3();
    const config = MockS3Client.mock.calls[0][0] as Record<string, unknown>;
    expect(config).not.toHaveProperty('forcePathStyle');
  });

  it('should return null and log error when AWS_REGION is not set', async () => {
    delete process.env.AWS_REGION;
    const { initializeS3 } = await load();
    const result = initializeS3();
    expect(result).toBeNull();
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[initializeS3] AWS_REGION is not set. Cannot initialize S3.',
    );
  });

  it('should throw when AWS_BUCKET_NAME is not set', async () => {
    delete process.env.AWS_BUCKET_NAME;
    const { initializeS3 } = await load();
    expect(() => initializeS3()).toThrow(
      '[S3] AWS_BUCKET_NAME environment variable is required for S3 operations.',
    );
  });

  it('should return the same instance on subsequent calls', async () => {
    const { MockS3Client, initializeS3 } = await load();
    const first = initializeS3();
    const second = initializeS3();
    expect(first).toBe(second);
    expect(MockS3Client).toHaveBeenCalledTimes(1);
  });

  it('should use default credentials chain when keys are not provided', async () => {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    const { MockS3Client, initializeS3 } = await load();
    initializeS3();
    const config = MockS3Client.mock.calls[0][0] as Record<string, unknown>;
    expect(config).not.toHaveProperty('credentials');
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[initializeS3] S3 initialized using default credentials (IRSA).',
    );
  });
});

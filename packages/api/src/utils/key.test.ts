import path from 'path';
import axios from 'axios';
import { ErrorTypes } from 'librechat-data-provider';
import { checkUserKeyExpiry, loadServiceKey } from './key';
import { readFileAsString } from './files';

jest.mock('fs');
jest.mock('axios');
jest.mock('@librechat/data-schemas', () => ({
  logger: {
    error: jest.fn(),
  },
}));

jest.mock('./files', () => ({
  readFileAsString: jest.fn(),
}));

describe('loadServiceKey', () => {
  const mockServiceKey = {
    type: 'service_account',
    project_id: 'test-project',
    private_key_id: 'test-key-id',
    private_key: '-----BEGIN PRIVATE KEY-----\ntest-key\n-----END PRIVATE KEY-----',
    client_email: 'test@test-project.iam.gserviceaccount.com',
    client_id: '123456789',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url:
      'https://www.googleapis.com/robot/v1/metadata/x509/test%40test-project.iam.gserviceaccount.com',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return null if keyPath is empty', async () => {
    const result = await loadServiceKey('');
    expect(result).toBeNull();
  });

  it('should parse stringified JSON directly', async () => {
    const jsonString = JSON.stringify(mockServiceKey);
    const result = await loadServiceKey(jsonString);
    expect(result).toEqual(mockServiceKey);
  });

  it('should parse stringified JSON with leading/trailing whitespace', async () => {
    const jsonString = `  ${JSON.stringify(mockServiceKey)}  `;
    const result = await loadServiceKey(jsonString);
    expect(result).toEqual(mockServiceKey);
  });

  it('should load from file path', async () => {
    const filePath = '/path/to/service-key.json';
    (readFileAsString as jest.Mock).mockResolvedValue({
      content: JSON.stringify(mockServiceKey),
      bytes: JSON.stringify(mockServiceKey).length,
    });

    const result = await loadServiceKey(filePath);
    expect(readFileAsString).toHaveBeenCalledWith(path.resolve(filePath));
    expect(result).toEqual(mockServiceKey);
  });

  it('should load from URL', async () => {
    const url = 'https://example.com/service-key.json';
    (axios.get as jest.Mock).mockResolvedValue({ data: mockServiceKey });

    const result = await loadServiceKey(url);
    expect(axios.get).toHaveBeenCalledWith(url);
    expect(result).toEqual(mockServiceKey);
  });

  it('should handle invalid JSON string', async () => {
    const invalidJson = '{ invalid json }';
    const result = await loadServiceKey(invalidJson);
    expect(result).toBeNull();
  });

  it('should handle file read errors', async () => {
    const filePath = '/path/to/nonexistent.json';
    (readFileAsString as jest.Mock).mockRejectedValue(new Error('File not found'));

    const result = await loadServiceKey(filePath);
    expect(result).toBeNull();
  });

  it('should handle URL fetch errors', async () => {
    const url = 'https://example.com/service-key.json';
    (axios.get as jest.Mock).mockRejectedValue(new Error('Network error'));

    const result = await loadServiceKey(url);
    expect(result).toBeNull();
  });

  it('should validate service key format', async () => {
    const invalidServiceKey = { invalid: 'key' };
    const result = await loadServiceKey(JSON.stringify(invalidServiceKey));
    expect(result).toEqual(invalidServiceKey); // It returns the object as-is, validation is minimal
  });

  it('should handle escaped newlines in private key from AWS Secrets Manager', async () => {
    const serviceKeyWithEscapedNewlines = {
      ...mockServiceKey,
      private_key: '-----BEGIN PRIVATE KEY-----\\ntest-key\\n-----END PRIVATE KEY-----',
    };
    const jsonString = JSON.stringify(serviceKeyWithEscapedNewlines);

    const result = await loadServiceKey(jsonString);
    expect(result).not.toBeNull();
    expect(result?.private_key).toBe(
      '-----BEGIN PRIVATE KEY-----\ntest-key\n-----END PRIVATE KEY-----',
    );
  });

  it('should handle double-escaped newlines in private key', async () => {
    // When you have \\n in JavaScript, JSON.stringify converts it to \\\\n
    // But we want to test the case where the JSON string contains \\n (single backslash + n)
    const serviceKeyWithEscapedNewlines = {
      ...mockServiceKey,
      private_key: '-----BEGIN PRIVATE KEY-----\\ntest-key\\n-----END PRIVATE KEY-----',
    };
    // This will create a JSON string where the private_key contains literal \n (backslash-n)
    const jsonString = JSON.stringify(serviceKeyWithEscapedNewlines);

    const result = await loadServiceKey(jsonString);
    expect(result).not.toBeNull();
    expect(result?.private_key).toBe(
      '-----BEGIN PRIVATE KEY-----\ntest-key\n-----END PRIVATE KEY-----',
    );
  });

  it('should handle private key without any newlines', async () => {
    const serviceKeyWithoutNewlines = {
      ...mockServiceKey,
      private_key: '-----BEGIN PRIVATE KEY-----test-key-----END PRIVATE KEY-----',
    };
    const jsonString = JSON.stringify(serviceKeyWithoutNewlines);

    const result = await loadServiceKey(jsonString);
    expect(result).not.toBeNull();
    expect(result?.private_key).toBe(
      '-----BEGIN PRIVATE KEY-----\ntest-key\n-----END PRIVATE KEY-----',
    );
  });

  it('should not modify private key that already has proper formatting', async () => {
    const jsonString = JSON.stringify(mockServiceKey);

    const result = await loadServiceKey(jsonString);
    expect(result).not.toBeNull();
    expect(result?.private_key).toBe(mockServiceKey.private_key);
  });

  it('should handle base64 encoded service key', async () => {
    const jsonString = JSON.stringify(mockServiceKey);
    const base64Encoded = Buffer.from(jsonString).toString('base64');

    const result = await loadServiceKey(base64Encoded);
    expect(result).not.toBeNull();
    expect(result).toEqual(mockServiceKey);
  });

  it('should handle base64 encoded service key with escaped newlines', async () => {
    const serviceKeyWithEscapedNewlines = {
      ...mockServiceKey,
      private_key: '-----BEGIN PRIVATE KEY-----\\ntest-key\\n-----END PRIVATE KEY-----',
    };
    const jsonString = JSON.stringify(serviceKeyWithEscapedNewlines);
    const base64Encoded = Buffer.from(jsonString).toString('base64');

    const result = await loadServiceKey(base64Encoded);
    expect(result).not.toBeNull();
    expect(result?.private_key).toBe(
      '-----BEGIN PRIVATE KEY-----\ntest-key\n-----END PRIVATE KEY-----',
    );
  });

  it('should handle invalid base64 strings gracefully', async () => {
    // This looks like base64 but isn't valid
    const invalidBase64 = 'SGVsbG8gV29ybGQ='; // "Hello World" in base64, not valid JSON

    const result = await loadServiceKey(invalidBase64);
    expect(result).toBeNull();
  });
});

describe('checkUserKeyExpiry', () => {
  it('accepts a key that has not expired', () => {
    expect(() =>
      checkUserKeyExpiry(new Date(Date.now() + 60_000).toISOString(), 'openAI'),
    ).not.toThrow();
  });

  /** A locale-formatted date cannot be parsed back reliably by a client in another locale. */
  it('reports an expired key with a locale-independent ISO timestamp', () => {
    const expiresAt = '2026-08-01T09:30:00.000Z';

    let thrown: Error | undefined;
    try {
      checkUserKeyExpiry(expiresAt, 'google');
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(JSON.parse(thrown?.message ?? '')).toEqual({
      type: ErrorTypes.EXPIRED_USER_KEY,
      expiredAt: expiresAt,
      endpoint: 'google',
    });
  });
});

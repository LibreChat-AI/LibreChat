jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  DEFAULT_IMPORT_MAX_FILE_SIZE,
  DEFAULT_IMPORT_MAX_SHARD_SIZE,
  DEFAULT_IMPORT_MAX_CONCURRENCY,
  resolveImportMaxFileSize,
  resolveImportMaxShardSize,
  resolveImportMaxConcurrency,
} from '../import';
import { logger } from '@librechat/data-schemas';

describe('resolveImportMaxFileSize', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.CONVERSATION_IMPORT_MAX_FILE_SIZE_BYTES;
    jest.clearAllMocks();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.CONVERSATION_IMPORT_MAX_FILE_SIZE_BYTES = originalEnv;
    } else {
      delete process.env.CONVERSATION_IMPORT_MAX_FILE_SIZE_BYTES;
    }
  });

  it('returns 1073741824 (1 GiB) when env var is not set', () => {
    delete process.env.CONVERSATION_IMPORT_MAX_FILE_SIZE_BYTES;
    expect(resolveImportMaxFileSize()).toBe(1073741824);
    expect(DEFAULT_IMPORT_MAX_FILE_SIZE).toBe(1073741824);
  });

  it('returns default when env var is empty string', () => {
    process.env.CONVERSATION_IMPORT_MAX_FILE_SIZE_BYTES = '';
    expect(resolveImportMaxFileSize()).toBe(DEFAULT_IMPORT_MAX_FILE_SIZE);
  });

  it('respects a custom numeric value', () => {
    process.env.CONVERSATION_IMPORT_MAX_FILE_SIZE_BYTES = '5242880';
    expect(resolveImportMaxFileSize()).toBe(5242880);
  });

  it('parses string env var to number', () => {
    process.env.CONVERSATION_IMPORT_MAX_FILE_SIZE_BYTES = '1048576';
    expect(resolveImportMaxFileSize()).toBe(1048576);
  });

  it('falls back to default and warns for non-numeric string', () => {
    process.env.CONVERSATION_IMPORT_MAX_FILE_SIZE_BYTES = 'abc';
    expect(resolveImportMaxFileSize()).toBe(DEFAULT_IMPORT_MAX_FILE_SIZE);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Invalid CONVERSATION_IMPORT_MAX_FILE_SIZE_BYTES'),
    );
  });

  it('falls back to default and warns for negative values', () => {
    process.env.CONVERSATION_IMPORT_MAX_FILE_SIZE_BYTES = '-100';
    expect(resolveImportMaxFileSize()).toBe(DEFAULT_IMPORT_MAX_FILE_SIZE);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Invalid CONVERSATION_IMPORT_MAX_FILE_SIZE_BYTES'),
    );
  });

  it('falls back to default and warns for zero', () => {
    process.env.CONVERSATION_IMPORT_MAX_FILE_SIZE_BYTES = '0';
    expect(resolveImportMaxFileSize()).toBe(DEFAULT_IMPORT_MAX_FILE_SIZE);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Invalid CONVERSATION_IMPORT_MAX_FILE_SIZE_BYTES'),
    );
  });

  it('falls back to default and warns for Infinity', () => {
    process.env.CONVERSATION_IMPORT_MAX_FILE_SIZE_BYTES = 'Infinity';
    expect(resolveImportMaxFileSize()).toBe(DEFAULT_IMPORT_MAX_FILE_SIZE);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Invalid CONVERSATION_IMPORT_MAX_FILE_SIZE_BYTES'),
    );
  });
});

describe('resolveImportMaxShardSize', () => {
  const original = process.env.CONVERSATION_IMPORT_MAX_SHARD_SIZE_BYTES;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.CONVERSATION_IMPORT_MAX_SHARD_SIZE_BYTES;
      return;
    }
    process.env.CONVERSATION_IMPORT_MAX_SHARD_SIZE_BYTES = original;
  });

  it('defaults to 256 MiB', () => {
    delete process.env.CONVERSATION_IMPORT_MAX_SHARD_SIZE_BYTES;
    expect(resolveImportMaxShardSize()).toBe(DEFAULT_IMPORT_MAX_SHARD_SIZE);
    expect(DEFAULT_IMPORT_MAX_SHARD_SIZE).toBe(268435456);
  });

  it('honours a configured override', () => {
    process.env.CONVERSATION_IMPORT_MAX_SHARD_SIZE_BYTES = '5242880';
    expect(resolveImportMaxShardSize()).toBe(5242880);
  });

  it.each(['0', '-1', 'not-a-number'])('falls back to the default for %s', (raw) => {
    process.env.CONVERSATION_IMPORT_MAX_SHARD_SIZE_BYTES = raw;
    expect(resolveImportMaxShardSize()).toBe(DEFAULT_IMPORT_MAX_SHARD_SIZE);
  });
});

describe('resolveImportMaxConcurrency', () => {
  const original = process.env.CONVERSATION_IMPORT_MAX_CONCURRENT;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.CONVERSATION_IMPORT_MAX_CONCURRENT;
      return;
    }
    process.env.CONVERSATION_IMPORT_MAX_CONCURRENT = original;
  });

  it('defaults to three stages', () => {
    delete process.env.CONVERSATION_IMPORT_MAX_CONCURRENT;
    expect(resolveImportMaxConcurrency()).toBe(DEFAULT_IMPORT_MAX_CONCURRENCY);
    expect(DEFAULT_IMPORT_MAX_CONCURRENCY).toBe(3);
  });

  it('honours a configured override', () => {
    process.env.CONVERSATION_IMPORT_MAX_CONCURRENT = '8';
    expect(resolveImportMaxConcurrency()).toBe(8);
  });

  /** A fractional ceiling would admit a stage the operator never allowed for:
   * `2.5` reads as "two and a half imports", and the comparison rounds it up
   * to three. */
  it.each(['0', '-1', '2.5', 'not-a-number'])('falls back to the default for %s', (raw) => {
    process.env.CONVERSATION_IMPORT_MAX_CONCURRENT = raw;
    expect(resolveImportMaxConcurrency()).toBe(DEFAULT_IMPORT_MAX_CONCURRENCY);
  });
});

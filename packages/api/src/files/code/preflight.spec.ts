import type { FiltersConfig } from 'librechat-data-provider';
import type { CodeOutputArtifact, PrepareCodeOutputInput, PreparedCodeOutput } from './preflight';
import { CODE_OUTPUT_PREFLIGHT_MAX_BYTES, preflightCodeOutputBatch } from './preflight';

const BLOCK_PATTERN = {
  id: 'private-token',
  label: 'private token',
  regex: 'PRIVATE-[A-Z]+',
};

const limits = {
  fileLimit: 10,
  fileSizeLimit: 16,
  totalSizeLimit: 32,
};

function artifact(count = 1): CodeOutputArtifact {
  return {
    session_id: 'artifact-session',
    files: Array.from({ length: count }, (_, index) => ({
      id: `file-${index}`,
      name: `file-${index}.txt`,
      storage_session_id: `storage-${index}`,
    })),
  };
}

function prepared(
  input: PrepareCodeOutputInput,
  overrides: Partial<PreparedCodeOutput> = {},
): PreparedCodeOutput {
  return {
    buffer: Buffer.from('safe'),
    extractedTextComplete: true,
    file: {
      ...input.file,
      type: 'text/plain',
      content: 'safe',
    },
    ...overrides,
  };
}

describe('preflightCodeOutputBatch', () => {
  it('bounded-downloads default-off artifacts and reuses the prepared bytes', async () => {
    const prepare = jest.fn(async (input: PrepareCodeOutputInput) => prepared(input));

    const result = await preflightCodeOutputBatch({
      artifact: artifact(2),
      limits,
      prepare,
    });

    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ maxBytes: 16, inspectContent: false }),
    );
    expect(prepare).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ maxBytes: 16, inspectContent: false }),
    );
    expect(result.map((entry) => entry.preparedBuffer?.toString())).toEqual(['safe', 'safe']);
    expect(result.every((entry) => entry.downloadFallback !== true)).toBe(true);
  });

  it('treats zero byte limits as unlimited within the hard transport ceiling', async () => {
    const prepare = jest.fn(async (input: PrepareCodeOutputInput) =>
      prepared(input, { buffer: Buffer.alloc(4) }),
    );

    const result = await preflightCodeOutputBatch({
      artifact: artifact(2),
      limits: { ...limits, fileSizeLimit: 0, totalSizeLimit: 0 },
      prepare,
    });

    expect(prepare).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ maxBytes: CODE_OUTPUT_PREFLIGHT_MAX_BYTES }),
    );
    expect(prepare).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ maxBytes: CODE_OUTPUT_PREFLIGHT_MAX_BYTES - 4 }),
    );
    expect(result.map((entry) => entry.preparedBuffer?.length)).toEqual([4, 4]);
    expect(result.every((entry) => entry.downloadFallback !== true)).toBe(true);
  });

  it('uses explicit URL fallbacks for default-off count overflow without downloading', async () => {
    const prepare = jest.fn(async (input: PrepareCodeOutputInput) => prepared(input));

    const result = await preflightCodeOutputBatch({
      artifact: artifact(3),
      limits: { ...limits, fileLimit: 2 },
      prepare,
    });

    expect(prepare).not.toHaveBeenCalled();
    expect(result).toHaveLength(2);
    expect(result.every((entry) => entry.downloadFallback === true)).toBe(true);
  });

  it('preserves configured files above the inspection count as URL fallbacks', async () => {
    const prepare = jest.fn(async (input: PrepareCodeOutputInput) => prepared(input));

    const result = await preflightCodeOutputBatch({
      artifact: artifact(12),
      limits: { ...limits, fileLimit: 12 },
      prepare,
    });

    expect(prepare).not.toHaveBeenCalled();
    expect(result.map((entry) => entry.file.id)).toEqual(
      Array.from({ length: 12 }, (_, index) => `file-${index}`),
    );
    expect(result.every((entry) => entry.downloadFallback === true)).toBe(true);
  });

  it('stops default-off downloads at the aggregate budget and falls back without retrying', async () => {
    const prepare = jest.fn(async (input: PrepareCodeOutputInput) =>
      prepared(input, { buffer: Buffer.alloc(4) }),
    );

    const result = await preflightCodeOutputBatch({
      artifact: artifact(2),
      limits: { ...limits, fileSizeLimit: 4, totalSizeLimit: 4 },
      prepare,
    });

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ maxBytes: 4 }));
    expect(result[0]).toMatchObject({ preparedBuffer: Buffer.alloc(4) });
    expect(result[1]).toMatchObject({ downloadFallback: true });
  });

  it('reserves a failed transport budget and never starts another default-off download', async () => {
    const prepare = jest.fn(async () => {
      throw new Error('transport limit');
    });

    const result = await preflightCodeOutputBatch({
      artifact: artifact(2),
      limits: { ...limits, fileSizeLimit: 4, totalSizeLimit: 4 },
      prepare,
    });

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(result.every((entry) => entry.downloadFallback === true)).toBe(true);
  });

  it('rejects active-policy count overflow instead of bypassing inspection', async () => {
    const filters: FiltersConfig = {
      files: {
        pii: {
          fields: ['content'],
          starterPatterns: [],
          customPatterns: [BLOCK_PATTERN],
          uninspectable: 'allow',
        },
      },
    };
    const prepare = jest.fn(async (input: PrepareCodeOutputInput) => prepared(input));

    await expect(
      preflightCodeOutputBatch({
        filters,
        artifact: artifact(3),
        limits: { ...limits, fileLimit: 2 },
        prepare,
      }),
    ).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      body: { source: 'file', field: 'content' },
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('rejects active inspection above the hard count even when the configured limit allows it', async () => {
    const filters: FiltersConfig = {
      files: {
        pii: {
          fields: ['content'],
          starterPatterns: [],
          customPatterns: [BLOCK_PATTERN],
          uninspectable: 'allow',
        },
      },
    };
    const prepare = jest.fn(async (input: PrepareCodeOutputInput) => prepared(input));
    const inputArtifact = artifact(12);
    const overflowFile = inputArtifact.files?.[10];
    if (overflowFile == null) {
      throw new Error('Expected an overflow file');
    }
    const readOverflowContent = jest.fn(() => 'safe');
    Object.defineProperty(overflowFile, 'content', { get: readOverflowContent });

    await expect(
      preflightCodeOutputBatch({
        filters,
        artifact: inputArtifact,
        limits: { ...limits, fileLimit: 12 },
        prepare,
      }),
    ).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      body: { source: 'file', field: 'content' },
    });
    expect(readOverflowContent).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('rejects a late blocked file only after preparing the complete no-write batch', async () => {
    const filters: FiltersConfig = {
      files: {
        pii: {
          fields: ['content'],
          starterPatterns: [],
          customPatterns: [BLOCK_PATTERN],
        },
      },
    };
    const prepare = jest.fn(async (input: PrepareCodeOutputInput) =>
      prepared(input, {
        file: {
          ...input.file,
          type: 'text/plain',
          content: input.file.id === 'file-1' ? 'PRIVATE-SECRET' : 'safe',
        },
      }),
    );

    await expect(
      preflightCodeOutputBatch({
        filters,
        artifact: artifact(2),
        limits,
        prepare,
      }),
    ).rejects.toMatchObject({
      code: 'content_filter_block',
      body: { source: 'file', field: 'content' },
    });
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('sniffs actual non-audio bytes before treating transcript policy as inapplicable', async () => {
    const filters: FiltersConfig = {
      files: {
        pii: {
          fields: ['transcript'],
          starterPatterns: [],
          uninspectable: 'block',
        },
      },
    };
    const prepare = jest.fn(async (input: PrepareCodeOutputInput) =>
      prepared(input, {
        file: { ...input.file, type: 'text/plain', content: 'safe' },
      }),
    );

    await expect(
      preflightCodeOutputBatch({ filters, artifact: artifact(), limits, prepare }),
    ).resolves.toHaveLength(1);
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ inspectContent: true }));
  });

  it('fails closed when a text-named artifact sniffs as audio without a transcript', async () => {
    const filters: FiltersConfig = {
      files: {
        pii: {
          fields: ['transcript'],
          starterPatterns: [],
          uninspectable: 'block',
        },
      },
    };
    const prepare = jest.fn(async (input: PrepareCodeOutputInput) =>
      prepared(input, {
        file: { ...input.file, type: 'audio/wav' },
      }),
    );

    await expect(
      preflightCodeOutputBatch({ filters, artifact: artifact(), limits, prepare }),
    ).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      body: { source: 'file', field: 'transcript' },
    });
  });

  it('fails closed for unknown bytes under transcript policy', async () => {
    const filters: FiltersConfig = {
      files: {
        pii: {
          fields: ['transcript'],
          starterPatterns: [],
          uninspectable: 'block',
        },
      },
    };
    const prepare = jest.fn(async (input: PrepareCodeOutputInput) =>
      prepared(input, {
        file: { ...input.file, type: 'application/octet-stream' },
      }),
    );

    await expect(
      preflightCodeOutputBatch({ filters, artifact: artifact(), limits, prepare }),
    ).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      body: { source: 'file', field: 'transcript' },
    });
  });
});

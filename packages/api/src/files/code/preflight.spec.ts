import type { FiltersConfig } from 'librechat-data-provider';
import type { CodeOutputArtifact, PrepareCodeOutputInput, PreparedCodeOutput } from './preflight';
import { preflightCodeOutputBatch, CODE_OUTPUT_PREFLIGHT_MAX_BYTES } from './preflight';
import { getPreparedCodeOutputBuffer, cachePreparedCodeOutputBuffer } from './cache';
import { DEFAULT_LOOKUP_CONCURRENCY } from '../../utils/concurrency';

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
    const sizes = [40 * 1024 * 1024, 4];
    const prepare = jest.fn(async (input: PrepareCodeOutputInput) => {
      const size = sizes[Number(input.file.id.split('-')[1])];
      if (size > input.maxBytes) {
        throw new Error('maxContentLength exceeded');
      }
      return prepared(input, { buffer: Buffer.alloc(size) });
    });

    const result = await preflightCodeOutputBatch({
      artifact: artifact(2),
      limits: { ...limits, fileSizeLimit: 0, totalSizeLimit: 0 },
      prepare,
    });

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        file: expect.objectContaining({ id: 'file-0' }),
        maxBytes: CODE_OUTPUT_PREFLIGHT_MAX_BYTES,
      }),
    );
    expect(
      prepare.mock.calls.every(([input]) => input.maxBytes <= CODE_OUTPUT_PREFLIGHT_MAX_BYTES),
    ).toBe(true);
    expect(result.map((entry) => entry.preparedBuffer?.length)).toEqual(sizes);
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

  describe('concurrent prefetch', () => {
    const MB = 1024 * 1024;
    const largeLimits = { fileLimit: 10, fileSizeLimit: 64 * MB, totalSizeLimit: 64 * MB };

    /** Simulates the Code API: a file larger than the transport cap fails like a capped download. */
    function sizedPrepare(sizes: number[], delayMs = 20) {
      const calls: Array<{ id: string; maxBytes: number }> = [];
      let open = 0;
      let openBytes = 0;
      let peakOpen = 0;
      let peakOpenBytes = 0;
      const prepare = jest.fn(async (input: PrepareCodeOutputInput) => {
        calls.push({ id: input.file.id, maxBytes: input.maxBytes });
        open++;
        openBytes += input.maxBytes;
        peakOpen = Math.max(peakOpen, open);
        peakOpenBytes = Math.max(peakOpenBytes, openBytes);
        try {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          const size = sizes[Number(input.file.id.split('-')[1])];
          if (size > input.maxBytes) {
            throw new Error('maxContentLength exceeded');
          }
          return prepared(input, { buffer: Buffer.alloc(size) });
        } finally {
          open--;
          openBytes -= input.maxBytes;
        }
      });
      return {
        prepare,
        calls,
        peak: () => ({ open: peakOpen, bytes: peakOpenBytes }),
      };
    }

    /** The pre-prefetch algorithm, kept as the reference the batch must match. */
    function serialOutcome(sizes: number[], maxBytes: number, fileSizeLimit: number) {
      let used = 0;
      return sizes.map((size) => {
        const transport = Math.min(maxBytes - used, fileSizeLimit);
        if (transport <= 0) {
          return 'fallback';
        }
        if (size > transport) {
          used += transport;
          return 'fallback';
        }
        used += size;
        return size;
      });
    }

    function outcome(result: Awaited<ReturnType<typeof preflightCodeOutputBatch>>) {
      return result.map((entry) =>
        entry.downloadFallback === true ? 'fallback' : entry.preparedBuffer?.length,
      );
    }

    it('downloads small outputs at the same time and prepares each file once', async () => {
      const sizes = Array.from({ length: 8 }, () => 200 * 1024);
      const { prepare, peak } = sizedPrepare(sizes);

      const result = await preflightCodeOutputBatch({
        artifact: artifact(sizes.length),
        limits: largeLimits,
        prepare,
      });

      expect(outcome(result)).toEqual(sizes);
      expect(prepare).toHaveBeenCalledTimes(sizes.length);
      expect(peak().open).toBe(DEFAULT_LOOKUP_CONCURRENCY.codeOutputDownloads);
    });

    it('never holds more open transport capacity than the batch budget', async () => {
      const sizes = Array.from({ length: 10 }, () => 3 * MB);
      const { prepare, peak } = sizedPrepare(sizes);

      await preflightCodeOutputBatch({
        artifact: artifact(sizes.length),
        limits: largeLimits,
        prepare,
      });

      expect(peak().bytes).toBeLessThanOrEqual(largeLimits.totalSizeLimit);
    });

    it.each([
      ['a file above the prefetch slot', [1 * MB, 20 * MB, 2 * MB, 1 * MB]],
      ['an aggregate above the budget', [30 * MB, 30 * MB, 10 * MB, 1 * MB]],
      ['a file above the per-file limit', [70 * MB, 1 * MB, 1 * MB]],
      ['an exhausted budget before the last file', [40 * MB, 24 * MB, 1 * MB]],
    ])('matches the serial budget outcome for %s', async (_label, sizes) => {
      const { prepare, calls } = sizedPrepare(sizes);

      const result = await preflightCodeOutputBatch({
        artifact: artifact(sizes.length),
        limits: largeLimits,
        prepare,
      });

      expect(outcome(result)).toEqual(serialOutcome(sizes, 64 * MB, 64 * MB));
      const accepted = new Set(
        result.filter((entry) => entry.preparedBuffer != null).map((entry) => entry.file.id),
      );
      for (const id of accepted) {
        expect(calls.filter((call) => call.id === id).length).toBeLessThanOrEqual(2);
      }
    });

    it('releases later prefetched bytes before downloading a large output again', async () => {
      const sizes = [60 * MB, ...Array.from({ length: 9 }, () => 6 * MB)];
      const { prepare, calls } = sizedPrepare(sizes);

      const result = await preflightCodeOutputBatch({
        artifact: artifact(sizes.length),
        limits: largeLimits,
        prepare,
      });

      expect(outcome(result)).toEqual(serialOutcome(sizes, 64 * MB, 64 * MB));
      const fullCapRetry = calls.findIndex(
        (call) => call.id === 'file-0' && call.maxBytes === 64 * MB,
      );
      expect(fullCapRetry).toBeGreaterThan(-1);
      const reusedAfterRetry = result
        .slice(1)
        .filter((entry) => entry.preparedBuffer != null)
        .map((entry) => entry.file.id)
        .filter((id) => !calls.slice(fullCapRetry).some((call) => call.id === id));
      expect(reusedAfterRetry).toEqual([]);
    });

    it('evicts every discarded prefetch from the request cache before the full-cap retry', async () => {
      const sizes = [60 * MB, ...Array.from({ length: 3 }, () => 1 * MB)];
      const req = {};
      const bufferCache = { req, executionRouteKey: 'route' };
      const cachedAtRetry: Array<string | null> = [];
      const { prepare } = sizedPrepare(sizes);
      const caching = jest.fn(async (input: PrepareCodeOutputInput) => {
        if (input.file.id === 'file-0' && input.maxBytes === 64 * MB) {
          for (let index = 1; index < sizes.length; index++) {
            const buffer = getPreparedCodeOutputBuffer({
              ...bufferCache,
              file_path: `file-${index}.txt`,
              files: [
                {
                  id: `file-${index}`,
                  name: `file-${index}.txt`,
                  storage_session_id: `storage-${index}`,
                },
              ],
            });
            cachedAtRetry.push(buffer == null ? null : `file-${index}`);
          }
        }
        const result = await prepare(input);
        cachePreparedCodeOutputBuffer({
          ...bufferCache,
          id: input.file.id,
          name: input.file.name,
          session_id: input.sessionId,
          buffer: result.buffer,
        });
        return result;
      });

      const result = await preflightCodeOutputBatch({
        artifact: artifact(sizes.length),
        limits: largeLimits,
        prepare: caching,
        bufferCache,
      });

      expect(cachedAtRetry).toEqual([null, null, null]);
      expect(outcome(result)).toEqual(serialOutcome(sizes, 64 * MB, 64 * MB));
    });

    it('reports a failed prefetch once, from the budgeted pass, with its original cause', async () => {
      const cause = new Error('code api unavailable');
      const onInspectionUnavailable = jest.fn();
      const prepare = jest.fn(async (input: PrepareCodeOutputInput) => {
        if (input.file.id === 'file-1') {
          throw cause;
        }
        return prepared(input, { buffer: Buffer.alloc(1024) });
      });

      const result = await preflightCodeOutputBatch({
        artifact: artifact(3),
        limits: largeLimits,
        prepare,
        onInspectionUnavailable,
      });

      expect(onInspectionUnavailable).toHaveBeenCalledTimes(1);
      expect(onInspectionUnavailable).toHaveBeenCalledWith(1, cause);
      expect(result[0].preparedBuffer?.length).toBe(1024);
      expect(result[1].downloadFallback).toBe(true);
    });

    it('keeps a batch under active inspection serial and still rejects a blocked file', async () => {
      const filters: FiltersConfig = {
        files: {
          pii: { fields: ['content'], starterPatterns: [], customPatterns: [BLOCK_PATTERN] },
        },
      };
      let open = 0;
      let peakOpen = 0;
      const prepare = jest.fn(async (input: PrepareCodeOutputInput) => {
        open++;
        peakOpen = Math.max(peakOpen, open);
        await new Promise((resolve) => setTimeout(resolve, 5));
        open--;
        return prepared(input, {
          file: {
            ...input.file,
            type: 'text/plain',
            content: input.file.id === 'file-2' ? 'PRIVATE-SECRET' : 'safe',
          },
        });
      });

      await expect(
        preflightCodeOutputBatch({ filters, artifact: artifact(4), limits: largeLimits, prepare }),
      ).rejects.toMatchObject({ code: 'content_filter_block' });
      expect(peakOpen).toBe(1);
      expect(prepare).toHaveBeenCalledTimes(3);
    });

    it('keeps the batch serial when the configured concurrency is one', async () => {
      const sizes = Array.from({ length: 4 }, () => 200 * 1024);
      const { prepare, peak } = sizedPrepare(sizes);

      const result = await preflightCodeOutputBatch({
        artifact: artifact(sizes.length),
        limits: largeLimits,
        prepare,
        concurrency: 1,
      });

      expect(outcome(result)).toEqual(sizes);
      expect(peak().open).toBe(1);
    });

    it('uses the configured concurrency', async () => {
      const sizes = Array.from({ length: 8 }, () => 200 * 1024);
      const { prepare, peak } = sizedPrepare(sizes);

      await preflightCodeOutputBatch({
        artifact: artifact(sizes.length),
        limits: largeLimits,
        prepare,
        concurrency: 2,
      });

      expect(peak().open).toBe(2);
    });
  });
});

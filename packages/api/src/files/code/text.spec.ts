import type { SandboxImageReadResult } from './image';
import { createSandboxTextReader } from './text';

const params = { file_path: '/mnt/data/catalogue.txt', maxBytes: 262_144 };

function fileResult(content: string): SandboxImageReadResult {
  const bytes = Buffer.from(content);
  return { base64: bytes.toString('base64'), bytes: bytes.length };
}

it('preserves the legacy no-budget reader, including errors and request identity', async () => {
  const readFile = jest.fn(async () => ({ content: 'legacy prefix' }));
  const readBytes = jest.fn(async () => fileResult('complete'));
  const read = createSandboxTextReader({ readFile, readBytes });
  const request = { file_path: params.file_path, session_id: 'session-a' };
  expect(await read(request)).toEqual({ content: 'legacy prefix' });
  expect(readFile).toHaveBeenCalledWith(request);
  expect(readBytes).not.toHaveBeenCalled();
  const failure = new Error('transport failed');
  readFile.mockRejectedValueOnce(failure);
  await expect(read(request)).rejects.toBe(failure);
});

it.each(['', 'first\nlast\n', '界'.repeat(60_000)])(
  'decodes complete bounded bytes once for text length %i',
  async (content) => {
    const readFile = jest.fn(async () => null);
    const readBytes = jest.fn(async () => fileResult(content));
    const read = createSandboxTextReader({ readFile, readBytes });
    expect(await read(params)).toEqual({ content, complete: true });
    expect(readBytes).toHaveBeenCalledWith(params);
    expect(readFile).not.toHaveBeenCalled();
  },
);

it.each([
  { base64: 'eA==', bytes: 2 },
  { base64: 'invalid!', bytes: 5 },
  { base64: 'eA==junk', bytes: 4 },
  { base64: Buffer.alloc(262_145).toString('base64'), bytes: 262_145 },
])('refuses malformed, shortened, or over-budget byte retrieval', async (result) => {
  const read = createSandboxTextReader({
    readFile: async () => null,
    readBytes: async () => result,
  });
  await expect(read(params)).rejects.toThrow('retrieval was incomplete');
});

it('refuses non-UTF-8 bytes instead of filtering replacement text', async () => {
  const result = { base64: Buffer.from([0xff, 0xfe]).toString('base64'), bytes: 2 };
  const read = createSandboxTextReader({
    readFile: async () => null,
    readBytes: async () => result,
  });
  await expect(read(params)).rejects.toThrow('not UTF-8 text');
});

it.each(['size', 'round_trips'] as const)(
  'propagates %s limits without treating them as EOF',
  async (reason) => {
    const result = { tooLarge: true as const, reason, bytes: 262_145 };
    const read = createSandboxTextReader({
      readFile: async () => null,
      readBytes: async () => result,
    });
    expect(await read(params)).toEqual(result);
  },
);

it('keeps transport absence distinct from complete empty content', async () => {
  const read = createSandboxTextReader({ readFile: async () => null, readBytes: async () => null });
  expect(await read(params)).toBeNull();
});

it.each([0, -1, 1.5, NaN, Infinity])(
  'rejects an invalid byte budget %s before dispatch',
  async (maxBytes) => {
    const readBytes = jest.fn(async () => null);
    const read = createSandboxTextReader({ readFile: async () => null, readBytes });
    await expect(read({ ...params, maxBytes })).rejects.toThrow(
      'Invalid sandbox text-read byte budget',
    );
    expect(readBytes).not.toHaveBeenCalled();
  },
);

it('does not dispatch an already-aborted ranged read or return bytes after cancellation', async () => {
  const controller = new AbortController();
  const failure = new Error('cancelled');
  const readBytes = jest.fn(async () => fileResult('complete'));
  const read = createSandboxTextReader({ readFile: async () => null, readBytes });
  controller.abort(failure);
  await expect(read({ ...params, signal: controller.signal })).rejects.toBe(failure);
  expect(readBytes).not.toHaveBeenCalled();
  const inFlight = new AbortController();
  readBytes.mockImplementationOnce(async () => {
    inFlight.abort(failure);
    return fileResult('complete');
  });
  await expect(read({ ...params, signal: inFlight.signal })).rejects.toBe(failure);
});

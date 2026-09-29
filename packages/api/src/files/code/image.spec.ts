import crypto from 'crypto';
import type { SandboxImageChunk } from './image';
import {
  buildSandboxImageReaderCode,
  getSandboxImageChunkBytes,
  narrowSandboxImageChunkBytes,
  parseSandboxImageChunk,
  readWindowedSandboxImage,
  MAX_SANDBOX_IMAGE_EXEC_CALLS,
} from './image';

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Reads the window parameters back out of the generated reader script,
 *  the same way the sandbox would. */
function windowParams(code: string): { offset: number; chunk: number; limit: number } {
  const encoded = /payload = ("[^"]+")/.exec(code);
  if (!encoded) {
    throw new Error('reader code carried no payload');
  }
  return JSON.parse(Buffer.from(JSON.parse(encoded[1]), 'base64').toString());
}

/** Serves `buffer` through the windowed reader, recording each window size. */
function serveFile(
  buffer: Buffer,
  options: { acceptedWindow?: number; reportsCap?: boolean } = {},
) {
  const windows: number[] = [];
  const readChunk = async ({ code }: { code: string }): Promise<SandboxImageChunk> => {
    const { offset, chunk, limit } = windowParams(code);
    windows.push(chunk);
    if (options.acceptedWindow != null && chunk > options.acceptedWindow) {
      /* Report the cap the way a runner does: by truncating at it. */
      return {
        outputOverflow: true,
        observedStdoutBytes: options.reportsCap === false ? undefined : options.acceptedWindow,
      };
    }
    if (buffer.length > limit) {
      return { too_large: true, bytes: buffer.length };
    }
    const slice = buffer.subarray(offset, offset + chunk);
    return { total: buffer.length, n: slice.length, b64: slice.toString('base64') };
  };
  return { readChunk, windows };
}

describe('sandbox image window sizing', () => {
  const envKeys = ['LIBRECHAT_CODE_IMAGE_CHUNK_BYTES', 'LIBRECHAT_CODE_SANDBOX_OUTPUT_MAX_SIZE'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of envKeys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] == null) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  it('fills the default 64KB stdout budget without exceeding it', () => {
    const window = getSandboxImageChunkBytes('https://default.example.com');
    /* base64 is 4 bytes per 3, and the reader wraps it in a JSON envelope. */
    const encoded = Math.ceil(window / 3) * 4;
    expect(window % 3).toBe(0);
    expect(encoded).toBeLessThan(64 * 1024);
  });

  it('derives a window a small runner can actually emit', () => {
    /* An 8KB cap used to floor at an 8KB window, whose base64 alone is
     * ~10.9KB — every read overflowed, and narrowing was pinned to the
     * same floor, so no retry could ever succeed. */
    process.env.LIBRECHAT_CODE_SANDBOX_OUTPUT_MAX_SIZE = String(8 * 1024);
    const window = getSandboxImageChunkBytes('https://small.example.com');
    expect(Math.ceil(window / 3) * 4).toBeLessThan(8 * 1024);
  });

  it('uses an explicit chunk override verbatim', () => {
    process.env.LIBRECHAT_CODE_IMAGE_CHUNK_BYTES = '1024';
    expect(getSandboxImageChunkBytes('https://override.example.com')).toBe(1024);
  });

  it('narrows per base URL, and never past an explicit override', () => {
    const url = 'https://narrowing.example.com';
    const before = getSandboxImageChunkBytes(url);
    const narrowed = narrowSandboxImageChunkBytes(before, url);

    expect(narrowed).not.toBeNull();
    expect(narrowed).toBeLessThan(before);
    expect(getSandboxImageChunkBytes(url)).toBe(narrowed);
    expect(getSandboxImageChunkBytes('https://untouched.example.com')).toBe(before);

    process.env.LIBRECHAT_CODE_IMAGE_CHUNK_BYTES = '512';
    expect(getSandboxImageChunkBytes(url)).toBe(512);
  });

  it("halves the caller's own failing window, not the shared learned value", () => {
    /* Reads run concurrently (one per tool call). Two reads failing at the
     * same size used to halve the shared value twice, skipping a size the
     * runner would have accepted and persisting it for later reads. */
    const url = 'https://concurrent.example.com';
    const window = getSandboxImageChunkBytes(url);

    const first = narrowSandboxImageChunkBytes(window, url);
    const second = narrowSandboxImageChunkBytes(window, url);

    expect(second).toBe(first);
    expect(getSandboxImageChunkBytes(url)).toBe(first);
  });

  it('sizes the retry from the cap a truncated response revealed', () => {
    /* Blind halving from ~49KB needs eight round-trips to reach a 1KB
     * runner — most of the call budget spent on discovery. The truncated
     * response already measured the cap, so one retry lands. */
    const url = 'https://measured.example.com';
    const window = getSandboxImageChunkBytes(url);

    const narrowed = narrowSandboxImageChunkBytes(window, url, 1024);

    expect(narrowed).not.toBeNull();
    expect(Math.ceil((narrowed as number) / 3) * 4).toBeLessThan(1024);
  });

  it('keeps narrowing until an unconfigured small runner is reachable', () => {
    /* A ~1KB stdout cap is a real runner default. A floor above it declared
     * every image unreadable even though small ones fit. */
    const url = 'https://tiny-cap.example.com';
    let window: number | null = getSandboxImageChunkBytes(url);
    let attempts = 0;
    while (window != null && Math.ceil(window / 3) * 4 + 256 > 1024) {
      attempts++;
      window = narrowSandboxImageChunkBytes(window, url);
    }
    expect(window).not.toBeNull();
    expect(attempts).toBeLessThan(MAX_SANDBOX_IMAGE_EXEC_CALLS);
  });

  it('stops once no smaller window exists', () => {
    expect(narrowSandboxImageChunkBytes(3, 'https://floor.example.com')).toBeNull();
  });
});

describe('parseSandboxImageChunk', () => {
  it('reports a truncated response as an overflow, not garbled output', () => {
    /* The runner truncates stdout and SIGKILLs with status `OL`; parsing
     * the clipped base64 would report a misleading "unexpected output"
     * instead of the narrowable cause. */
    const stdout = '{"total":999999,"n":32768,"b64":"iVBORw0KGg';
    const chunk = parseSandboxImageChunk({ stdout, status: 'OL' });
    /* What survived is exactly what the runner allows, so it measures the
     * cap this deployment never declared. */
    expect(chunk).toEqual({ outputOverflow: true, observedStdoutBytes: stdout.length });
  });

  it('parses the reader JSON even when the shell emits a banner first', () => {
    const chunk = parseSandboxImageChunk({
      stdout: `motd banner\n${JSON.stringify({ total: 3, n: 3, b64: 'AAAA' })}`,
    });
    expect(chunk).toEqual({ total: 3, n: 3, b64: 'AAAA' });
  });

  it('surfaces stderr when the runner produced no stdout', () => {
    expect(() => parseSandboxImageChunk({ stderr: 'python3: not found', stdout: '' })).toThrow(
      /python3: not found/,
    );
  });

  it('names unparseable output rather than returning junk', () => {
    expect(() => parseSandboxImageChunk({ stdout: 'not json at all' })).toThrow(
      /Unexpected output/,
    );
  });

  it('returns an empty chunk when the runner printed nothing', () => {
    expect(parseSandboxImageChunk({ stdout: '   ' })).toEqual({});
  });
});

describe('readWindowedSandboxImage', () => {
  const limit = 1024 * 1024;

  it('reassembles an image larger than one window, byte-for-byte', async () => {
    const source = Buffer.concat([PNG_HEADER, crypto.randomBytes(200 * 1024)]);
    const { readChunk, windows } = serveFile(source);

    const result = await readWindowedSandboxImage({
      filePath: '/mnt/data/big.png',
      baseUrl: 'https://assembly.example.com',
      limit,
      readChunk,
    });

    expect(windows.length).toBeGreaterThan(1);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({ bytes: source.length });
    const base64 = (result as { base64: string }).base64;
    expect(Buffer.from(base64, 'base64').equals(source)).toBe(true);
  });

  it('reads a single-window image in one round-trip', async () => {
    const source = Buffer.concat([PNG_HEADER, crypto.randomBytes(1024)]);
    const { readChunk, windows } = serveFile(source);

    const result = await readWindowedSandboxImage({
      filePath: '/mnt/data/small.png',
      baseUrl: 'https://single.example.com',
      limit,
      readChunk,
    });

    expect(windows).toHaveLength(1);
    expect(Buffer.from((result as { base64: string }).base64, 'base64').equals(source)).toBe(true);
  });

  it('narrows the window and re-reads the same offset when the runner truncates', async () => {
    const source = Buffer.concat([PNG_HEADER, crypto.randomBytes(8 * 1024)]);
    const acceptedWindow = 32 * 1024;
    const { readChunk, windows } = serveFile(source, { acceptedWindow });

    const result = await readWindowedSandboxImage({
      filePath: '/mnt/data/x.png',
      baseUrl: 'https://truncating.example.com',
      limit,
      readChunk,
    });

    expect(windows[0]).toBeGreaterThan(acceptedWindow);
    expect(windows[1]).toBeLessThanOrEqual(acceptedWindow);
    expect(Buffer.from((result as { base64: string }).base64, 'base64').equals(source)).toBe(true);
  });

  it('reads a small image from a runner with a ~1KB stdout cap', async () => {
    /* A 1KB cap is a real runner default. Discovery has to reach a window
     * that small, and the truncated response says how small in one step. */
    const cap = 1024;
    const source = Buffer.concat([PNG_HEADER, crypto.randomBytes(3 * 1024)]);
    let calls = 0;
    const readChunk = async ({ code }: { code: string }): Promise<SandboxImageChunk> => {
      calls++;
      const { offset, chunk } = windowParams(code);
      const slice = source.subarray(offset, offset + chunk);
      const encoded = Math.ceil(slice.length / 3) * 4 + 64;
      if (encoded > cap) {
        return { outputOverflow: true, observedStdoutBytes: cap };
      }
      return { total: source.length, n: slice.length, b64: slice.toString('base64') };
    };

    const result = await readWindowedSandboxImage({
      filePath: '/mnt/data/icon.png',
      baseUrl: 'https://kilobyte.example.com',
      limit,
      readChunk,
    });

    expect(Buffer.from((result as { base64: string }).base64, 'base64').equals(source)).toBe(true);
    expect(calls).toBeLessThanOrEqual(MAX_SANDBOX_IMAGE_EXEC_CALLS);
  });

  it('names the stdout limit when every narrowed window still overflows', async () => {
    const readChunk = async (): Promise<SandboxImageChunk> => ({ outputOverflow: true });

    await expect(
      readWindowedSandboxImage({
        filePath: '/mnt/data/big.png',
        baseUrl: 'https://always-overflows.example.com',
        limit,
        readChunk,
      }),
    ).rejects.toThrow(/exceeded the sandbox stdout limit/);
  });

  it('refuses an oversize file in-sandbox without transferring bytes', async () => {
    let calls = 0;
    const readChunk = async (): Promise<SandboxImageChunk> => {
      calls++;
      return { too_large: true, bytes: 9 * 1024 * 1024 };
    };

    const result = await readWindowedSandboxImage({
      filePath: '/mnt/data/huge.png',
      baseUrl: 'https://oversize.example.com',
      limit,
      readChunk,
    });

    expect(result).toEqual({ tooLarge: true, reason: 'size', bytes: 9 * 1024 * 1024 });
    expect(calls).toBe(1);
  });

  it('gives up from the first window rather than draining the limiter', async () => {
    /* The first response reveals the file size, so a read that cannot
     * finish within the round-trip ceiling is known immediately — spending
     * the rest of the limiter window to rediscover it would leave the turn
     * with no executions left. */
    const source = crypto.randomBytes(64 * 1024);
    let calls = 0;
    const readChunk = async ({ code }: { code: string }): Promise<SandboxImageChunk> => {
      calls++;
      const { offset } = windowParams(code);
      const slice = source.subarray(offset, offset + 300);
      return { total: source.length, n: slice.length, b64: slice.toString('base64') };
    };

    const result = await readWindowedSandboxImage({
      filePath: '/mnt/data/slow.png',
      baseUrl: 'https://ceiling.example.com',
      limit,
      readChunk,
    });

    expect(calls).toBe(1);
    expect(result).toEqual({
      tooLarge: true,
      reason: 'round_trips',
      bytes: source.length,
      /* What this deployment could actually deliver: 300 bytes a call for
       * the whole round-trip budget. The caller names it as a downscale
       * target instead of leaving the model to guess. */
      inlineCeiling: 300 * MAX_SANDBOX_IMAGE_EXEC_CALLS,
    });
  });

  it('reads a file that exactly fills the round-trip ceiling', async () => {
    const window = getSandboxImageChunkBytes('https://exact.example.com');
    const source = crypto.randomBytes(window * MAX_SANDBOX_IMAGE_EXEC_CALLS);
    const { readChunk, windows } = serveFile(source);

    const result = await readWindowedSandboxImage({
      filePath: '/mnt/data/exact.png',
      baseUrl: 'https://exact.example.com',
      limit: source.length,
      readChunk,
    });

    expect(windows).toHaveLength(MAX_SANDBOX_IMAGE_EXEC_CALLS);
    expect(Buffer.from((result as { base64: string }).base64, 'base64').equals(source)).toBe(true);
  });

  it('refuses to splice a file that changed mid-read', async () => {
    let call = 0;
    const readChunk = async ({ code }: { code: string }): Promise<SandboxImageChunk> => {
      const { chunk } = windowParams(code);
      call++;
      /* Second window reports a different size: the assembled buffer would
       * be a mix of two versions rather than any real image. */
      return {
        total: call === 1 ? chunk * 3 : chunk * 4,
        n: chunk,
        b64: Buffer.alloc(chunk).toString('base64'),
      };
    };

    await expect(
      readWindowedSandboxImage({
        filePath: '/mnt/data/moving.png',
        baseUrl: 'https://changing.example.com',
        limit,
        readChunk,
      }),
    ).rejects.toThrow(/changed while being read/);
  });

  it('surfaces the in-sandbox reader error for a path it refused', async () => {
    const readChunk = async (): Promise<SandboxImageChunk> => ({
      error: "[Errno 2] No such file or directory: '/mnt/data/gone.png'",
    });

    await expect(
      readWindowedSandboxImage({
        filePath: '/mnt/data/gone.png',
        baseUrl: 'https://missing.example.com',
        limit,
        readChunk,
      }),
    ).rejects.toThrow(/No such file or directory/);
  });

  it('returns null when the runner produced no output', async () => {
    const readChunk = async (): Promise<SandboxImageChunk> => ({});

    await expect(
      readWindowedSandboxImage({
        filePath: '/mnt/data/quiet.png',
        baseUrl: 'https://silent.example.com',
        limit,
        readChunk,
      }),
    ).resolves.toBeNull();
  });
});

describe('buildSandboxImageReaderCode', () => {
  it('carries the window parameters base64-encoded, never as shell syntax', () => {
    const code = buildSandboxImageReaderCode({
      filePath: `/mnt/data/'; rm -rf /; '.png`,
      limit: 1024,
      offset: 96,
      chunkBytes: 48,
    });

    expect(code).not.toContain('rm -rf');
    expect(windowParams(code)).toEqual({
      file_path: `/mnt/data/'; rm -rf /; '.png`,
      limit: 1024,
      offset: 96,
      chunk: 48,
    });
  });
});

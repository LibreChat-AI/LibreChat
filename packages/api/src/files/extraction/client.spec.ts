import { join } from 'node:path';
import { request } from 'node:http';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { request as secureRequest } from 'node:https';
import { createDocumentExtractor, ExtractionServiceError } from './client';
import { capabilities, fixture, reply, result } from './fixture.helper';

const bytes = Buffer.from('%PDF-exact bytes');

describe('document extraction authenticated HTTP client', () => {
  let server: Awaited<ReturnType<typeof fixture>> | undefined;
  beforeEach(() => {
    server = undefined;
  });
  afterEach(async () => server?.close());

  it.each([undefined, {}])(
    'constructs the required client with absent/empty config: %j',
    (config) => {
      expect(createDocumentExtractor(config)).toMatchObject({
        maxInputBytes: 10485760,
        deadlineMs: 12000,
        extract: expect.any(Function),
      });
    },
  );

  it.each([false, true])('rejects the removed enablement field (%s)', (enabled) => {
    const config = { url: 'http://extraction:8000' };
    Object.assign(config, { enabled });
    expect(() => createDocumentExtractor(config)).toThrow(
      'Document extraction failed (INVALID_CONFIG).',
    );
  });

  it.each(['pdf', 'docx'] as const)(
    'sends fixed raw-byte %s framing and preserves segments',
    async (format) => {
      const posts: Buffer[] = [];
      let requests = 0;
      server = await fixture((req, res) => {
        expect(req.headers.authorization).toBe(`Bearer ${server!.token}`);
        requests++;
        if (req.url === '/v1/capabilities') return reply(res, capabilities);
        expect(req.method).toBe('POST');
        expect(req.url).toBe('/v1/extract-text');
        expect(req.headers['content-type']).toBe('application/octet-stream');
        expect(req.headers['content-length']).toBe(String(bytes.length));
        expect(req.headers['transfer-encoding']).toBeUndefined();
        expect(req.headers['x-extraction-version']).toBe('1');
        expect(req.headers['x-extraction-format']).toBe(format);
        req.on('data', (chunk: Buffer) => posts.push(chunk));
        req.on('end', () => reply(res, result(Buffer.concat(posts), format)));
      });
      const client = createDocumentExtractor({ url: server.url, tokenFile: server.tokenFile })!;
      await expect(client.extract(bytes, format)).resolves.toEqual(result(bytes, format));
      expect(Buffer.concat(posts)).toEqual(bytes);
      expect(requests).toBe(2);
    },
  );

  it('snapshots mutable input before negotiating capabilities', async () => {
    const input = Buffer.from(bytes);
    server = await fixture((req, res) => {
      if (req.url === '/v1/capabilities') {
        input.fill(0);
        return reply(res, capabilities);
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => reply(res, result(Buffer.concat(chunks))));
    });
    await expect(
      createDocumentExtractor({ url: server.url, tokenFile: server.tokenFile })!.extract(
        input,
        'pdf',
      ),
    ).resolves.toEqual(result(bytes));
  });

  it.each([
    { ...capabilities, version: 2 },
    { ...capabilities, operation: 'exec' },
    { ...capabilities, formats: ['pdf'] },
    { ...capabilities, structure: null },
    { ...capabilities, limitations: { pdf: '', docx: 'body' } },
    { ...capabilities, limits: { ...capabilities.limits, inputBytes: 10485761 } },
    { ...capabilities, limits: { ...capabilities.limits, concurrency: 0 } },
  ])('rejects incompatible capabilities before upload: %j', async (caps) => {
    let posts = 0;
    server = await fixture((req, res) => {
      if (req.method === 'POST') posts++;
      reply(res, caps);
    });
    await expect(
      createDocumentExtractor({ url: server.url, tokenFile: server.tokenFile })!.extract(
        bytes,
        'pdf',
      ),
    ).rejects.toMatchObject({ code: 'INCOMPATIBLE_SERVICE' });
    expect(posts).toBe(0);
  });

  it.each([
    ['BUSY', 429],
    ['UNSUPPORTED_CONTENT', 422],
    ['UNAVAILABLE', 503],
    ['DEADLINE', 504],
    ['INPUT_LIMIT', 413],
    ['INVALID_REQUEST', 400],
  ] as const)('exposes only approved %s errors without retries', async (code, status) => {
    let posts = 0;
    server = await fixture((req, res) => {
      if (req.method === 'GET') return reply(res, capabilities);
      posts++;
      req.resume();
      reply(res, { error: { code } }, status);
    });
    await expect(
      createDocumentExtractor({ url: server.url, tokenFile: server.tokenFile })!.extract(
        bytes,
        'pdf',
      ),
    ).rejects.toMatchObject({ code });
    expect(posts).toBe(1);
  });

  it.each(['missing', 'directory', 'fifo', 'short', 'oversized', 'uppercase', 'newline', 'binary'])(
    'rejects %s credentials safely before connecting',
    async (kind) => {
      let connections = 0;
      server = await fixture(() => {
        connections++;
      });
      const path = join(server.dir, 'credential');
      if (kind === 'directory') await fs.mkdir(path);
      else if (kind === 'fifo') execFileSync('mkfifo', [path]);
      else if (kind !== 'missing')
        await fs.writeFile(
          path,
          {
            short: 'a'.repeat(63),
            oversized: 'a'.repeat(65),
            uppercase: 'A'.repeat(64),
            newline: 'a'.repeat(64) + '\n',
            binary: Buffer.alloc(64, 0xe1),
          }[kind]!,
        );
      await expect(
        createDocumentExtractor({ url: server.url, tokenFile: path, deadlineMs: 100 }).extract(
          bytes,
          'pdf',
        ),
      ).rejects.toThrow(
        'Document extraction is unavailable. Start the extraction companion and verify the endpoint, processor credential and Landlock ABI 3 support.',
      );
      expect(connections).toBe(0);
    },
  );

  it('rereads rotated credentials on the next extraction, not between capability and upload', async () => {
    server = await fixture((req, res) => {
      req.resume();
      if (req.method === 'GET') {
        void fs.writeFile(server!.tokenFile, 'b'.repeat(64)).then(() => reply(res, capabilities));
        return;
      }
      reply(res, result(bytes));
    });
    const client = createDocumentExtractor({ url: server.url, tokenFile: server.tokenFile });
    await expect(client.extract(bytes, 'pdf')).resolves.toEqual(result(bytes));
    await expect(client.extract(bytes, 'pdf')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it.each(['capabilities', 'extraction'])(
    'maps unauthorized %s to service unavailability, never user authentication',
    async (stage) => {
      let posts = 0;
      server = await fixture((req, res) => {
        req.resume();
        if (stage === 'extraction' && req.method === 'GET') return reply(res, capabilities);
        if (req.method === 'POST') posts++;
        reply(res, { error: { code: 'UNAUTHORIZED' } }, 401);
      });
      await expect(
        createDocumentExtractor({ url: server.url, tokenFile: server.tokenFile }).extract(
          bytes,
          'pdf',
        ),
      ).rejects.toMatchObject({
        code: 'UNAVAILABLE',
        userErrorStatusCode: 503,
        message: expect.stringContaining('processor credential'),
      });
      expect(posts).toBe(stage === 'capabilities' ? 0 : 1);
    },
  );

  it.each([301, 302, 307, 308])(
    'never follows a %s redirect or forwards credentials',
    async (status) => {
      let requests = 0;
      server = await fixture((_req, res) => {
        requests++;
        res.setHeader('Location', 'https://untrusted.example/v1/extract-text');
        reply(res, { error: { code: 'UNAVAILABLE' } }, status);
      });
      await expect(
        createDocumentExtractor({ url: server.url, tokenFile: server.tokenFile }).extract(
          bytes,
          'pdf',
        ),
      ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
      expect(requests).toBe(1);
    },
  );

  it.each(['deadline', 'cancellation'])(
    'drains a stalled credential read on %s before connecting',
    async (kind) => {
      let connections = 0;
      server = await fixture(() => {
        connections++;
      });
      const controller = new AbortController();
      const fsModule = jest.requireActual<typeof fs>('node:fs/promises');
      const originalOpen = fsModule.open;
      let opened: Awaited<ReturnType<typeof fs.open>> | undefined;
      const spy = jest.spyOn(fsModule, 'open').mockImplementation(async (...args) => {
        const handle = await originalOpen(...args);
        opened = handle;
        const originalStream = handle.createReadStream;
        jest.spyOn(handle, 'createReadStream').mockImplementation((options) => {
          const stream = originalStream.call(handle, options);
          jest.spyOn(stream, '_read').mockImplementation(() => {
            if (kind === 'cancellation') controller.abort();
          });
          return stream;
        });
        return handle;
      });
      try {
        await expect(
          createDocumentExtractor({
            url: server.url,
            tokenFile: server.tokenFile,
            deadlineMs: 50,
          }).extract(bytes, 'pdf', controller.signal),
        ).rejects.toMatchObject({ code: kind === 'deadline' ? 'DEADLINE' : 'CANCELLED' });
        expect(opened?.fd).toBe(-1);
        expect(connections).toBe(0);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it('includes connecting in the whole deadline and drains the request', async () => {
    server = await fixture(() => {});
    const client = createDocumentExtractor(
      { url: 'https://unresolved.example', tokenFile: server.tokenFile, deadlineMs: 50 },
      (options, callback) => request({ ...options, protocol: 'http:', lookup: () => {} }, callback),
    );
    await expect(client.extract(bytes, 'pdf')).rejects.toMatchObject({ code: 'DEADLINE' });
  });

  it('verifies TLS certificates and hostnames, with no insecure production option', async () => {
    server = await fixture(() => {});
    const dir = server.dir;
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
      ],
      { stdio: 'ignore' },
    );
    const key = await fs.readFile(join(dir, 'key.pem'));
    const cert = await fs.readFile(join(dir, 'cert.pem'));
    await server.close();
    server = await fixture(
      (req, res) => {
        req.resume();
        reply(res, req.method === 'GET' ? capabilities : result(bytes));
      },
      { key, cert },
    );
    const config = {
      url: server.url.replace('127.0.0.1', 'localhost'),
      tokenFile: server.tokenFile,
    };
    await expect(createDocumentExtractor(config).extract(bytes, 'pdf')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    // The test trusts only its synthetic CA, preserving native certificate and hostname verification.
    const trusted: NonNullable<Parameters<typeof createDocumentExtractor>[1]> = (
      options,
      callback,
    ) => {
      expect(options.rejectUnauthorized).toBe(true);
      return secureRequest({ ...options, ca: cert }, callback);
    };
    await expect(createDocumentExtractor(config, trusted).extract(bytes, 'pdf')).resolves.toEqual(
      result(bytes),
    );
    await expect(
      createDocumentExtractor({ ...config, url: server.url }, trusted).extract(bytes, 'pdf'),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('includes the TLS handshake in the deadline and closes the connection', async () => {
    server = await fixture(() => {});
    let closed: Promise<void> = Promise.resolve();
    const listener = createServer((socket) => {
      socket.resume();
      closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    });
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    try {
      await expect(
        createDocumentExtractor({
          url: `https://127.0.0.1:${address.port}`,
          tokenFile: server.tokenFile,
          deadlineMs: 100,
        }).extract(bytes, 'pdf'),
      ).rejects.toMatchObject({ code: 'DEADLINE' });
      await closed;
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });

  const valid = result(bytes);
  it.each([
    { ...valid, inputSha256: '0'.repeat(64) },
    { ...valid, version: 2 },
    { ...valid, operation: 'exec' },
    { ...valid, format: 'docx' },
    { ...valid, path: '/secret' },
    { ...valid, textBytes: 3 },
    { ...valid, textBytes: 0, segments: [] },
    { ...valid, segments: [{ ...valid.segments[0], index: 0 }] },
    { ...valid, segments: [{ ...valid.segments[0], kind: 'document' }] },
    { ...valid, segments: [{ ...valid.segments[0], text: '\ud800' }] },
    { ...valid, segments: [{ ...valid.segments[0], text: '\udc00' }] },
    { ...valid, segments: [{ ...valid.segments[0], extra: true }] },
    Buffer.from([0xff]),
    Buffer.from('{'),
  ])('rejects malformed or unbound results: %j', async (value) => {
    server = await fixture((req, res) => {
      req.resume();
      reply(res, req.method === 'GET' ? capabilities : value);
    });
    await expect(
      createDocumentExtractor({ url: server.url, tokenFile: server.tokenFile })!.extract(
        bytes,
        'pdf',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it.each([{ maxTextBytes: 6 }, { maxResponseBytes: 32 }, { maxSegments: 1 }])(
    'enforces lowered client output limits %j',
    async (limits) => {
      const value = {
        ...valid,
        textBytes: 14,
        segments: [valid.segments[0], { ...valid.segments[0], index: 2 }],
      };
      server = await fixture((req, res) => {
        req.resume();
        reply(res, req.method === 'GET' ? capabilities : value);
      });
      await expect(
        createDocumentExtractor({
          url: server.url,
          tokenFile: server.tokenFile,
          ...limits,
        })!.extract(bytes, 'pdf'),
      ).rejects.toBeInstanceOf(ExtractionServiceError);
    },
  );

  it('rejects DOCX multi-segment output', async () => {
    const value = result(bytes, 'docx');
    value.segments.push({ ...value.segments[0], index: 2 });
    server = await fixture((req, res) => {
      req.resume();
      reply(res, req.method === 'GET' ? capabilities : value);
    });
    await expect(
      createDocumentExtractor({ url: server.url, tokenFile: server.tokenFile })!.extract(
        bytes,
        'docx',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('rejects empty/oversized inputs and unsupported format before connecting', async () => {
    const client = createDocumentExtractor({ maxInputBytes: 2 })!;
    await expect(client.extract(Buffer.alloc(0), 'pdf')).rejects.toMatchObject({
      code: 'INPUT_LIMIT',
    });
    await expect(client.extract(bytes, 'pdf')).rejects.toMatchObject({ code: 'INPUT_LIMIT' });
    await expect(client.extract(Buffer.from('x'), 'odt' as 'pdf')).rejects.toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
    });
  });

  it.each(['capabilities', 'upload', 'delivery'])(
    'bounds the full %s stage with a deadline',
    async (stage) => {
      server = await fixture((req, res) => {
        if (req.method === 'GET') {
          if (stage !== 'capabilities') reply(res, capabilities);
          return;
        }
        if (stage === 'upload') return req.pause();
        req.resume();
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': 1000,
        });
        res.write('{');
      });
      await expect(
        createDocumentExtractor({
          url: server.url,
          tokenFile: server.tokenFile,
          deadlineMs: 100,
        })!.extract(Buffer.alloc(stage === 'upload' ? 10485760 : 1, 1), 'pdf'),
      ).rejects.toMatchObject({ code: 'DEADLINE' });
    },
  );

  it.each(['capabilities', 'upload', 'delivery'])(
    'cancels during %s without retry',
    async (stage) => {
      const controller = new AbortController();
      server = await fixture((req, res) => {
        if (req.method === 'GET') {
          if (stage === 'capabilities') controller.abort();
          else reply(res, capabilities);
          return;
        }
        if (stage === 'delivery') {
          req.resume();
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': 1000,
          });
          res.write('{');
        }
        controller.abort();
      });
      await expect(
        createDocumentExtractor({ url: server.url, tokenFile: server.tokenFile })!.extract(
          Buffer.alloc(stage === 'upload' ? 10485760 : 1, 1),
          'pdf',
          controller.signal,
        ),
      ).rejects.toMatchObject({ code: 'CANCELLED' });
    },
  );

  it('never forwards arbitrary provider details', async () => {
    server = await fixture((req, res) => {
      req.resume();
      reply(
        res,
        req.method === 'GET' ? capabilities : { error: { code: 'SECRET-content' } },
        req.method === 'GET' ? 200 : 500,
      );
    });
    await expect(
      createDocumentExtractor({ url: server.url, tokenFile: server.tokenFile })!.extract(
        bytes,
        'pdf',
      ),
    ).rejects.toThrow('Document extraction failed (INVALID_RESPONSE).');
  });
});

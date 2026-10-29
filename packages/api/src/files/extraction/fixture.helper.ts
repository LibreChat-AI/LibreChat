import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createSecureServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { ServerOptions } from 'node:https';

export const capabilities = {
  version: 1,
  operation: 'document.extract-text',
  formats: ['pdf', 'docx'],
  structure: {
    pdf: 'ordered pages, one-based index',
    docx: 'document body, paragraphs and tables',
  },
  limitations: { pdf: 'text only', docx: 'body paragraphs and tables only' },
  limits: {
    inputBytes: 10485760,
    textBytes: 1048576,
    resultBytes: 3145728,
    deadlineMs: 10000,
    maxSegments: 128,
    concurrency: 2,
    expandedBytes: 33554432,
    archiveEntries: 512,
    tableColumns: 512,
  },
};
export function result(bytes: Buffer, format = 'pdf') {
  return {
    version: 1,
    operation: 'document.extract-text',
    format,
    inputSha256: createHash('sha256').update(bytes).digest('hex'),
    textBytes: 7,
    segments: [{ kind: format === 'pdf' ? 'page' : 'document', index: 1, text: '你好!' }],
  };
}
export function reply(res: ServerResponse, value: unknown, status = 200): void {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': bytes.length,
  });
  res.end(bytes);
}
export async function fixture(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  tls?: ServerOptions,
) {
  const dir = await mkdtemp(join(tmpdir(), 'extract-'));
  const tokenFile = join(dir, 'token');
  const token = 'a1'.repeat(32);
  await writeFile(tokenFile, token);
  const sockets = new Set<Socket>();
  const authenticated = (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers.authorization !== `Bearer ${token}`)
      return reply(res, { error: { code: 'UNAUTHORIZED' } }, 401);
    handler(req, res);
  };
  const server = tls ? createSecureServer(tls, authenticated) : createServer(authenticated);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    dir,
    tokenFile,
    token,
    url: `${tls ? 'https' : 'http'}://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(dir, { recursive: true });
    },
  };
}

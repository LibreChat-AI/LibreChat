import { join } from 'node:path';
import { Readable } from 'node:stream';
import * as fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { resolveUploadFallbackText } from '../upload/fallback';
import { preflightCodeOutputBatch } from '../code/preflight';
import { resolveUploadDocumentText } from './upload';
import { withExtractionLifetime } from './lifetime';
import { fixture } from './fixture.helper';

const file = {
  originalname: 'input.pdf',
  mimetype: 'application/pdf',
  buffer: Buffer.from('pdf'),
} as Express.Multer.File;
const fallback = jest.fn(async () => ({ text: 'local parser' }));
const inputs = {
  file,
  extractOCR: fallback,
  extractConfiguredText: fallback,
  extractDocument: fallback,
  onFailure: jest.fn(),
};

describe('extraction owner lifetime', () => {
  afterEach(() => jest.restoreAllMocks());

  it('does not treat a fully received request close or successful response finish as cancellation', async () => {
    const request = new EventEmitter();
    const response = Object.assign(new EventEmitter(), { writableFinished: false });
    const value = await withExtractionLifetime({ request, response }, async (signal) => {
      request.emit('close');
      response.writableFinished = true;
      response.emit('close');
      expect(signal.aborted).toBe(false);
      return 'received';
    });
    expect(value).toBe('received');
    expect(request.listenerCount('aborted')).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
  });

  it('rejects an already closed owner before reading input or connecting', async () => {
    const run = jest.fn();
    await expect(
      withExtractionLifetime({ response: { destroyed: true, writableFinished: false } }, run),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(run).not.toHaveBeenCalled();
  });

  it('uses one deadline for a stalled disk read and never starts remote extraction', async () => {
    const server = await fixture(() => {
      throw new Error('must not connect');
    });
    let stream: Readable | undefined;
    let opened: Awaited<ReturnType<typeof fs.open>> | undefined;
    const fsModule = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
    const originalOpen = fsModule.open;
    const path = join(server.dir, 'input.pdf');
    await fs.writeFile(path, 'pdf');
    jest.spyOn(fsModule, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      opened = handle;
      const createReadStream = handle.createReadStream;
      jest.spyOn(handle, 'createReadStream').mockImplementation((options) => {
        const reader = createReadStream.call(handle, options);
        jest.spyOn(reader, '_read').mockImplementation(() => {});
        stream = reader;
        return reader;
      });
      return handle;
    });
    const extract = jest.fn();
    const { buffer: _buffer, ...diskFile } = file;
    try {
      await expect(
        resolveUploadDocumentText({
          ...inputs,
          file: { ...diskFile, path } as Express.Multer.File,
          extractor: { maxInputBytes: 1024, deadlineMs: 30, extract },
        }),
      ).rejects.toMatchObject({ code: 'DEADLINE' });
      expect(stream?.destroyed).toBe(true);
      expect(stream?.closed).toBe(true);
      expect(opened?.fd).toBe(-1);
      expect(extract).not.toHaveBeenCalled();
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('does not report cancellation settled until underlying work has completed cleanup', async () => {
    const controller = new AbortController();
    let release: () => void = () => {};
    let settled = false;
    const pending = withExtractionLifetime({ signal: controller.signal }, async (signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            release = () => reject(signal.reason);
          },
          { once: true },
        );
      });
    });
    const outcome = pending.catch((error) => {
      settled = true;
      return error;
    });
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(outcome).resolves.toMatchObject({ code: 'CANCELLED' });
    expect(settled).toBe(true);
  });

  it('does not block opening a FIFO disguised as an upload', async () => {
    const server = await fixture(() => {});
    const path = join(server.dir, 'fifo.pdf');
    execFileSync('mkfifo', [path]);
    const { buffer: _buffer, ...diskFile } = file;
    try {
      await expect(
        resolveUploadDocumentText({
          ...inputs,
          file: { ...diskFile, path } as Express.Multer.File,
          extractor: { maxInputBytes: 1024, deadlineMs: 100, extract: jest.fn() },
        }),
      ).rejects.toMatchObject({ code: 'INPUT_UNAVAILABLE' });
    } finally {
      await server.close();
    }
  });

  it('keeps optional deadline failure best effort but never swallows owner cancellation', async () => {
    const controller = new AbortController();
    const response = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableFinished: false,
    });
    const server = await fixture((req) => {
      req.resume();
      controller.abort();
    });
    try {
      await expect(
        resolveUploadFallbackText({
          file,
          fileId: 'file',
          deliveryPath: 'none',
          destinationChosen: false,
          isMessageAttachment: true,
          endpointConfig: { textFallbackWithoutTools: true },
          signal: controller.signal,
          response,
          extractionService: { url: server.url, tokenFile: server.tokenFile },
        }),
      ).rejects.toMatchObject({ code: 'CANCELLED' });
      const deadlined = await resolveUploadFallbackText({
        file,
        fileId: 'file',
        deliveryPath: 'none',
        destinationChosen: false,
        isMessageAttachment: true,
        endpointConfig: { textFallbackWithoutTools: true },
        extractionService: { url: server.url, tokenFile: server.tokenFile, deadlineMs: 30 },
      });
      expect(deadlined).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it.each([false, true])(
    'does not convert run abort into a persistable compatibility fallback (strict=%s)',
    async (strict) => {
      const controller = new AbortController();
      const prepare = jest.fn(async () => {
        controller.abort();
        throw controller.signal.reason;
      });
      const onInspectionUnavailable = jest.fn();
      await expect(
        preflightCodeOutputBatch({
          signal: controller.signal,
          artifact: { files: [{ id: 'id', name: 'report.pdf' }] },
          limits: { fileLimit: 1, fileSizeLimit: 1024, totalSizeLimit: 1024 },
          filters: strict
            ? { files: { pii: { fields: ['extracted_text'], uninspectable: 'block' } } }
            : undefined,
          prepare,
          onInspectionUnavailable,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(onInspectionUnavailable).not.toHaveBeenCalled();
    },
  );
});

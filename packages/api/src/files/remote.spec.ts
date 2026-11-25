import { once } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';
import { getRemoteAgentFileUrl, sendRemoteAgentFile } from './remote';

function createResponse() {
  const body: Buffer[] = [];
  const stream = new PassThrough();
  stream.on('data', (chunk) => body.push(Buffer.from(chunk)));
  const headers = new Map<string, string>();
  const status = jest.fn().mockReturnValue(stream);
  const send = jest.fn().mockReturnValue(stream);
  Object.assign(stream, {
    headersSent: false,
    setHeader: jest.fn((name: string, value: string) => headers.set(name, value)),
    status,
    send,
  });
  return { body, headers, res: stream as unknown as Response, send, status };
}

describe('getRemoteAgentFileUrl', () => {
  it('keeps the file identifier in one URL segment', () => {
    expect(getRemoteAgentFileUrl('image/id')).toBe('/api/agents/v1/files/image%2Fid/content');
  });
});

describe('sendRemoteAgentFile', () => {
  const req = {} as ServerRequest;

  it('streams stored bytes with their media type and no cache', async () => {
    const { body, headers, res } = createResponse();
    const getDownloadStream = jest.fn(async () => Readable.from([Buffer.from('webp-bytes')]));

    await sendRemoteAgentFile({
      req,
      res,
      file: {
        file_id: 'image-1',
        filepath: '/images/user/image.webp',
        storageKey: 'users/user/image.webp',
        source: 's3',
        type: 'image/webp',
      },
      getStrategyFunctions: () => ({ getDownloadStream }),
    });
    await once(res, 'finish');

    expect(getDownloadStream).toHaveBeenCalledWith(req, 'users/user/image.webp');
    expect(Buffer.concat(body).toString()).toBe('webp-bytes');
    expect(headers).toEqual(
      new Map([
        ['Cache-Control', 'no-store'],
        ['Content-Type', 'image/webp'],
        ['X-Content-Type-Options', 'nosniff'],
      ]),
    );
  });

  it('returns 501 when the storage strategy cannot stream', async () => {
    const { res, send, status } = createResponse();

    await sendRemoteAgentFile({
      req,
      res,
      file: { file_id: 'image-1', filepath: '/images/image.png', source: 'unsupported' },
      getStrategyFunctions: () => ({}),
    });

    expect(status).toHaveBeenCalledWith(501);
    expect(send).toHaveBeenCalledWith('Not Implemented');
  });

  it('returns a safe server error when opening storage fails', async () => {
    const { res, send, status } = createResponse();

    await sendRemoteAgentFile({
      req,
      res,
      file: { file_id: 'image-1', filepath: '/images/image.png', source: 'local' },
      getStrategyFunctions: () => ({
        getDownloadStream: jest.fn().mockRejectedValue(new Error('private storage path')),
      }),
    });

    expect(status).toHaveBeenCalledWith(500);
    expect(send).toHaveBeenCalledWith('Error downloading file');
  });
});

import { Readable } from 'node:stream';
import { Providers } from '@librechat/agents';
import { logger } from '@librechat/data-schemas';
import { FileSources } from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';
import { encodeAndFormatDocuments } from './document';
import { encodeAndFormatAudios } from './audio';
import { encodeAndFormatVideos } from './video';

const secret = 'opaque-download-credential-canary';
const url = `https://firebasestorage.googleapis.com/v0/b/example/o/file?alt=media&token=${secret}`;
const req = { config: {} } as ServerRequest;

const encoders = [
  {
    kind: 'Audio',
    encode: encodeAndFormatAudios,
    mime: 'audio/wav',
    empty: { audios: [], files: [] },
  },
  {
    kind: 'Video',
    encode: encodeAndFormatVideos,
    mime: 'video/mp4',
    empty: { videos: [], files: [] },
  },
  {
    kind: 'Document',
    encode: encodeAndFormatDocuments,
    mime: 'application/pdf',
    empty: { documents: [], files: [] },
  },
];

describe.each(encoders)('$kind storage failure logging', ({ kind, encode, mime, empty }) => {
  const file = {
    file_id: 'file-1',
    filename: `${secret}.attachment`,
    filepath: url,
    source: FileSources.firebase,
    type: mime,
    bytes: 16,
  } as IMongoFile;

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation();
    jest.spyOn(logger, 'error').mockImplementation(() => logger);
  });

  it.each([true, false])('omits secrets from a rejected download (Error=%s)', async (isError) => {
    const failure = isError
      ? Object.assign(new Error(`Download failed: ${url}`), {
          isAxiosError: true,
          config: { url, headers: { Authorization: `Bearer ${secret}` } },
          response: { status: 503, headers: { 'set-cookie': secret }, data: secret },
        })
      : secret;
    const download = jest.fn().mockRejectedValue(failure);
    const strategies = jest.fn().mockReturnValue({ getDownloadStream: download });
    const onMissingFile = jest.fn();

    await expect(
      encode(req, [file], { provider: Providers.GOOGLE, onMissingFile }, strategies),
    ).resolves.toEqual(empty);

    expect(download).toHaveBeenCalledWith(
      req,
      url,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(onMissingFile).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      `${kind} processing failed:`,
      isError ? { type: 'Error', status: 503 } : { type: 'UnknownError' },
    );
    expect(console.error).not.toHaveBeenCalled();
    expect(JSON.stringify(jest.mocked(logger.error).mock.calls)).not.toContain(secret);
  });

  it('retains successful files when another download fails', async () => {
    const present = { ...file, file_id: 'present-1' };
    const download = jest
      .fn()
      .mockRejectedValueOnce(new Error(url))
      .mockResolvedValueOnce(Readable.from([Buffer.alloc(16)]));
    const strategies = jest.fn().mockReturnValue({ getDownloadStream: download });

    const result = await encode(req, [file, present], { provider: Providers.GOOGLE }, strategies);

    expect(result.files).toHaveLength(1);
    expect(result.files[0].file_id).toBe(present.file_id);
    expect(logger.error).toHaveBeenCalledWith(`${kind} processing failed:`, { type: 'Error' });
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each([true, false])('preserves missing-file handling (tolerant=%s)', async (tolerant) => {
    const failure = Object.assign(new Error(url), { response: { status: 404 } });
    const strategies = jest.fn().mockReturnValue({
      getDownloadStream: jest.fn().mockRejectedValue(failure),
    });
    const onMissingFile = tolerant ? jest.fn() : undefined;
    const result = encode(req, [file], { provider: Providers.GOOGLE, onMissingFile }, strategies);

    if (onMissingFile) {
      await expect(result).resolves.toEqual(empty);
      expect(onMissingFile).toHaveBeenCalledWith(file);
    } else {
      await expect(result).rejects.toMatchObject({ code: 'ATTACHMENT_OBJECT_NOT_FOUND' });
    }
    expect(logger.error).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });
});

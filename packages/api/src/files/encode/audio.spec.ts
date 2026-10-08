import { Providers } from '@librechat/agents';
import type { IMongoFile } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';
import { encodeAndFormatAudios } from './audio';

jest.mock('~/files/validation', () => ({
  validateAudio: jest.fn(),
}));

jest.mock('./utils', () => ({
  ...jest.requireActual('./utils'),
  getFileStream: jest.fn(),
  getConfiguredFileSizeLimit: jest.fn(),
  isConfiguredProviderMediaType: jest.fn(),
}));

jest.mock('./memoryGuard', () => ({
  runGuardedEncode: jest.fn((_bytes: number, fn: () => unknown) => fn()),
}));

import { validateAudio } from '~/files/validation';
import { getFileStream, isConfiguredProviderMediaType } from './utils';
import { Types } from 'mongoose';

const mockedValidateAudio = validateAudio as jest.MockedFunction<typeof validateAudio>;
const mockedGetFileStream = getFileStream as jest.MockedFunction<typeof getFileStream>;
const mockedIsConfigured = isConfiguredProviderMediaType as jest.MockedFunction<
  typeof isConfiguredProviderMediaType
>;

const createMockFile = (type = 'audio/wav', filename = 'tone.wav'): IMongoFile =>
  ({
    _id: new Types.ObjectId(),
    file_id: 'audio-1',
    filename,
    filepath: `/uploads/${filename}`,
    type,
    bytes: 1024,
    source: 'local',
    user: 'user-1',
    object: 'file',
    usage: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as unknown as IMongoFile;

const req = { config: {} } as unknown as ServerRequest;
const getStrategyFunctions = jest.fn();

describe('encodeAndFormatAudios - provider formatting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedValidateAudio.mockResolvedValue({ isValid: true });
    mockedIsConfigured.mockReturnValue(false);
    const file = createMockFile();
    mockedGetFileStream.mockResolvedValue({
      file,
      content: 'AAAA',
      metadata: {
        file_id: file.file_id,
        filepath: file.filepath,
        source: file.source,
        filename: file.filename,
        type: file.type,
      },
    });
  });

  it('emits a Google media block for google', async () => {
    const result = await encodeAndFormatAudios(
      req,
      [createMockFile()],
      { provider: Providers.GOOGLE },
      getStrategyFunctions,
    );
    expect(result.audios).toEqual([{ type: 'media', mimeType: 'audio/wav', data: 'AAAA' }]);
  });

  it('emits an OpenAI-compatible input_audio block for openrouter without configuration', async () => {
    const result = await encodeAndFormatAudios(
      req,
      [createMockFile()],
      { provider: Providers.OPENROUTER },
      getStrategyFunctions,
    );
    expect(mockedIsConfigured).not.toHaveBeenCalled();
    expect(result.audios).toEqual([
      { type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } },
    ]);
  });

  it('drops the audio for a custom endpoint that is not configured for audio', async () => {
    const result = await encodeAndFormatAudios(
      req,
      [createMockFile()],
      { provider: Providers.OPENAI, endpoint: 'MyGateway' },
      getStrategyFunctions,
    );
    expect(mockedIsConfigured).toHaveBeenCalledWith(
      req,
      { provider: Providers.OPENAI, endpoint: 'MyGateway' },
      'audio/wav',
    );
    expect(result.audios).toEqual([]);
    expect(result.files).toHaveLength(1);
  });

  it('emits an input_audio block for a custom endpoint whose config allows audio', async () => {
    mockedIsConfigured.mockReturnValue(true);
    const result = await encodeAndFormatAudios(
      req,
      [createMockFile()],
      { provider: Providers.OPENAI, endpoint: 'MyGateway' },
      getStrategyFunctions,
    );
    expect(result.audios).toEqual([
      { type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } },
    ]);
  });

  it('never emits a block for providers without an audio path, even when configured', async () => {
    mockedIsConfigured.mockReturnValue(true);
    const result = await encodeAndFormatAudios(
      req,
      [createMockFile()],
      { provider: Providers.ANTHROPIC },
      getStrategyFunctions,
    );
    expect(result.audios).toEqual([]);
  });

  describe('input_audio format canonicalization', () => {
    /** Re-points the `getFileStream` mock at a specific file for one test. */
    const stageFile = (file: IMongoFile) => {
      mockedGetFileStream.mockResolvedValue({
        file,
        content: 'AAAA',
        metadata: {
          file_id: file.file_id,
          filepath: file.filepath,
          source: file.source,
          filename: file.filename,
          type: file.type,
        },
      });
    };

    const formatFor = async (file: IMongoFile) => {
      stageFile(file);
      mockedIsConfigured.mockReturnValue(true);
      const result = await encodeAndFormatAudios(
        req,
        [file],
        { provider: Providers.OPENAI, endpoint: 'MyGateway' },
        getStrategyFunctions,
      );
      return (result.audios[0] as { input_audio?: { format?: string } })?.input_audio?.format;
    };

    it.each([
      ['audio/wave', 'clip.wave', 'wav'],
      ['audio/x-wav', 'clip.x-wav', 'wav'],
      ['audio/mpeg', 'clip.mpeg', 'mp3'],
      ['audio/mpeg3', 'clip.mpeg3', 'mp3'],
      ['audio/x-m4a', 'clip.x-m4a', 'm4a'],
      ['audio/vorbis', 'clip.vorbis', 'ogg'],
      ['audio/x-flac', 'clip.x-flac', 'flac'],
    ])('canonicalizes %s to a provider-accepted format', async (type, filename, expected) => {
      expect(await formatFor(createMockFile(type, filename))).toBe(expected);
    });

    it('derives the format from the MIME type when the filename has no extension', async () => {
      expect(await formatFor(createMockFile('audio/mpeg', 'recording'))).toBe('mp3');
    });

    it('prefers the canonical MIME format over a mismatched extension', async () => {
      expect(await formatFor(createMockFile('audio/mpeg', 'clip.wav'))).toBe('mp3');
    });

    it('falls back to a supported filename extension for MIME types with no mapping', async () => {
      expect(await formatFor(createMockFile('audio/aac', 'clip.aac'))).toBe('aac');
    });

    it('throws rather than emitting an unsupported format', async () => {
      /** `audio/wma` passes MIME validation but has no provider-accepted format. */
      stageFile(createMockFile('audio/wma', 'recording'));
      mockedIsConfigured.mockReturnValue(true);
      await expect(
        encodeAndFormatAudios(
          req,
          [createMockFile('audio/wma', 'recording')],
          { provider: Providers.OPENAI, endpoint: 'MyGateway' },
          getStrategyFunctions,
        ),
      ).rejects.toThrow(/supported audio format/i);
    });

    it('canonicalizes for openrouter as well', async () => {
      stageFile(createMockFile('audio/wave', 'clip.wave'));
      const result = await encodeAndFormatAudios(
        req,
        [createMockFile('audio/wave', 'clip.wave')],
        { provider: Providers.OPENROUTER },
        getStrategyFunctions,
      );
      expect(result.audios).toEqual([
        { type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } },
      ]);
    });
  });
});

import { Providers } from '@librechat/agents';
import type { IMongoFile } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';
import { encodeAndFormatVideos } from './video';

jest.mock('~/files/validation', () => ({
  validateVideo: jest.fn(),
}));

jest.mock('./utils', () => ({
  getFileStream: jest.fn(),
  getConfiguredFileSizeLimit: jest.fn(),
  isConfiguredProviderMediaType: jest.fn(),
}));

jest.mock('./memoryGuard', () => ({
  runGuardedEncode: jest.fn((_bytes: number, fn: () => unknown) => fn()),
}));

import { validateVideo } from '~/files/validation';
import { getFileStream, isConfiguredProviderMediaType } from './utils';
import { Types } from 'mongoose';

const mockedValidateVideo = validateVideo as jest.MockedFunction<typeof validateVideo>;
const mockedGetFileStream = getFileStream as jest.MockedFunction<typeof getFileStream>;
const mockedIsConfigured = isConfiguredProviderMediaType as jest.MockedFunction<
  typeof isConfiguredProviderMediaType
>;

const createMockFile = (type = 'video/mp4'): IMongoFile =>
  ({
    _id: new Types.ObjectId(),
    file_id: 'video-1',
    filename: 'clip.mp4',
    filepath: '/uploads/clip.mp4',
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

describe('encodeAndFormatVideos - provider formatting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedValidateVideo.mockResolvedValue({ isValid: true });
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
    const result = await encodeAndFormatVideos(
      req,
      [createMockFile()],
      { provider: Providers.GOOGLE },
      getStrategyFunctions,
    );
    expect(result.videos).toEqual([{ type: 'media', mimeType: 'video/mp4', data: 'AAAA' }]);
  });

  it('emits an OpenAI-compatible video_url block for openrouter without configuration', async () => {
    const result = await encodeAndFormatVideos(
      req,
      [createMockFile()],
      { provider: Providers.OPENROUTER },
      getStrategyFunctions,
    );
    expect(mockedIsConfigured).not.toHaveBeenCalled();
    expect(result.videos).toEqual([
      { type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAAA' } },
    ]);
  });

  it('drops the video for a custom endpoint that is not configured for video', async () => {
    const result = await encodeAndFormatVideos(
      req,
      [createMockFile()],
      { provider: Providers.OPENAI, endpoint: 'MyGateway' },
      getStrategyFunctions,
    );
    expect(mockedIsConfigured).toHaveBeenCalledWith(
      req,
      { provider: Providers.OPENAI, endpoint: 'MyGateway' },
      'video/mp4',
    );
    expect(result.videos).toEqual([]);
    expect(result.files).toHaveLength(1);
  });

  it('emits a video_url block for a custom endpoint whose config allows video', async () => {
    mockedIsConfigured.mockReturnValue(true);
    const result = await encodeAndFormatVideos(
      req,
      [createMockFile()],
      { provider: Providers.OPENAI, endpoint: 'MyGateway' },
      getStrategyFunctions,
    );
    expect(result.videos).toEqual([
      { type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAAA' } },
    ]);
  });

  it('never emits a block for providers without a video path, even when configured', async () => {
    mockedIsConfigured.mockReturnValue(true);
    const result = await encodeAndFormatVideos(
      req,
      [createMockFile()],
      { provider: Providers.ANTHROPIC },
      getStrategyFunctions,
    );
    expect(result.videos).toEqual([]);
  });
});

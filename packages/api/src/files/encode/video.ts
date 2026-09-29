import { Providers } from '@librechat/agents';
import { isDocumentSupportedProvider, isOpenAILikeProvider } from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import type { ServerRequest, StrategyFunctions, VideoResult } from '~/types';
import {
  getFileStream,
  getConfiguredFileSizeLimit,
  isAttachmentObjectNotFoundError,
  isConfiguredProviderMediaType,
} from './utils';
import { validateVideo } from '~/files/validation';
import { runGuardedEncode } from './memoryGuard';

/**
 * Encodes and formats video files for different providers
 * @param req - The request object
 * @param files - Array of video files
 * @param params - Object containing provider and optional endpoint
 * @param params.provider - The provider to format for
 * @param params.endpoint - Optional endpoint name for file config lookup
 * @param getStrategyFunctions - Function to get strategy functions
 * @returns Promise that resolves to videos and file metadata
 */
export async function encodeAndFormatVideos(
  req: ServerRequest,
  files: IMongoFile[],
  params: { provider: Providers; endpoint?: string },
  getStrategyFunctions: (source: string) => StrategyFunctions,
): Promise<VideoResult> {
  const { provider, endpoint } = params;
  if (!files?.length) {
    return { videos: [], files: [] };
  }

  const encodingMethods: Record<string, StrategyFunctions> = {};
  const result: VideoResult = { videos: [], files: [] };

  const results = await Promise.allSettled(
    files.map((file) =>
      runGuardedEncode(file.bytes ?? 0, () =>
        getFileStream(req, file, encodingMethods, getStrategyFunctions),
      ),
    ),
  );

  for (const settledResult of results) {
    if (settledResult.status === 'rejected') {
      if (isAttachmentObjectNotFoundError(settledResult.reason)) {
        throw settledResult.reason;
      }
      console.error('Video processing failed:', settledResult.reason);
      continue;
    }

    const processed = settledResult.value;
    if (!processed) continue;

    const { file, content, metadata } = processed;

    if (!content || !file) {
      if (metadata) result.files.push(metadata);
      continue;
    }

    if (!file.type.startsWith('video/') || !isDocumentSupportedProvider(provider)) {
      result.files.push(metadata);
      continue;
    }

    const videoBuffer = Buffer.from(content, 'base64');

    /** Extract configured file size limit from fileConfig for this endpoint */
    const configuredFileSizeLimit = getConfiguredFileSizeLimit(req, {
      provider,
      endpoint,
    });

    const validation = await validateVideo(
      videoBuffer,
      videoBuffer.length,
      provider,
      configuredFileSizeLimit,
    );

    if (!validation.isValid) {
      throw new Error(`Video validation failed: ${validation.error}`);
    }

    if (provider === Providers.GOOGLE || provider === Providers.VERTEXAI) {
      result.videos.push({
        type: 'media',
        mimeType: file.type,
        data: content,
      });
    } else if (
      provider === Providers.OPENROUTER ||
      (isOpenAILikeProvider(provider) &&
        isConfiguredProviderMediaType(req, { provider, endpoint }, file.type))
    ) {
      /** OpenAI-compatible `video_url` part (OpenRouter, vLLM, and other gateways).
       * Custom endpoints only get here when the admin listed video types in the
       * endpoint's `supportedMimeTypes`, since not every gateway accepts video. */
      result.videos.push({
        type: 'video_url',
        video_url: {
          url: `data:${file.type};base64,${content}`,
        },
      });
    }

    result.files.push(metadata);
  }

  return result;
}

import { Providers } from '@librechat/agents';
import { logger } from '@librechat/data-schemas';
import { isDocumentSupportedProvider } from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import type { ServerRequest, StrategyFunctions, VideoResult } from '~/types';
import type { MissingAttachmentHandler } from './utils';
import type { DocumentRecipient } from './document';
import { getFileStream, getConfiguredFileSizeLimit, skipMissingAttachment } from './utils';
import { readsOpenAIMedia, sharesOpenAIMedia, getGeminiReaderChecks } from './readers';
import { configuredRequestBudget } from '~/utils/timeouts';
import { getSafeErrorMetadata } from '~/utils/errors';
import { validateVideo } from '~/files/validation';
import { runGuardedEncode } from './memoryGuard';

/**
 * Encodes and formats video files for different providers
 * @param req - The request object
 * @param files - Array of video files
 * @param params - Object containing provider and optional endpoint
 * @param params.provider - The provider to format for
 * @param params.endpoint - Optional endpoint name for file config lookup
 * @param params.recipients - The other agents that read the same history: chain, handoff and
 * added conversation. An OpenAI-compatible part goes into the history only when every one of
 * them can take it; otherwise the video is Gemini's part, which only Gemini and Vertex agents
 * receive. Gemini and Vertex agents' size limits apply too.
 * @param getStrategyFunctions - Function to get strategy functions
 * @returns Promise that resolves to videos and file metadata
 */
export async function encodeAndFormatVideos(
  req: ServerRequest,
  files: IMongoFile[],
  params: {
    provider: Providers;
    endpoint?: string;
    recipients?: Iterable<DocumentRecipient>;
    onMissingFile?: MissingAttachmentHandler;
  },
  getStrategyFunctions: (source: string) => StrategyFunctions,
): Promise<VideoResult> {
  const { provider, endpoint, recipients, onMissingFile } = params;
  if (!files?.length) {
    return { videos: [], files: [] };
  }

  const encodingMethods: Record<string, StrategyFunctions> = {};
  const result: VideoResult = { videos: [], files: [] };
  const readers = Array.from(recipients ?? []);
  /** Extract configured file size limit from fileConfig for this endpoint */
  const configuredFileSizeLimit = getConfiguredFileSizeLimit(req, { provider, endpoint });
  const readerChecks = getGeminiReaderChecks(
    req,
    { provider, fileSizeLimit: configuredFileSizeLimit },
    readers,
  );

  const results = await Promise.allSettled(
    files.map((file) =>
      runGuardedEncode(file.bytes ?? 0, () =>
        getFileStream(
          req,
          file,
          encodingMethods,
          getStrategyFunctions,
          configuredRequestBudget(req.config, 'fileFetchMs'),
        ),
      ),
    ),
  );

  for (const [index, settledResult] of results.entries()) {
    if (settledResult.status === 'rejected') {
      if (skipMissingAttachment(settledResult.reason, files[index], onMissingFile)) {
        continue;
      }
      logger.error('Video processing failed:', getSafeErrorMetadata(settledResult.reason));
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

    const validation = await validateVideo(
      videoBuffer,
      videoBuffer.length,
      provider,
      configuredFileSizeLimit,
    );

    if (!validation.isValid) {
      throw new Error(`Video validation failed: ${validation.error}`);
    }

    const geminiPrimary = provider === Providers.GOOGLE || provider === Providers.VERTEXAI;
    if (!geminiPrimary && !readsOpenAIMedia(req, { provider, endpoint }, file.type)) {
      result.files.push(metadata);
      continue;
    }

    for (const check of readerChecks) {
      const readerValidation = await validateVideo(
        videoBuffer,
        videoBuffer.length,
        check.provider,
        check.fileSizeLimit,
      );
      if (!readerValidation.isValid) {
        throw new Error(`Video validation failed: ${readerValidation.error}`);
      }
    }

    if (geminiPrimary || !sharesOpenAIMedia(req, readers, file.type)) {
      result.videos.push({
        type: 'media',
        mimeType: file.type,
        data: content,
      });
    } else {
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

import { Providers } from '@librechat/agents';
import { logger } from '@librechat/data-schemas';
import { isDocumentSupportedProvider } from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import type { ServerRequest, StrategyFunctions, AudioResult } from '~/types';
import type { MissingAttachmentHandler } from './utils';
import type { DocumentRecipient } from './document';
import {
  getFileStream,
  getAudioFormat,
  getConfiguredFileSizeLimit,
  skipMissingAttachment,
} from './utils';
import { readsOpenAIMedia, sharesOpenAIMedia, getGeminiReaderChecks } from './readers';
import { configuredRequestBudget } from '~/utils/timeouts';
import { getSafeErrorMetadata } from '~/utils/errors';
import { validateAudio } from '~/files/validation';
import { runGuardedEncode } from './memoryGuard';

/**
 * Encodes and formats audio files for different providers
 * @param req - The request object
 * @param files - Array of audio files
 * @param params - Object containing provider and optional endpoint
 * @param params.provider - The provider to format for
 * @param params.endpoint - Optional endpoint name for file config lookup
 * @param params.recipients - The other agents that read the same history: chain, handoff and
 * added conversation. An OpenAI-compatible part goes into the history only when every one of
 * them can take it; otherwise the audio is Gemini's part, which only Gemini and Vertex agents
 * receive. Gemini and Vertex agents' size limits apply too.
 * @param getStrategyFunctions - Function to get strategy functions
 * @returns Promise that resolves to audio and file metadata
 */
export async function encodeAndFormatAudios(
  req: ServerRequest,
  files: IMongoFile[],
  params: {
    provider: Providers;
    endpoint?: string;
    recipients?: Iterable<DocumentRecipient>;
    onMissingFile?: MissingAttachmentHandler;
  },
  getStrategyFunctions: (source: string) => StrategyFunctions,
): Promise<AudioResult> {
  const { provider, endpoint, recipients, onMissingFile } = params;
  if (!files?.length) {
    return { audios: [], files: [] };
  }

  const encodingMethods: Record<string, StrategyFunctions> = {};
  const result: AudioResult = { audios: [], files: [] };
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
      logger.error('Audio processing failed:', getSafeErrorMetadata(settledResult.reason));
      continue;
    }

    const processed = settledResult.value;
    if (!processed) continue;

    const { file, content, metadata } = processed;

    if (!content || !file) {
      if (metadata) result.files.push(metadata);
      continue;
    }

    if (!file.type.startsWith('audio/') || !isDocumentSupportedProvider(provider)) {
      result.files.push(metadata);
      continue;
    }

    const audioBuffer = Buffer.from(content, 'base64');

    const validation = await validateAudio(
      audioBuffer,
      audioBuffer.length,
      provider,
      configuredFileSizeLimit,
    );

    if (!validation.isValid) {
      throw new Error(`Audio validation failed: ${validation.error}`);
    }

    const geminiPrimary = provider === Providers.GOOGLE || provider === Providers.VERTEXAI;
    if (!geminiPrimary && !readsOpenAIMedia(req, { provider, endpoint }, file.type)) {
      result.files.push(metadata);
      continue;
    }

    for (const check of readerChecks) {
      const readerValidation = await validateAudio(
        audioBuffer,
        audioBuffer.length,
        check.provider,
        check.fileSizeLimit,
      );
      if (!readerValidation.isValid) {
        throw new Error(`Audio validation failed: ${readerValidation.error}`);
      }
    }

    if (geminiPrimary || !sharesOpenAIMedia(req, readers, file.type)) {
      result.audios.push({
        type: 'media',
        mimeType: file.type,
        data: content,
      });
    } else {
      /** OpenAI-compatible `input_audio` part (OpenRouter, vLLM, and other gateways).
       * Custom endpoints only get here when the admin listed audio types in the
       * endpoint's `supportedMimeTypes`, since not every gateway accepts audio. */
      /** Canonicalized from the MIME type: the accepted MIME list contains aliases
       * (`audio/wave`, `audio/mpeg`) that are not valid format values, and the filename
       * may carry no extension at all. */
      const format = getAudioFormat(file.type, file.filename);
      if (!format) {
        throw new Error(
          `Could not determine a supported audio format for "${file.filename}" (${file.type})`,
        );
      }
      result.audios.push({
        type: 'input_audio',
        input_audio: {
          data: content,
          format,
        },
      });
    }

    result.files.push(metadata);
  }

  return result;
}

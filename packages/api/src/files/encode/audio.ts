import { Providers } from '@librechat/agents';
import { isDocumentSupportedProvider, isOpenAILikeProvider } from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import type { ServerRequest, StrategyFunctions, AudioResult } from '~/types';
import {
  getFileStream,
  getAudioFormat,
  getConfiguredFileSizeLimit,
  isAttachmentObjectNotFoundError,
  isConfiguredProviderMediaType,
} from './utils';
import { validateAudio } from '~/files/validation';
import { runGuardedEncode } from './memoryGuard';

/**
 * Encodes and formats audio files for different providers
 * @param req - The request object
 * @param files - Array of audio files
 * @param params - Object containing provider and optional endpoint
 * @param params.provider - The provider to format for
 * @param params.endpoint - Optional endpoint name for file config lookup
 * @param getStrategyFunctions - Function to get strategy functions
 * @returns Promise that resolves to audio and file metadata
 */
export async function encodeAndFormatAudios(
  req: ServerRequest,
  files: IMongoFile[],
  params: { provider: Providers; endpoint?: string },
  getStrategyFunctions: (source: string) => StrategyFunctions,
): Promise<AudioResult> {
  const { provider, endpoint } = params;
  if (!files?.length) {
    return { audios: [], files: [] };
  }

  const encodingMethods: Record<string, StrategyFunctions> = {};
  const result: AudioResult = { audios: [], files: [] };

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
      console.error('Audio processing failed:', settledResult.reason);
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

    /** Extract configured file size limit from fileConfig for this endpoint */
    const configuredFileSizeLimit = getConfiguredFileSizeLimit(req, {
      provider,
      endpoint,
    });

    const validation = await validateAudio(
      audioBuffer,
      audioBuffer.length,
      provider,
      configuredFileSizeLimit,
    );

    if (!validation.isValid) {
      throw new Error(`Audio validation failed: ${validation.error}`);
    }

    if (provider === Providers.GOOGLE || provider === Providers.VERTEXAI) {
      result.audios.push({
        type: 'media',
        mimeType: file.type,
        data: content,
      });
    } else if (
      provider === Providers.OPENROUTER ||
      (isOpenAILikeProvider(provider) &&
        isConfiguredProviderMediaType(req, { provider, endpoint }, file.type))
    ) {
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

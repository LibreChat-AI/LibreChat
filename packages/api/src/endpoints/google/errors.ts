import { Providers } from '@librechat/agents';
import { ErrorTypes } from 'librechat-data-provider';

/**
 * Google's opaque rejection for content it will not accept. The Gemini API answers an over-length,
 * region-locked, or otherwise unreadable video with this single generic sentence and no field-level
 * detail, so the phrase alone cannot identify the cause — the caller supplies that context.
 */
const INVALID_ARGUMENT_REGEX = /request contains an invalid argument/i;

function toErrorMessage(error: unknown): string | undefined {
  if (typeof error === 'string') {
    return error;
  }
  if (error == null || typeof error !== 'object') {
    return undefined;
  }
  const { message } = error as { message?: unknown };
  return typeof message === 'string' ? message : undefined;
}

function isGoogleProvider(provider?: string): boolean {
  return provider === Providers.GOOGLE || provider === Providers.VERTEXAI;
}

/**
 * True for Google's generic `400 INVALID_ARGUMENT`. Both the Gemini Developer API and Vertex use
 * the same wording, so the HTTP status is accepted from either the error object or the message text
 * that the `@google/generative-ai` SDK bakes its status into.
 */
export function isGoogleInvalidArgumentError(error: unknown): boolean {
  const message = toErrorMessage(error);
  if (message == null || !INVALID_ARGUMENT_REGEX.test(message)) {
    return false;
  }
  const status = (error as { status?: unknown } | null)?.status;
  return status === 400 || message.includes('400');
}

/**
 * Maps a failed Google request back to the YouTube video that most likely caused it, returning the
 * typed error payload the client localizes (or `undefined` to leave the original error alone).
 *
 * Attribution rests on context rather than the response body: when the turn carried an injected
 * YouTube video and Google answers with its generic `INVALID_ARGUMENT`, the video is the cause we
 * can act on. Verified against the live API — a public 9h15m video is refused this way on every
 * Gemini model tested, including at `MEDIA_RESOLUTION_LOW`, while a short video with an otherwise
 * identical payload succeeds. Duration is the common trigger; region and access restrictions
 * produce the same response, so the localized copy names length first without claiming certainty.
 */
export function resolveGoogleVideoError(params: {
  error: unknown;
  provider?: string;
  hasYouTubeVideo?: boolean;
}): string | undefined {
  if (params.hasYouTubeVideo !== true || !isGoogleProvider(params.provider)) {
    return undefined;
  }
  if (!isGoogleInvalidArgumentError(params.error)) {
    return undefined;
  }
  return JSON.stringify({ type: ErrorTypes.GOOGLE_VIDEO_UNPROCESSABLE });
}

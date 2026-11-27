import { Providers } from '@librechat/agents';
import { ErrorTypes } from 'librechat-data-provider';
import { isGoogleInvalidArgumentError, resolveGoogleVideoError } from './errors';

/**
 * Verbatim error the `@google/generative-ai` SDK raises for a rejected video, captured from a live
 * request whose message carried a 9h15m YouTube link.
 */
const GENERIC_400_MESSAGE =
  '[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse: [400 Bad Request] Request contains an invalid argument.';

function googleError(message: string, status?: number): Error & { status?: number } {
  const error: Error & { status?: number } = new Error(message);
  if (status != null) {
    error.status = status;
  }
  return error;
}

const VIDEO_ERROR = JSON.stringify({ type: ErrorTypes.GOOGLE_VIDEO_UNPROCESSABLE });

describe('isGoogleInvalidArgumentError', () => {
  it('matches the SDK error for a rejected video', () => {
    expect(isGoogleInvalidArgumentError(googleError(GENERIC_400_MESSAGE, 400))).toBe(true);
  });

  it('matches when the status is only present in the message text', () => {
    expect(isGoogleInvalidArgumentError(googleError(GENERIC_400_MESSAGE))).toBe(true);
  });

  it('matches a plain string error', () => {
    expect(isGoogleInvalidArgumentError(GENERIC_400_MESSAGE)).toBe(true);
  });

  it('matches the Vertex wording carrying the status as a property', () => {
    expect(
      isGoogleInvalidArgumentError(googleError('Request contains an invalid argument.', 400)),
    ).toBe(true);
  });

  it('rejects the same wording without any 400 signal', () => {
    expect(isGoogleInvalidArgumentError(googleError('Request contains an invalid argument.'))).toBe(
      false,
    );
  });

  it('rejects a different Google 400 that names its own cause', () => {
    expect(
      isGoogleInvalidArgumentError(
        googleError(
          '[GoogleGenerativeAI Error]: [400 Bad Request] Please enable tool_config.include_server_side_tool_invocations to use Built-in tools with Function calling.',
          400,
        ),
      ),
    ).toBe(false);
  });

  it('rejects rate limit and server errors', () => {
    expect(isGoogleInvalidArgumentError(googleError('[429] Resource exhausted', 429))).toBe(false);
    expect(
      isGoogleInvalidArgumentError(googleError('[503] Model is overloaded, try again', 503)),
    ).toBe(false);
  });

  it('rejects non-error values', () => {
    expect(isGoogleInvalidArgumentError(undefined)).toBe(false);
    expect(isGoogleInvalidArgumentError(null)).toBe(false);
    expect(isGoogleInvalidArgumentError({})).toBe(false);
    expect(isGoogleInvalidArgumentError({ message: 42 })).toBe(false);
  });
});

describe('resolveGoogleVideoError', () => {
  it('returns the typed payload when a video turn hits the generic rejection', () => {
    expect(
      resolveGoogleVideoError({
        error: googleError(GENERIC_400_MESSAGE, 400),
        provider: Providers.GOOGLE,
        hasYouTubeVideo: true,
      }),
    ).toBe(VIDEO_ERROR);
  });

  it('resolves for Vertex as well as the Gemini Developer API', () => {
    expect(
      resolveGoogleVideoError({
        error: googleError(GENERIC_400_MESSAGE, 400),
        provider: Providers.VERTEXAI,
        hasYouTubeVideo: true,
      }),
    ).toBe(VIDEO_ERROR);
  });

  it('emits a payload the client error map can parse back to the typed key', () => {
    const resolved = resolveGoogleVideoError({
      error: googleError(GENERIC_400_MESSAGE, 400),
      provider: Providers.GOOGLE,
      hasYouTubeVideo: true,
    });
    expect(JSON.parse(resolved as string)).toEqual({
      type: ErrorTypes.GOOGLE_VIDEO_UNPROCESSABLE,
    });
  });

  it('defers when the turn carried no video, so unrelated 400s keep their own message', () => {
    expect(
      resolveGoogleVideoError({
        error: googleError(GENERIC_400_MESSAGE, 400),
        provider: Providers.GOOGLE,
        hasYouTubeVideo: false,
      }),
    ).toBeUndefined();
  });

  it('defers when the injection flag was never set', () => {
    expect(
      resolveGoogleVideoError({
        error: googleError(GENERIC_400_MESSAGE, 400),
        provider: Providers.GOOGLE,
      }),
    ).toBeUndefined();
  });

  it('defers for non-Google providers', () => {
    expect(
      resolveGoogleVideoError({
        error: googleError(GENERIC_400_MESSAGE, 400),
        provider: Providers.OPENAI,
        hasYouTubeVideo: true,
      }),
    ).toBeUndefined();
  });

  it('defers when the provider is unknown', () => {
    expect(
      resolveGoogleVideoError({
        error: googleError(GENERIC_400_MESSAGE, 400),
        hasYouTubeVideo: true,
      }),
    ).toBeUndefined();
  });

  it('defers on a video turn that fails for an unrelated reason', () => {
    expect(
      resolveGoogleVideoError({
        error: googleError('[GoogleGenerativeAI Error]: [401] API key not valid', 401),
        provider: Providers.GOOGLE,
        hasYouTubeVideo: true,
      }),
    ).toBeUndefined();
  });
});

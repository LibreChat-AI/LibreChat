import { Providers } from '@librechat/agents';
import { isOpenAILikeProvider } from 'librechat-data-provider';
import type { DocumentRecipient } from './document';
import type { ServerRequest } from '~/types';
import { getConfiguredFileSizeLimit, isConfiguredProviderMediaType } from './utils';

/** An agent that reads audio or video in a shared history, as far as choosing its part needs. */
type MediaReader = Pick<DocumentRecipient, 'provider' | 'endpoint' | 'model_parameters'>;

/** The provider and configured size limit that one Gemini or Vertex agent checks audio and video against. */
export interface MediaCheck {
  provider: Providers;
  fileSizeLimit?: number;
}

const isGemini = (provider?: string): boolean =>
  provider === Providers.GOOGLE || provider === Providers.VERTEXAI;

/**
 * Whether `agent` reads OpenAI-compatible `input_audio` and `video_url` parts of `mimeType`:
 * OpenRouter always, another OpenAI-compatible endpoint only when the admin listed the type in
 * its `supportedMimeTypes`.
 */
export function readsOpenAIMedia(
  req: ServerRequest,
  agent: MediaReader,
  mimeType: string,
): boolean {
  const provider = agent.provider as Providers;
  return (
    provider === Providers.OPENROUTER ||
    (isOpenAILikeProvider(provider) &&
      isConfiguredProviderMediaType(
        req,
        { provider, endpoint: agent.endpoint ?? undefined },
        mimeType,
      ))
  );
}

/**
 * Whether every other agent reading the history can take an OpenAI-compatible audio or video
 * part. The agents SDK rewrites one for Gemini and Vertex and leaves it out for Claude, Bedrock
 * and the Responses API, but sends it as it is to every other OpenAI-compatible Chat Completions
 * agent, whose endpoint may not read it.
 */
export function sharesOpenAIMedia(
  req: ServerRequest,
  readers: readonly (MediaReader | null | undefined)[],
  mimeType: string,
): boolean {
  for (const reader of readers) {
    const provider = reader?.provider;
    if (
      reader == null ||
      provider == null ||
      isGemini(provider) ||
      provider === Providers.ANTHROPIC ||
      provider === Providers.BEDROCK ||
      reader.model_parameters?.useResponsesApi === true
    ) {
      continue;
    }
    if (!readsOpenAIMedia(req, reader, mimeType)) {
      return false;
    }
  }
  return true;
}

/**
 * The checks of the Gemini and Vertex agents reading the history that differ from the primary
 * agent's own. They receive the audio or video inline whichever part carries it, so one over
 * their limit fails the turn up front, as the primary agent's checks do, instead of failing
 * their requests on this turn and every later one.
 */
export function getGeminiReaderChecks(
  req: ServerRequest,
  primary: MediaCheck,
  readers: readonly (MediaReader | null | undefined)[],
): MediaCheck[] {
  const checks = new Map<string, MediaCheck>();
  for (const reader of readers) {
    if (reader == null || !isGemini(reader.provider)) {
      continue;
    }
    const provider = reader.provider as Providers;
    const fileSizeLimit = getConfiguredFileSizeLimit(req, {
      provider,
      endpoint: reader.endpoint ?? undefined,
    });
    checks.set(`${provider}:${fileSizeLimit ?? ''}`, { provider, fileSizeLimit });
  }
  checks.delete(`${primary.provider}:${primary.fileSizeLimit ?? ''}`);
  return [...checks.values()];
}

import { logger } from '@librechat/data-schemas';
import { CohereConstants } from 'librechat-data-provider';

/**
 * Extracts a valid OpenAI baseURL from a given string, matching "url/v1," followed by an optional suffix.
 * The suffix can be one of several predefined values (e.g., 'openai', 'azure-openai', etc.),
 * accommodating different proxy patterns like Cloudflare, LiteLLM, etc.
 * Returns the original URL if no valid pattern is found.
 *
 * Examples:
 * - `https://open.ai/v1/chat` -> `https://open.ai/v1`
 * - `https://open.ai/v1/chat/completions` -> `https://open.ai/v1`
 * - `https://gateway.ai.cloudflare.com/v1/account/gateway/azure-openai/completions` -> `https://gateway.ai.cloudflare.com/v1/account/gateway/azure-openai`
 * - `https://open.ai/v1/hi/openai` -> `https://open.ai/v1/hi/openai`
 * - `https://api.example.com/v1/replicate` -> `https://api.example.com/v1/replicate`
 *
 * @param url - The URL to be processed.
 * @returns The matched pattern or input if no match is found.
 */
export function extractBaseURL(url: string): string | null | undefined {
  if (!url || typeof url !== 'string') {
    return undefined;
  }

  if (url.startsWith(CohereConstants.API_URL)) {
    return null;
  }

  const v1Index = url.search(/\/v1(?=\/|[?#]|$)/);
  if (v1Index < 0) {
    return url;
  }

  const suffixStart = url.search(/[?#]/);
  const trailing = suffixStart < 0 ? '' : url.slice(suffixStart);
  const address = suffixStart < 0 ? url : url.slice(0, suffixStart);
  url = address;
  let baseUrl = url.substring(0, v1Index + 3);

  const openai = 'openai';
  const suffixes = [
    'azure-openai',
    openai,
    'aws-bedrock',
    'anthropic',
    'cohere',
    'deepseek',
    'google-ai-studio',
    'google-vertex-ai',
    'grok',
    'groq',
    'mistral',
    'openrouter',
    'perplexity-ai',
    'replicate',
    'huggingface',
    'workers-ai',
    'aws-bedrock',
  ];
  const suffixUsed = suffixes.find((suffix) => url.includes(`/${suffix}`));

  if (suffixUsed === 'azure-openai') {
    return url.split(/\/(chat|completion)/)[0] + trailing;
  }

  const openaiIndex = url.indexOf(`/${openai}`, v1Index + 3);
  const suffixIndex =
    suffixUsed === openai ? openaiIndex : url.indexOf(`/${suffixUsed}`, v1Index + 3);

  if (openaiIndex === v1Index + 3) {
    const nextSlashIndex = url.indexOf('/', openaiIndex + 7);
    if (nextSlashIndex === -1) {
      baseUrl = url.substring(0, openaiIndex + 7);
    } else {
      baseUrl = url.substring(0, nextSlashIndex);
    }
  } else if (suffixIndex > 0) {
    baseUrl = url.substring(0, suffixIndex + (suffixUsed?.length ?? 0) + 1);
  }

  return baseUrl + trailing;
}

/**
 * Extracts the base URL (protocol + hostname + port) from the provided URL.
 * Used primarily for Ollama endpoints to derive the host.
 * @param fullURL - The full URL.
 * @returns The base URL (protocol://hostname:port).
 */
export function deriveBaseURL(fullURL: string): string {
  try {
    const parsedUrl = new URL(fullURL);
    const protocol = parsedUrl.protocol;
    const hostname = parsedUrl.hostname;
    const port = parsedUrl.port;

    if (!protocol || !hostname) {
      return fullURL;
    }

    return `${protocol}//${hostname}${port ? `:${port}` : ''}`;
  } catch (error) {
    logger.error('Failed to derive base URL', error);
    return fullURL;
  }
}

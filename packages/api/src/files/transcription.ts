import { logger } from '@librechat/data-schemas';
import type { TCustomConfig } from 'librechat-data-provider';

export type STTConfig = NonNullable<NonNullable<TCustomConfig['speech']>['stt']>;
export type OpenAISTTConfig = NonNullable<STTConfig['openai']>;

/** Request hints for a transcription, shared by the recorded and live paths. */
export interface TranscriptionHints {
  prompt?: string;
  keywords?: string[];
  /** Sent only to `gpt-transcribe` models, which reject the singular `language`. */
  languages?: string[];
  /** Sent only to older models (Whisper, `gpt-4o-transcribe`), which reject `languages`. */
  language?: string;
}

/** `gpt-transcribe`, `gpt-live-transcribe`, and their dated snapshots. */
const HINT_MODEL_PATTERN = /(^|\/)gpt-(live-)?transcribe(-|$)/i;
/** OpenAI accepts these regional codes as-is; every other locale is reduced to its language. */
const REGIONAL_LANGUAGES = new Set(['zh-cn', 'zh-tw', 'zh-hk']);

/**
 * Whether the model takes `languages`, `keywords`, and `prompt` hints. These models
 * replace the singular `language` field with `languages`, and the API rejects a
 * request that carries both, so callers must pick one shape per model.
 */
export function usesTranscriptionHints(model?: string | null): boolean {
  return typeof model === 'string' && HINT_MODEL_PATTERN.test(model);
}

/**
 * Reduces a locale like `en-US` to the code the model accepts, or `undefined` when it
 * is not a language code at all (e.g. the `xx-piglatin` browser-only option). Older
 * models take ISO 639-1 only; hint models also take ISO 639-3 and regional Chinese.
 */
export function normalizeTranscriptionLanguage(
  language: string | null | undefined,
  hints: boolean,
): string | undefined {
  if (typeof language !== 'string' || language.length === 0) {
    return undefined;
  }
  const normalized = language.trim().toLowerCase();
  if (hints && REGIONAL_LANGUAGES.has(normalized)) {
    return normalized;
  }
  const pattern = hints ? /^([a-z]{2,3})(-[a-z]{2})?$/ : /^([a-z]{2})(-[a-z]{2})?$/;
  const match = pattern.exec(normalized);
  if (match == null) {
    logger.warn(
      '[STT] Invalid language format. Expected a language code like "en" or "en-US". Skipping language parameter.',
    );
    return undefined;
  }
  return match[1];
}

/**
 * Builds the hints for one transcription. The user's language setting narrows the
 * admin's `languages` list to that one language; without it the admin list applies.
 * `keywords` and `languages` exist only on hint models, so older models receive the
 * singular `language` and an optional `prompt`, exactly as before this config existed.
 */
export function getTranscriptionHints(
  config: Pick<OpenAISTTConfig, 'prompt' | 'keywords' | 'languages'> | undefined,
  model: string | undefined,
  userLanguage?: string | null,
): TranscriptionHints {
  const hints: TranscriptionHints = {};
  const prompt = config?.prompt?.trim();
  if (prompt) {
    hints.prompt = prompt;
  }

  if (!usesTranscriptionHints(model)) {
    const language = normalizeTranscriptionLanguage(userLanguage, false);
    if (language) {
      hints.language = language;
    }
    return hints;
  }

  const keywords = config?.keywords?.filter(
    (keyword): keyword is string => typeof keyword === 'string' && keyword.length > 0,
  );
  if (keywords?.length) {
    hints.keywords = keywords;
  }

  const userCode = normalizeTranscriptionLanguage(userLanguage, true);
  const languages = userCode
    ? [userCode]
    : (config?.languages ?? [])
        .map((code) => (typeof code === 'string' ? code.toLowerCase() : undefined))
        .filter((code): code is string => !!code);
  if (languages.length > 0) {
    hints.languages = [...new Set(languages)];
  }
  return hints;
}

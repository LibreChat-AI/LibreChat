import { Providers } from '@librechat/agents';
import { ContentTypes } from 'librechat-data-provider';
import type { MessageContentComplex } from '@librechat/agents';

/**
 * Native YouTube -> Gemini video-understanding support for the Google `url_context` param.
 *
 * The Gemini URL Context tool does NOT support YouTube as a content type; YouTube must be
 * passed as a video part (`fileData.fileUri`) via the video-understanding path. When
 * `url_context` is enabled we detect YouTube URLs in the user's message and inject them as
 * `{ type: 'media', fileUri }` content blocks, which the `@librechat/agents` Google content
 * formatter converts into `fileData` parts. All other URLs keep flowing through the native
 * `urlContext` tool.
 */

/** Per-message cap on auto-injected YouTube video parts for Gemini 2.5+ (the API allows up to 10). */
export const DEFAULT_MAX_YOUTUBE_PARTS = 5;

/** Canonical form every extracted YouTube link is normalized to before injection. */
const YOUTUBE_WATCH_PREFIX = 'https://www.youtube.com/watch?v=';

/** A Gemini video-understanding content block (becomes a `fileData` part downstream). */
export interface YouTubeVideoPart {
  type: 'media';
  /**
   * Always present as a key so the agents `messageContentMedia` `'mimeType' in content` guard
   * passes. The Gemini Developer API omits it for YouTube (value `undefined`, dropped on JSON
   * serialization); Vertex samples set `video/mp4`.
   */
  mimeType?: string;
  fileUri: string;
}

const GEMINI_VERSION_REGEX = /gemini-(\d+)(?:\.(\d+))?/i;

/** Gemini 2.5+ models accept up to 10 YouTube videos per request; earlier models accept 1. */
function isGemini25OrLater(model?: string): boolean {
  if (typeof model !== 'string') {
    return false;
  }
  const match = GEMINI_VERSION_REGEX.exec(model);
  if (!match) {
    return false;
  }
  const major = Number(match[1]);
  const minor = Number(match[2] ?? '0');
  return major > 2 || (major === 2 && minor >= 5);
}

/**
 * Resolves provider/model-aware YouTube injection limits.
 * - Vertex: every Vertex sample sets a `video/mp4` mimeType on YouTube fileData, and Vertex is
 *   capped conservatively at a single YouTube URL per request.
 * - Gemini Developer API: omits the mimeType; 2.5+ models accept multiple videos, earlier ones one.
 */
export function resolveYouTubeInjectionConfig(params: { provider?: string; model?: string }): {
  max: number;
  mimeType?: string;
} {
  if (params.provider === Providers.VERTEXAI) {
    return { max: 1, mimeType: 'video/mp4' };
  }
  return { max: isGemini25OrLater(params.model) ? DEFAULT_MAX_YOUTUBE_PARTS : 1 };
}

/** 11-char video id. */
const ID = '[A-Za-z0-9_-]{11}';
/**
 * Allowlist of characters that occur in a YouTube URL path/query; anything else ends the match.
 * The detection tail excludes `:` — it never appears in a real YouTube path/query, but `://` of a
 * *nested* URL does, so excluding it lets the scan stop and find e.g.
 * `watch?url=https://youtu.be/<id>`. The strip tail re-adds `:` so the whole URL token (including a
 * trailing URL-valued param like `&next=https://example.com`) is consumed and nothing is orphaned.
 */
const DETECT_TAIL = '[A-Za-z0-9\\-._~%/?&=#@+]*';
const STRIP_TAIL = '[A-Za-z0-9\\-._~%/?&=#@+:]*';

/**
 * Builds the linear YouTube URL matcher (restricted to recognized single-video forms):
 *   - `youtu.be/<id>`                                      (group 1 = id)
 *   - `youtube[-nocookie].com/(shorts|live|embed|v)/<id>`  (group 2 = id)
 *   - `youtube[-nocookie].com/watch?<query>`               (group 3 = query, `v=` parsed afterwards)
 *
 * Properties that matter:
 *   - Linear (no ReDoS): each branch consumes its match in a single greedy pass, the `v=` location
 *     is parsed from the captured query (not re-scanned per occurrence), and the subdomain
 *     repetition is bounded (`{1,63}` label x `{0,10}` labels). Needs no scan caps.
 *   - Restricting to recognized routes means an UNrecognized YouTube URL (e.g. `/redirect?q=...`)
 *     does not match, so the global scan continues and still finds a nested `youtu.be/<id>`.
 *   - The path/query allowlist ends the match at prose delimiters, so adjacent links in one token
 *     (comma/semicolon/pipe-separated, markdown `](url1)](url2)`) are matched separately.
 *   - The leading lookbehind rejects hosts embedded in a longer domain (`notyoutube.com`,
 *     `evil-youtube.com`).
 */
function createYouTubeRegex(tail: string): RegExp {
  return new RegExp(
    '(?<![\\w.-])(?:https?:\\/\\/)?(?:' +
      `youtu\\.be\\/(${ID})(?![A-Za-z0-9_-])${tail}` +
      '|(?:(?:[a-z0-9-]{1,63}\\.){0,10}youtube\\.com|(?:www\\.)?youtube-nocookie\\.com)\\/(?:' +
      `(?:shorts|live|embed|v)\\/(${ID})(?![A-Za-z0-9_-])${tail}` +
      `|watch\\?(${tail})` +
      '))',
    'gi',
  );
}

/** Detection matcher: `:`-excluded tail so nested video URLs are discoverable. */
const YOUTUBE_URL_REGEX = createYouTubeRegex(DETECT_TAIL);
/** Strip matcher: `:`-inclusive tail so a matched URL is removed whole (no orphaned `://...`). */
const YOUTUBE_STRIP_REGEX = createYouTubeRegex(STRIP_TAIL);

/** Matches an 11-char video id at the start of a string, rejecting longer id-like tokens. */
const VIDEO_ID_REGEX = /^([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/;
/** Iterates every `v` query parameter value (global; values length-bounded — an id is 11 chars). */
const V_PARAM_REGEX = /(?:^|&)v=([A-Za-z0-9_-]{1,64})/gi;
/** A YouTube link carries a user-selected moment (e.g. `?t=90`, `&start=90`, before or after `v=`). */
const YOUTUBE_TIMESTAMP_REGEX = /[?&](?:t|start)=/i;

/**
 * Resolves the 11-char video id from the matcher's capture groups. The path-based ids (groups 1
 * and 2) are already validated by the regex; the watch query (group 3) is scanned for the first
 * `v=` whose value is a valid id, so a malformed earlier `v=` does not shadow a later valid one.
 */
function videoIdFromGroups(
  youtuBeId?: string,
  pathId?: string,
  watchQuery?: string,
): string | null {
  const directId = youtuBeId ?? pathId;
  if (directId != null) {
    return directId;
  }
  if (watchQuery == null) {
    return null;
  }
  for (const paramMatch of watchQuery.matchAll(V_PARAM_REGEX)) {
    const id = VIDEO_ID_REGEX.exec(paramMatch[1])?.[1];
    if (id != null) {
      return id;
    }
  }
  return null;
}

/**
 * Removes from text only the YouTube URL tokens whose video id was injected as a video part and
 * that do not carry a timestamp. Over-limit links (not injected) and timestamped links are kept so
 * the model can still see/reason about them. Tidies leftover horizontal whitespace when changed.
 */
function stripYouTubeUrls(text: string, injectedIds: Set<string>): string {
  if (text.length === 0) {
    return text;
  }
  let changed = false;
  const replaced = text.replace(YOUTUBE_STRIP_REGEX, (match, youtuBeId, pathId, watchQuery) => {
    const id = videoIdFromGroups(youtuBeId, pathId, watchQuery);
    if (id == null || !injectedIds.has(id)) {
      return match;
    }
    /** Test the whole URL: the timestamp can precede `v=` (e.g. `watch?t=90&v=<id>`). */
    if (YOUTUBE_TIMESTAMP_REGEX.test(match)) {
      return match;
    }
    changed = true;
    return '';
  });
  if (!changed) {
    return text;
  }
  return replaced
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function resolveLimit(max?: number): number {
  if (max == null || !Number.isFinite(max)) {
    return DEFAULT_MAX_YOUTUBE_PARTS;
  }
  return Math.max(0, Math.floor(max));
}

/**
 * Extracts YouTube URLs from text, normalized to canonical `watch?v=<id>` form, de-duplicated
 * by video id (first occurrence wins), and capped at `max` (default {@link DEFAULT_MAX_YOUTUBE_PARTS}).
 */
export function extractYouTubeUrls(text?: string | null, max?: number): string[] {
  const limit = resolveLimit(max);
  if (limit === 0 || typeof text !== 'string' || text.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const urls: string[] = [];
  YOUTUBE_URL_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = YOUTUBE_URL_REGEX.exec(text)) !== null) {
    const videoId = videoIdFromGroups(match[1], match[2], match[3]);
    if (videoId == null || seen.has(videoId)) {
      continue;
    }
    seen.add(videoId);
    urls.push(`${YOUTUBE_WATCH_PREFIX}${videoId}`);
    if (urls.length >= limit) {
      break;
    }
  }
  return urls;
}

/** True when the resolved provider tool list contains the native Google `urlContext` tool. */
export function hasUrlContextTool(tools: unknown): boolean {
  if (!Array.isArray(tools)) {
    return false;
  }
  return tools.some((tool) => tool != null && typeof tool === 'object' && 'urlContext' in tool);
}

/**
 * True when a formatted message carries a YouTube video part produced by
 * `appendYouTubeVideoParts`. Read after injection so a provider rejection can be attributed to the
 * video rather than reported as a generic failure — Google returns the same opaque
 * `INVALID_ARGUMENT` for an over-length or otherwise unreadable video as for unrelated bad input.
 */
export function hasYouTubeVideoParts(content: string | MessageContentComplex[]): boolean {
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((part) => {
    if (part == null || typeof part !== 'object') {
      return false;
    }
    const { fileUri } = part as { fileUri?: unknown };
    return typeof fileUri === 'string' && fileUri.startsWith(YOUTUBE_WATCH_PREFIX);
  });
}

function toBaseParts(content: string | MessageContentComplex[]): MessageContentComplex[] {
  if (Array.isArray(content)) {
    return content;
  }
  if (typeof content === 'string' && content.length > 0) {
    return [{ type: ContentTypes.TEXT, text: content } as MessageContentComplex];
  }
  return [];
}

function stripYouTubeFromTextParts(
  parts: MessageContentComplex[],
  injectedIds: Set<string>,
): MessageContentComplex[] {
  const result: MessageContentComplex[] = [];
  for (const part of parts) {
    const record = part as Record<string, unknown>;
    if (record != null && record.type === ContentTypes.TEXT && typeof record.text === 'string') {
      const stripped = stripYouTubeUrls(record.text, injectedIds);
      if (stripped.length > 0) {
        result.push({ ...record, text: stripped } as MessageContentComplex);
      }
      continue;
    }
    result.push(part);
  }
  return result;
}

function collectFileUris(parts: MessageContentComplex[]): Set<string> {
  const uris = new Set<string>();
  for (const part of parts) {
    if (part == null || typeof part !== 'object') {
      continue;
    }
    const record = part as Record<string, unknown>;
    if (typeof record.fileUri === 'string') {
      uris.add(record.fileUri);
    }
    const fileData = record.fileData as { fileUri?: unknown } | undefined;
    if (fileData != null && typeof fileData.fileUri === 'string') {
      uris.add(fileData.fileUri);
    }
  }
  return uris;
}

/**
 * Appends YouTube video parts to a message's content when `url_context` is enabled, and removes
 * the matched YouTube URLs from the prompt text so the `urlContext` tool (which reads URLs from
 * the text and cannot fetch YouTube) does not spend its URL budget on them. Non-YouTube URLs are
 * left intact for the tool. No-ops when disabled, when no YouTube URLs are found, or when every
 * URL is already present as a media part. A string content is upgraded to a parts array only when
 * something is added.
 */
export function appendYouTubeVideoParts(params: {
  enabled: boolean;
  text?: string | null;
  content: string | MessageContentComplex[];
  max?: number;
  mimeType?: string;
}): string | MessageContentComplex[] {
  const { enabled, text, content, max, mimeType } = params;
  if (!enabled) {
    return content;
  }

  const urls = extractYouTubeUrls(text, max);
  if (urls.length === 0) {
    return content;
  }

  const baseParts = toBaseParts(content);
  const existing = collectFileUris(baseParts);
  const newParts = urls
    .filter((url) => !existing.has(url))
    .map((fileUri) => ({ type: 'media', mimeType, fileUri }) as MessageContentComplex);

  if (newParts.length === 0) {
    return content;
  }

  /** Only strip the links actually routed to video (capped + deduped set); over-limit links stay. */
  const injectedIds = new Set(
    urls.map((url) => new URL(url).searchParams.get('v')).filter((id): id is string => id != null),
  );
  return [...stripYouTubeFromTextParts(baseParts, injectedIds), ...newParts];
}

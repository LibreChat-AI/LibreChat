/** Cache Storage names earlier builds persisted read-aloud audio under (the first keyed by the
 *  message text). Audio is now held only in this tab's memory, so these are just deleted. */
const LEGACY_TTS_CACHE_NAMES = ['tts-responses', 'tts-responses-v1', 'tts-responses-v1:pending'];
const MAX_ENTRIES = 50;
/** Long replies make large recordings, so the cache is bounded by size as well as count. */
const MAX_BYTES = 32 * 1024 * 1024;

/** Spoken audio by hashed key, oldest first; it never leaves this tab and dies with it. */
const audioByKey = new Map<string, Blob>();
let totalBytes = 0;
/** Bumped on every clear, so a request that was in flight across a logout cannot write. */
let generation = 0;
/** The account the cached audio belongs to. */
let ownerId: string | undefined;

const toHex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');

/** Returns a SHA-256 hash of the user, voice and spoken text, so the cache holds no message text
 *  and one account can never match another's audio. Returns null when hashing is unavailable
 *  (no secure context); the caller skips the cache. */
export async function getTTSCacheKey(
  text: string,
  voice?: string | null,
  userId?: string | null,
): Promise<string | null> {
  if (!text || typeof crypto === 'undefined' || !crypto.subtle) {
    return null;
  }
  try {
    const data = new TextEncoder().encode(JSON.stringify([userId ?? '', voice ?? '', text]));
    return toHex(await crypto.subtle.digest('SHA-256', data));
  } catch {
    return null;
  }
}

export const getTTSCacheGeneration = (): number => generation;

export const hasCachedTTSAudio = (): boolean => audioByKey.size > 0;

/** Whether an earlier build's audio may still be on disk (its delete failed), so it can be
 *  retried. A check that fails reads as "may be", which keeps the retry available. */
export async function hasLegacyTTSCache(): Promise<boolean> {
  if (typeof caches === 'undefined') {
    return false;
  }
  try {
    const found = await Promise.all(LEGACY_TTS_CACHE_NAMES.map((name) => caches.has(name)));
    return found.some(Boolean);
  } catch {
    return true;
  }
}

export function getCachedTTSAudio(key: string): Blob | undefined {
  const audio = audioByKey.get(key);
  if (audio) {
    /** Most recently played stays last, so eviction drops the least recently used. */
    audioByKey.delete(key);
    audioByKey.set(key, audio);
  }
  return audio;
}

const removeAudio = (key: string): void => {
  const audio = audioByKey.get(key);
  if (audio) {
    totalBytes -= audio.size;
    audioByKey.delete(key);
  }
};

/** Stores audio for a request started at `requestGeneration`; skipped if a clear came since, or
 *  if the recording alone exceeds the size budget. */
export function setCachedTTSAudio(key: string, audio: Blob, requestGeneration: number): void {
  if (requestGeneration !== generation || audio.size > MAX_BYTES) {
    return;
  }
  removeAudio(key);
  audioByKey.set(key, audio);
  totalBytes += audio.size;
  while (audioByKey.size > MAX_ENTRIES || totalBytes > MAX_BYTES) {
    const oldest = audioByKey.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    removeAudio(oldest);
  }
}

/** Drops every cached recording and any audio earlier versions left in Cache Storage. */
export function clearTTSCache(): Promise<void> {
  audioByKey.clear();
  totalBytes = 0;
  generation += 1;
  ownerId = undefined;
  if (typeof caches === 'undefined') {
    return Promise.resolve();
  }
  /** Settles when the legacy deletes do; callers that need not know can ignore it. */
  return Promise.all(
    LEGACY_TTS_CACHE_NAMES.map((name) =>
      Promise.resolve()
        .then(() => caches.delete(name))
        .catch(() => false),
    ),
  ).then(() => undefined);
}

/** Records the signed-in account; signing in as a different one in this tab empties the cache. */
export function setTTSCacheOwner(userId?: string | null): void {
  if (!userId) {
    return;
  }
  /** Audio recorded while no owner was set (after a clear) is not handed to whoever signs in. */
  if (ownerId !== userId && (ownerId !== undefined || audioByKey.size > 0)) {
    void clearTTSCache();
  } else if (ownerId !== userId) {
    /** A request started before this account signed in cannot write into its cache. */
    generation += 1;
  }
  ownerId = userId;
}

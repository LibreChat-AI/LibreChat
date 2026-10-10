import { logger } from '@librechat/data-schemas';

/**
 * What TensorGrid's catalog says about each model, for the model picker: which
 * ones are free, and each one's category (`language`, `image`, `embeddings`,
 * `transcription`), so only chat models are offered as chat models.
 *
 * Read from the Tchat broker, which alone can reach TensorGrid's backend; the
 * broker caches the catalog, and this process holds the answer for a minute so
 * a page load never waits on it. Any failure yields an empty catalog: a model
 * the picker knows nothing about is shown untagged, never hidden.
 */
export interface TchatModelCatalog {
  free: string[];
  categories: Record<string, string>;
}

const TTL_MS = 60_000;
const TIMEOUT_MS = 5_000;
const EMPTY: TchatModelCatalog = { free: [], categories: {} };

let cached: { value: TchatModelCatalog; expiresAt: number } | null = null;

function parseCatalog(body: unknown): TchatModelCatalog {
  const { free, categories } = (body ?? {}) as { free?: unknown; categories?: unknown };
  const parsed: TchatModelCatalog = {
    free: Array.isArray(free) ? free.filter((id): id is string => typeof id === 'string') : [],
    categories: {},
  };
  if (categories && typeof categories === 'object') {
    for (const [id, category] of Object.entries(categories as Record<string, unknown>)) {
      if (typeof category === 'string') {
        parsed.categories[id] = category;
      }
    }
  }
  return parsed;
}

/** Only the call signature; `typeof fetch` also demands Node's `preconnect`. */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function getTchatModelCatalog(
  fetchImpl: FetchLike = fetch,
): Promise<TchatModelCatalog> {
  const origin = (process.env.TCHAT_BROKER_ORIGIN ?? '').trim().replace(/\/+$/, '');
  const key = (process.env.TCHAT_BROKER_SHARED_KEY ?? '').trim();
  if (!origin || !key) {
    return EMPTY;
  }
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  try {
    const response = await fetchImpl(`${origin}/tchat/catalog/models`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`broker answered ${response.status}`);
    }
    const value = parseCatalog(await response.json());
    cached = { value, expiresAt: Date.now() + TTL_MS };
    return value;
  } catch (error) {
    logger.warn(`[tchat] model catalog unavailable: ${(error as Error)?.message ?? error}`);
    return cached?.value ?? EMPTY;
  }
}

/** Test seam: forget the cached catalog. */
export function resetTchatModelCatalogCache(): void {
  cached = null;
}

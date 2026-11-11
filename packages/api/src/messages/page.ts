import { logger } from '@librechat/data-schemas';
import type { AppConfigUserLike } from '~/app/service';
import type { ToolCallPreviewDeps } from './previews';
import { getAppConfigOptionsFromUser } from '~/app/service';

export const DEFAULT_MESSAGES_PAGE_SIZE = 25;
/** Default ceiling, matching the search page ceiling; `messages.maxPageSize` overrides it. */
export const MAX_MESSAGES_PAGE_SIZE = 1000;

/** Parses the client `pageSize` query value, falling back to the default and never exceeding the cap. */
export function parseMessagesPageSize(
  raw: unknown,
  maxPageSize: number = MAX_MESSAGES_PAGE_SIZE,
): number {
  const parsed =
    typeof raw === 'string' || typeof raw === 'number' ? parseInt(String(raw), 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Math.min(DEFAULT_MESSAGES_PAGE_SIZE, maxPageSize);
  }
  return Math.min(parsed, maxPageSize);
}

/**
 * Parses the client `pageSize` against the deployment's `messages.maxPageSize`. The config read skips
 * runtime augmentation and is meant to start beside the message reads; an unavailable config keeps
 * the default ceiling instead of failing the load.
 */
export async function resolveMessagesPageSize(
  user: AppConfigUserLike | undefined,
  raw: unknown,
  deps: ToolCallPreviewDeps,
): Promise<number> {
  try {
    const config = await deps.getAppConfig({
      ...getAppConfigOptionsFromUser(user),
      skipRuntimeAugmentation: true,
    });
    return parseMessagesPageSize(raw, config?.messages?.maxPageSize ?? MAX_MESSAGES_PAGE_SIZE);
  } catch (error) {
    logger.warn('[messages] Config unavailable; using the default page size ceiling', error);
    return parseMessagesPageSize(raw);
  }
}

/**
 * Waits for the resolved page size while `pending` reads run beside it. They are observed so one
 * that rejects first is not an unhandled rejection; each stays awaitable by the caller.
 */
export async function awaitPageSize(
  pageSize: Promise<number>,
  ...pending: Promise<unknown>[]
): Promise<number> {
  for (const read of pending) {
    read.catch(() => undefined);
  }
  return pageSize;
}

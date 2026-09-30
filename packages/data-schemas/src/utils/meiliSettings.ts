import { getConfigDefaults } from 'librechat-data-provider';

/** Compatibility default matching the previous hard-coded 10-minute wait. */
export const DEFAULT_MEILI_SETTINGS_TIMEOUT_MS: number = 10 * 60_000;

export const REQUIRED_MEILI_FILTERABLE_ATTRIBUTES: readonly ['user', 'tenantId'] = [
  'user',
  'tenantId',
] as const;

type MeiliSettingsTask = {
  status: string;
};

type MeiliSettingsClient = {
  waitForTask: (
    taskUid: number,
    options: { timeOutMs: number; intervalMs: number },
  ) => Promise<MeiliSettingsTask>;
};

type MeiliSettingsIndex = {
  updateSettings: (settings: {
    filterableAttributes: string[];
  }) => Promise<{ taskUid: number }>;
};

/**
 * Resolves the Meili settings-task timeout from `librechat.yaml` (`search.meiliSettingsTimeoutMs`)
 * or the schema default when unset.
 */
export function resolveMeiliSettingsTimeoutMs(configured?: number | null): number {
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  const defaults = getConfigDefaults();
  return defaults.search?.meiliSettingsTimeoutMs ?? DEFAULT_MEILI_SETTINGS_TIMEOUT_MS;
}

/**
 * Merges required filterable attributes into the operator-configured list.
 * Returns `null` when the current settings already include every required attribute
 * in a set-equal form (order-preserving for unchanged lists).
 */
export function mergeFilterableAttributes(
  configuredAttributes: string[] | null | undefined,
  requiredAttributes: readonly string[] = REQUIRED_MEILI_FILTERABLE_ATTRIBUTES,
): string[] | null {
  const current = Array.isArray(configuredAttributes) ? configuredAttributes : [];
  const merged = [...new Set([...current, ...requiredAttributes])];
  const unchanged =
    merged.length === current.length &&
    merged.every((attribute, index) => attribute === current[index]);
  return unchanged ? null : merged;
}

/**
 * Enqueues a filterable-attributes update and waits for the Meili task to succeed.
 */
export async function updateFilterableAttributes({
  client,
  index,
  filterableAttributes,
  timeoutMs,
  context = '[meiliSettings]',
}: {
  client: MeiliSettingsClient;
  index: MeiliSettingsIndex;
  filterableAttributes: string[];
  timeoutMs?: number;
  context?: string;
}): Promise<void> {
  const enqueued = await index.updateSettings({ filterableAttributes });
  const task = await client.waitForTask(enqueued.taskUid, {
    timeOutMs: resolveMeiliSettingsTimeoutMs(timeoutMs),
    intervalMs: 100,
  });
  if (task.status !== 'succeeded') {
    throw new Error(`${context} Meili settings task ${enqueued.taskUid} ended with ${task.status}`);
  }
}

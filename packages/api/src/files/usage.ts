/** Cap per usage touch, mirroring the composer's practical attachment limit. */
export const FILES_USAGE_MAX_IDS: number = 10;

/**
 * Baseline lifetime a held upload gets, measured from its upload time. Covers
 * the span a queued attachment spends before a run can even pause: upload,
 * enqueue, and the run itself reaching an approval point.
 */
export const FILES_USAGE_BASE_HOLD_MS: number = 24 * 60 * 60 * 1000;

/**
 * Queued runs a held attachment is assumed to wait behind. The queue is
 * unbounded, so no multiple is provably sufficient; this is the depth the
 * ceiling covers before a still-queued attachment can lapse.
 */
export const FILES_USAGE_QUEUED_RUN_ALLOWANCE: number = 8;

export interface FilesUsageHold {
  /** Granted from now, so an actively draining queue keeps renewing. */
  renewMs: number;
  /** Hard ceiling from upload time, so renewals converge instead of walking. */
  maxLifetimeMs: number;
}

/**
 * Resolves the hold window for one touch.
 *
 * A queued message legitimately outlives the upload window when a run pauses
 * for approval, and that pause is bounded by the deployment's configured
 * approval window (`endpoints.agents.checkpointer.ttl`), which has no upper
 * limit. Deeper queues wait behind several such runs, since the drain sends
 * one item per run completion.
 *
 * Hence two numbers rather than one. `renewMs` covers a single run's wait and
 * is granted from now, so a queue that is still draining re-asserts it at each
 * transition. `maxLifetimeMs` is measured from the immutable upload time and
 * caps every renewal, so repeated touches converge on a fixed ceiling instead
 * of advancing a window per call. An abandoned queue therefore lapses one
 * `renewMs` after its last touch rather than surviving to the ceiling.
 *
 * @param approvalTtlMs - Configured approval window; falsy means none configured
 */
export function resolveFilesUsageHold(approvalTtlMs?: number): FilesUsageHold {
  const approval = Number.isFinite(approvalTtlMs) && approvalTtlMs! > 0 ? approvalTtlMs! : 0;
  return {
    renewMs: FILES_USAGE_BASE_HOLD_MS + approval,
    maxLifetimeMs: FILES_USAGE_BASE_HOLD_MS + approval * FILES_USAGE_QUEUED_RUN_ALLOWANCE,
  };
}

export interface FilesUsageUser {
  id?: string;
  tenantId?: string;
}

export interface FilesUsageBody {
  file_ids?: unknown;
}

/** HTTP-shaped outcome the thin route wrapper serializes verbatim. */
export interface FilesUsageResult {
  status: number;
  body: Record<string, unknown>;
}

export interface FilesUsageDeps {
  /** Owner-scoped TTL hold (`db.extendFilesTTL`-shaped). */
  extendFilesTTL: (
    fileIds: string[],
    hold: FilesUsageHold,
    owner: { user: string; tenantId?: string | null },
  ) => Promise<number>;
  /** Configured approval window, so the hold outlasts a paused run. */
  approvalTtlMs?: number;
}

/**
 * Owner-scoped TTL hold for attachments entering a client-side queue: a
 * queued message can outlive the upload window (long run, approval pause),
 * so holding at queue time stops the TTL from reaping files the drain will
 * send.
 *
 * A hold, not a release. The client queue is ephemeral browser state, so a
 * closed tab or a cleared queue leaves nothing referencing these files, and
 * clearing the TTL outright would strand them in storage permanently. The
 * hold only ever widens, and every renewal is capped against the file's
 * upload time, so replaying it converges on a ceiling instead of advancing
 * indefinitely; the real release happens at send, where `updateFilesUsage`
 * marks the files used against an actual message.
 *
 * The window tracks the deployment's configured approval TTL so a queue
 * waiting on a paused run cannot be reaped while that approval is live.
 *
 * Best-effort 200: ids that do not resolve to a held file are not errors
 * (they may be already-sent files, or not owned).
 */
export async function handleFilesUsageRequest(
  user: FilesUsageUser,
  body: FilesUsageBody,
  deps: FilesUsageDeps,
): Promise<FilesUsageResult> {
  if (!user.id) {
    return { status: 401, body: { code: 'UNAUTHORIZED' } };
  }
  const raw = body.file_ids;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { status: 400, body: { code: 'INVALID_FILE_IDS' } };
  }
  if (raw.length > FILES_USAGE_MAX_IDS) {
    return { status: 400, body: { code: 'TOO_MANY_FILES', max: FILES_USAGE_MAX_IDS } };
  }
  const fileIds: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string' || value.length === 0) {
      return { status: 400, body: { code: 'INVALID_FILE_IDS' } };
    }
    fileIds.push(value);
  }
  const held = await deps.extendFilesTTL(fileIds, resolveFilesUsageHold(deps.approvalTtlMs), {
    user: user.id,
    tenantId: user.tenantId,
  });
  return { status: 200, body: { held } };
}

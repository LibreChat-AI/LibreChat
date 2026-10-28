/** Wall-clock phases of one tool call, never batch or database execution time. */
export type ToolTimingStamps = {
  observedAt?: number;
  dispatchedAt?: number;
  completedAt?: number;
};

const validTime = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Omit an interval rather than presenting clock skew or a missing stamp as measured time. */
export function getToolTimingDurations({
  observedAt,
  dispatchedAt,
  completedAt,
}: ToolTimingStamps): {
  toolPreparationDurationMs?: number;
  toolExecutionDurationMs?: number;
} {
  if (!validTime(dispatchedAt)) return {};
  return {
    ...(validTime(observedAt) && observedAt <= dispatchedAt
      ? { toolPreparationDurationMs: dispatchedAt - observedAt }
      : {}),
    ...(validTime(completedAt) && dispatchedAt <= completedAt
      ? { toolExecutionDurationMs: completedAt - dispatchedAt }
      : {}),
  };
}

/**
 * Age of a generation computed entirely on this process's clock, for status
 * responses whose clients rebuild a clock-local elapsed baseline instead of
 * comparing timestamps across machines. Clamped: a job stamped by a replica
 * whose clock ran ahead of this one must never report a negative age.
 */
export function getGenerationElapsedMs(job: { createdAt: number }): number {
  return Math.max(0, Date.now() - job.createdAt);
}

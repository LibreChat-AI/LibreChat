import type { CodeWorkerEnrollmentPolicy } from 'librechat-data-provider';

/** A principal override can restrict enrollment, never expand deployment authority.
 * Missing effective fields inherit the deployment policy. Invalid programmatic
 * limits fail closed, even when the caller did not pass through config validation.
 */
export function resolveCodeWorkerEnrollmentLimit(
  deployment?: CodeWorkerEnrollmentPolicy,
  effective?: CodeWorkerEnrollmentPolicy,
  fallback = 5,
): number {
  if (deployment?.enabled === false || effective?.enabled === false) {
    return 0;
  }
  const ceiling = deployment?.maxPerUser ?? fallback;
  const requested = effective?.maxPerUser ?? ceiling;
  if (
    !Number.isSafeInteger(ceiling) ||
    !Number.isSafeInteger(requested) ||
    ceiling < 0 ||
    requested < 0
  ) {
    return 0;
  }
  return Math.min(ceiling, requested);
}

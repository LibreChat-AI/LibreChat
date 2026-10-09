import type { Response, NextFunction } from 'express';

export const SCHEDULES_NOT_READY_CODE = 'SCHEDULES_NOT_READY';
export const SCHEDULES_UNAVAILABLE_CODE = 'SCHEDULES_UNAVAILABLE';

/**
 * Whether the schedule engine has been armed for this process.
 *
 * `starting` and `unavailable` both refuse writes, but they are not the same condition:
 * arming is attempted EXACTLY ONCE at boot, so a failed arm is terminal for the life of
 * the process. Collapsing the two into a single flag is what let a permanent outage be
 * advertised with `Retry-After`.
 */
export type ScheduleEngineState = 'starting' | 'armed' | 'unavailable';

/**
 * Reads and deletes never touch the engine: listing schedules, and removing one so it can
 * no longer fire, must keep working even where nothing is armed.
 */
const ENGINE_OPTIONAL_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'DELETE']);

export interface ScheduleWriteGateOptions {
  getState: () => ScheduleEngineState;
  /** `Retry-After` for the genuinely transient window only. */
  retryAfterSeconds: string;
}

export type ScheduleWriteGate = (
  req: { method: string },
  res: Response,
  next: NextFunction,
) => Response | void;

/**
 * Guards schedule writes on engine readiness, answering with the retry contract that
 * matches the real state: retry while arming is still pending, and a terminal refusal once
 * it has definitively failed — nothing re-attempts arming, so a client obeying
 * `Retry-After` there would poll a condition that cannot change without operator action.
 */
export function createScheduleWriteGate({
  getState,
  retryAfterSeconds,
}: ScheduleWriteGateOptions): ScheduleWriteGate {
  return function rejectScheduleWritesUntilReady(
    req: { method: string },
    res: Response,
    next: NextFunction,
  ): Response | void {
    const state = getState();
    if (state === 'armed' || ENGINE_OPTIONAL_METHODS.has(req.method)) {
      return next();
    }
    if (state === 'starting') {
      res.set('Retry-After', retryAfterSeconds);
      return res.status(503).json({
        code: SCHEDULES_NOT_READY_CODE,
        error: 'Scheduler is still starting. Please retry shortly.',
      });
    }
    return res.status(503).json({
      code: SCHEDULES_UNAVAILABLE_CODE,
      error:
        'Scheduler is unavailable in this deployment. Retrying will not help — check the server logs and resolve the startup failure.',
    });
  };
}

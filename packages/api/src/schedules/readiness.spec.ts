import type { Response } from 'express';
import type { ScheduleEngineState } from './readiness';
import {
  createScheduleWriteGate,
  SCHEDULES_NOT_READY_CODE,
  SCHEDULES_UNAVAILABLE_CODE,
} from './readiness';

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    set(name: string, value: string) {
      res.headers[name] = value;
      return res;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

function run(state: ScheduleEngineState, method: string) {
  const res = makeRes();
  const next = jest.fn();
  createScheduleWriteGate({ getState: () => state, retryAfterSeconds: '1' })(
    { method },
    res as unknown as Response,
    next,
  );
  return { res, next };
}

describe('createScheduleWriteGate', () => {
  it('passes writes through once the engine is armed', () => {
    const { res, next } = run('armed', 'POST');
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(0);
  });

  it.each(['GET', 'HEAD', 'OPTIONS', 'DELETE'])(
    'never blocks %s, which does not need the engine',
    (method) => {
      for (const state of ['starting', 'unavailable'] as ScheduleEngineState[]) {
        const { res, next } = run(state, method);
        expect(next).toHaveBeenCalled();
        expect(res.statusCode).toBe(0);
      }
    },
  );

  it('advertises a retry only while arming is genuinely still pending', () => {
    const { res, next } = run('starting', 'POST');
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('1');
    expect(res.body).toMatchObject({ code: SCHEDULES_NOT_READY_CODE });
  });

  it('refuses terminally, without Retry-After, once arming has failed', () => {
    const { res, next } = run('unavailable', 'POST');
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    // Nothing re-attempts arming, so a client obeying Retry-After here would poll a
    // condition that cannot change without operator action.
    expect(res.headers['Retry-After']).toBeUndefined();
    expect(res.body).toMatchObject({ code: SCHEDULES_UNAVAILABLE_CODE });
  });

  it('re-reads the state on every request rather than capturing it at construction', () => {
    let state: ScheduleEngineState = 'starting';
    const gate = createScheduleWriteGate({ getState: () => state, retryAfterSeconds: '1' });

    const blocked = makeRes();
    gate({ method: 'POST' }, blocked as unknown as Response, jest.fn());
    expect(blocked.statusCode).toBe(503);

    state = 'armed';
    const allowed = makeRes();
    const next = jest.fn();
    gate({ method: 'POST' }, allowed as unknown as Response, next);
    expect(next).toHaveBeenCalled();
    expect(allowed.statusCode).toBe(0);
  });
});

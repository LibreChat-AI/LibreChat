import type { NextFunction, Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { requireFeedbackEnabled } from './feedback';

function createResponse() {
  const res = {
    statusCode: undefined as number | undefined,
    body: undefined as unknown,
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

function run(req: Partial<ServerRequest>) {
  const res = createResponse();
  const next = jest.fn() as unknown as NextFunction;
  requireFeedbackEnabled(req as ServerRequest, res as unknown as Response, next);
  return { res, next };
}

describe('requireFeedbackEnabled', () => {
  it('rejects the write when the interface disables feedback', () => {
    const { res, next } = run({
      config: { interfaceConfig: { feedback: false } },
    } as Partial<ServerRequest>);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Feedback is disabled' });
    expect(next).not.toHaveBeenCalled();
  });

  it('allows the write when the interface enables feedback', () => {
    const { res, next } = run({
      config: { interfaceConfig: { feedback: true } },
    } as Partial<ServerRequest>);

    expect(res.statusCode).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows the write when the flag is unconfigured', () => {
    const { next } = run({ config: { interfaceConfig: {} } } as Partial<ServerRequest>);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows the write when no app config reached the request', () => {
    const { next } = run({});

    expect(next).toHaveBeenCalledTimes(1);
  });
});

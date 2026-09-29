import type { Request, Response } from 'express';
import { createConfigRevisionHandler } from './status';

function response() {
  const res = { set: jest.fn(), sendStatus: jest.fn(), json: jest.fn() };
  return res;
}

describe('local model revision route', () => {
  it('does not read or expose model revision to anonymous callers', async () => {
    const read = jest.fn();
    const res = response();
    await createConfigRevisionHandler(read)({} as Request, res as unknown as Response, jest.fn());
    expect(res.sendStatus).toHaveBeenCalledWith(401);
    expect(read).not.toHaveBeenCalled();
  });

  it('responds only with the locally applied generation and no-store', async () => {
    const status = { distributed: true, generation: 2, pollIntervalMs: 3000 };
    const read = jest.fn().mockResolvedValue(status);
    const res = response();
    await createConfigRevisionHandler(read)(
      { user: { id: 'u1' } } as unknown as Request,
      res as unknown as Response,
      jest.fn(),
    );
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(res.json).toHaveBeenCalledWith(status);
  });
});

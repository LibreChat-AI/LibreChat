import { getTenantId, SYSTEM_TENANT_ID } from '@librechat/data-schemas';
import type { NextFunction, Request, Response } from 'express';
import { createRequiredTwoFactorGate } from './gates';

function createResponse(): { res: Response; status: jest.Mock; json: jest.Mock } {
  const status = jest.fn();
  const json = jest.fn();
  const res = { status, json } as unknown as Response;
  status.mockReturnValue(res);
  return { res, status, json };
}

describe('required two-factor gate', () => {
  const original = process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;
  beforeEach(() => {
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'true';
  });
  afterEach(() => {
    if (original === undefined) {
      delete process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;
    } else {
      process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = original;
    }
  });

  /**
   * The gate runs before tenant middleware, so under strict tenant isolation an unscoped user read
   * throws and the hand-off becomes a 500.
   */
  it('reads the retirement cutoff in system scope and hands off to setup', async () => {
    let readScope: string | undefined;
    const gate = createRequiredTwoFactorGate({
      clearCloudFrontCookies: jest.fn(),
      warn: jest.fn(),
      generateSetupToken: () => 'setup-token',
      getUserById: jest.fn(async () => {
        readScope = getTenantId();
        return {};
      }),
    });
    const { res, status, json } = createResponse();
    const req = {
      path: '/api/convos',
      headers: {},
      user: { id: 'user-1', provider: 'local' },
    } as unknown as Request;
    const onAllowed = jest.fn();
    const next = jest.fn() as NextFunction;

    gate(req, res, next, onAllowed);
    await new Promise((resolve) => setImmediate(resolve));

    expect(readScope).toBe(SYSTEM_TENANT_ID);
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ twoFASetupRequired: true, tempToken: 'setup-token' }),
    );
    expect(onAllowed).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});

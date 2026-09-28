import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import type { NextFunction, Request, Response } from 'express';
import {
  codeEnvironmentPairingLimiter,
  codeEnvironmentStatusIpLimiter,
  codeEnvironmentStatusLimiter,
} from './code';
import { limiterCache } from '~/cache/cacheFactory';

jest.mock('express-rate-limit', () => ({
  rateLimit: jest.fn(() => jest.fn((_req: Request, _res: Response, next: NextFunction) => next())),
  ipKeyGenerator: jest.fn((ip: string | undefined) => ip ?? ''),
}));
jest.mock('~/cache/cacheFactory', () => ({ limiterCache: jest.fn(() => undefined) }));

const mockRateLimit = jest.mocked(rateLimit);
const mockIpKeyGenerator = jest.mocked(ipKeyGenerator);
const mockLimiterCache = jest.mocked(limiterCache);

type LimiterOptions = {
  max: number;
  windowMs: number;
  keyGenerator: (req: Request) => string;
};

describe('code environment limiters', () => {
  test('uses a bounded per-user pairing bucket', () => {
    const req = { user: { id: 'user-1' } } as unknown as Request;

    codeEnvironmentPairingLimiter(req, {} as Response, jest.fn());

    const options = mockRateLimit.mock.calls[0]?.[0] as LimiterOptions;
    expect(options).toEqual(expect.objectContaining({ max: 5, windowMs: 3_600_000 }));
    expect(options.keyGenerator(req)).toBe('user-1');
    expect(mockLimiterCache).toHaveBeenCalledWith('code_environment_pairing_user_limiter');
  });

  test('keys status user limits by immutable user ID', () => {
    const req = { user: { id: 'user-1' }, ip: '2001:db8::1' } as unknown as Request;

    codeEnvironmentStatusLimiter(req, {} as Response, jest.fn());

    const options = mockRateLimit.mock.calls[1]?.[0] as LimiterOptions;
    expect(options).toEqual(expect.objectContaining({ max: 120, windowMs: 60_000 }));
    expect(options.keyGenerator(req)).toBe('user-1');
    expect(mockIpKeyGenerator).not.toHaveBeenCalled();
    expect(mockLimiterCache).toHaveBeenCalledWith('code_environment_status_user_limiter');
  });

  test('applies an independent normalized IP status limit', () => {
    const req = { user: { id: 'user-1' }, ip: '2001:db8::1' } as unknown as Request;

    codeEnvironmentStatusIpLimiter(req, {} as Response, jest.fn());

    const options = mockRateLimit.mock.calls[2]?.[0] as LimiterOptions;
    expect(options).toEqual(expect.objectContaining({ max: 300, windowMs: 60_000 }));
    expect(options.keyGenerator(req)).toBe('2001:db8::1');
    expect(mockIpKeyGenerator).toHaveBeenCalledWith('2001:db8::1');
    expect(mockLimiterCache).toHaveBeenCalledWith('code_environment_status_ip_limiter');
  });
});

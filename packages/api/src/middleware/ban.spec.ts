import { getBanIp } from './ban';

describe('getBanIp', () => {
  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])(
    'excludes the shared address %s only for verified trigger requests',
    (ip) => {
      const req = { ip, _isAgentTrigger: true };

      expect(getBanIp(req)).toBeUndefined();
      expect(req.ip).toBe(ip);
      expect(getBanIp({ ip, _isAgentTrigger: false })).toBe(ip);
      expect(getBanIp({ ip })).toBe(ip);
    },
  );

  it('does not trust a trigger transport header without a verified identity', () => {
    const req = { ip: '127.0.0.1', headers: { 'x-lc-agent-trigger': '1' } };

    expect(getBanIp(req)).toBe(req.ip);
  });

  it('preserves a missing IP address', () => {
    expect(getBanIp({ ip: undefined })).toBeUndefined();
  });
});

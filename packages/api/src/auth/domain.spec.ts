/* eslint-disable @typescript-eslint/ban-ts-comment */
jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(),
}));

import { lookup } from 'node:dns/promises';
import {
  extractMCPServerDomain,
  isActionDomainAllowed,
  isAddressAllowed,
  isEmailDomainAllowed,
  isOAuthUrlAllowed,
  isMCPDomainAllowed,
  isPrivateIP,
  isSSRFTarget,
  resolveHostnameSSRF,
  validateEndpointURL,
} from './domain';

const mockedLookup = lookup as jest.MockedFunction<typeof lookup>;

describe('isEmailDomainAllowed', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should return true if email is falsy and no domain restrictions exist', async () => {
    const email = '';
    const result = isEmailDomainAllowed(email);
    expect(result).toBe(true);
  });

  it('should return true if domain is not present in the email and no domain restrictions exist', async () => {
    const email = 'test';
    const result = isEmailDomainAllowed(email);
    expect(result).toBe(true);
  });

  it('should return false if email is falsy and domain restrictions exist', async () => {
    const email = '';
    const result = isEmailDomainAllowed(email, ['domain1.com']);
    expect(result).toBe(false);
  });

  it('should return false if domain is not present in the email and domain restrictions exist', async () => {
    const email = 'test';
    const result = isEmailDomainAllowed(email, ['domain1.com']);
    expect(result).toBe(false);
  });

  it('should return true if customConfig is not available', async () => {
    const email = 'test@domain1.com';
    const result = isEmailDomainAllowed(email, null);
    expect(result).toBe(true);
  });

  it('should return true if allowedDomains is not defined in customConfig', async () => {
    const email = 'test@domain1.com';
    const result = isEmailDomainAllowed(email, undefined);
    expect(result).toBe(true);
  });

  it('should return true if domain is included in the allowedDomains', async () => {
    const email = 'user@domain1.com';
    const result = isEmailDomainAllowed(email, ['domain1.com', 'domain2.com']);
    expect(result).toBe(true);
  });

  it('should return false if domain is not included in the allowedDomains', async () => {
    const email = 'user@domain3.com';
    const result = isEmailDomainAllowed(email, ['domain1.com', 'domain2.com']);
    expect(result).toBe(false);
  });

  describe('case-insensitive domain matching', () => {
    it('should match domains case-insensitively when email has uppercase domain', () => {
      const email = 'user@DOMAIN1.COM';
      const result = isEmailDomainAllowed(email, ['domain1.com', 'domain2.com']);
      expect(result).toBe(true);
    });

    it('should match domains case-insensitively when allowedDomains has uppercase', () => {
      const email = 'user@domain1.com';
      const result = isEmailDomainAllowed(email, ['DOMAIN1.COM', 'DOMAIN2.COM']);
      expect(result).toBe(true);
    });

    it('should match domains with mixed case in email', () => {
      const email = 'user@Example.Com';
      const result = isEmailDomainAllowed(email, ['example.com', 'domain2.com']);
      expect(result).toBe(true);
    });

    it('should match domains with mixed case in allowedDomains', () => {
      const email = 'user@example.com';
      const result = isEmailDomainAllowed(email, ['Example.Com', 'Domain2.Com']);
      expect(result).toBe(true);
    });

    it('should match when both email and allowedDomains have different mixed cases', () => {
      const email = 'user@ExAmPlE.cOm';
      const result = isEmailDomainAllowed(email, ['eXaMpLe.CoM', 'domain2.com']);
      expect(result).toBe(true);
    });

    it('should still return false for non-matching domains regardless of case', () => {
      const email = 'user@DOMAIN3.COM';
      const result = isEmailDomainAllowed(email, ['domain1.com', 'DOMAIN2.COM']);
      expect(result).toBe(false);
    });

    it('should handle null/undefined entries in allowedDomains gracefully', () => {
      const email = 'user@domain1.com';
      // @ts-expect-error Testing invalid input
      const result = isEmailDomainAllowed(email, [null, 'DOMAIN1.COM', undefined]);
      expect(result).toBe(true);
    });
  });
});

describe('isSSRFTarget', () => {
  describe('localhost blocking', () => {
    it('should block localhost', () => {
      expect(isSSRFTarget('localhost')).toBe(true);
      expect(isSSRFTarget('LOCALHOST')).toBe(true);
      expect(isSSRFTarget('localhost.localdomain')).toBe(true);
      expect(isSSRFTarget('sub.localhost')).toBe(true);
    });
  });

  describe('IPv4 private ranges', () => {
    it('should block 127.0.0.0/8 (loopback)', () => {
      expect(isSSRFTarget('127.0.0.1')).toBe(true);
      expect(isSSRFTarget('127.255.255.255')).toBe(true);
    });

    it('should block 10.0.0.0/8 (private)', () => {
      expect(isSSRFTarget('10.0.0.1')).toBe(true);
      expect(isSSRFTarget('10.255.255.255')).toBe(true);
    });

    it('should block 172.16.0.0/12 (private)', () => {
      expect(isSSRFTarget('172.16.0.1')).toBe(true);
      expect(isSSRFTarget('172.31.255.255')).toBe(true);
      expect(isSSRFTarget('172.15.0.1')).toBe(false); // Outside range
      expect(isSSRFTarget('172.32.0.1')).toBe(false); // Outside range
    });

    it('should block 192.168.0.0/16 (private)', () => {
      expect(isSSRFTarget('192.168.0.1')).toBe(true);
      expect(isSSRFTarget('192.168.255.255')).toBe(true);
    });

    it('should block 169.254.0.0/16 (link-local/cloud metadata)', () => {
      expect(isSSRFTarget('169.254.169.254')).toBe(true); // AWS metadata
      expect(isSSRFTarget('169.254.0.1')).toBe(true);
    });

    it('should block 0.0.0.0/8 (current network)', () => {
      expect(isSSRFTarget('0.0.0.0')).toBe(true);
      expect(isSSRFTarget('0.1.2.3')).toBe(true);
    });

    it('should allow public IPs', () => {
      expect(isSSRFTarget('8.8.8.8')).toBe(false);
      expect(isSSRFTarget('1.1.1.1')).toBe(false);
      expect(isSSRFTarget('203.0.113.1')).toBe(false);
    });
  });

  describe('IPv6 blocking', () => {
    it('should block IPv6 loopback', () => {
      expect(isSSRFTarget('::1')).toBe(true);
      expect(isSSRFTarget('::')).toBe(true);
      expect(isSSRFTarget('[::1]')).toBe(true);
    });

    it('should block IPv6 private ranges', () => {
      expect(isSSRFTarget('fc00::1')).toBe(true);
      expect(isSSRFTarget('fd00::1')).toBe(true);
      expect(isSSRFTarget('fe80::1')).toBe(true);
    });

    it('should block full fe80::/10 link-local range (fe80–febf)', () => {
      expect(isSSRFTarget('fe90::1')).toBe(true);
      expect(isSSRFTarget('fea0::1')).toBe(true);
      expect(isSSRFTarget('feb0::1')).toBe(true);
      expect(isSSRFTarget('febf::1')).toBe(true);
      expect(isSSRFTarget('fec0::1')).toBe(false);
    });

    it('should NOT false-positive on hostnames whose first label resembles a link-local prefix', () => {
      expect(isSSRFTarget('fe90.example.com')).toBe(false);
      expect(isSSRFTarget('fea0.api.io')).toBe(false);
      expect(isSSRFTarget('febf.service.net')).toBe(false);
    });
  });

  describe('internal hostnames', () => {
    it('should block common internal service names', () => {
      expect(isSSRFTarget('rag_api')).toBe(true);
      expect(isSSRFTarget('rag-api')).toBe(true);
      expect(isSSRFTarget('redis')).toBe(true);
      expect(isSSRFTarget('mongodb')).toBe(true);
      expect(isSSRFTarget('postgres')).toBe(true);
      expect(isSSRFTarget('elasticsearch')).toBe(true);
    });

    it('should block .internal and .local TLDs', () => {
      expect(isSSRFTarget('api.internal')).toBe(true);
      expect(isSSRFTarget('service.local')).toBe(true);
    });

    it('should allow legitimate domains', () => {
      expect(isSSRFTarget('api.example.com')).toBe(false);
      expect(isSSRFTarget('swagger.io')).toBe(false);
      expect(isSSRFTarget('openai.com')).toBe(false);
    });
  });
});

describe('isPrivateIP', () => {
  describe('IPv4 private ranges', () => {
    it('should detect loopback addresses', () => {
      expect(isPrivateIP('127.0.0.1')).toBe(true);
      expect(isPrivateIP('127.255.255.255')).toBe(true);
    });

    it('should detect 10.x.x.x private range', () => {
      expect(isPrivateIP('10.0.0.1')).toBe(true);
      expect(isPrivateIP('10.255.255.255')).toBe(true);
    });

    it('should detect 172.16-31.x.x private range', () => {
      expect(isPrivateIP('172.16.0.1')).toBe(true);
      expect(isPrivateIP('172.31.255.255')).toBe(true);
      expect(isPrivateIP('172.15.0.1')).toBe(false);
      expect(isPrivateIP('172.32.0.1')).toBe(false);
    });

    it('should detect 192.168.x.x private range', () => {
      expect(isPrivateIP('192.168.0.1')).toBe(true);
      expect(isPrivateIP('192.168.255.255')).toBe(true);
    });

    it('should detect 169.254.x.x link-local range', () => {
      expect(isPrivateIP('169.254.169.254')).toBe(true);
      expect(isPrivateIP('169.254.0.1')).toBe(true);
    });

    it('should detect 0.0.0.0/8 (current network)', () => {
      expect(isPrivateIP('0.0.0.0')).toBe(true);
      expect(isPrivateIP('0.1.2.3')).toBe(true);
    });

    it('should detect 100.64.0.0/10 (CGNAT / shared address space)', () => {
      expect(isPrivateIP('100.64.0.1')).toBe(true);
      expect(isPrivateIP('100.127.255.255')).toBe(true);
      expect(isPrivateIP('100.63.255.255')).toBe(false);
      expect(isPrivateIP('100.128.0.1')).toBe(false);
    });

    it('should detect 192.0.0.0/24 (IETF protocol assignments)', () => {
      expect(isPrivateIP('192.0.0.1')).toBe(true);
      expect(isPrivateIP('192.0.0.255')).toBe(true);
      expect(isPrivateIP('192.0.1.1')).toBe(false);
    });

    it('should detect 198.18.0.0/15 (benchmarking)', () => {
      expect(isPrivateIP('198.18.0.1')).toBe(true);
      expect(isPrivateIP('198.19.255.255')).toBe(true);
      expect(isPrivateIP('198.17.0.1')).toBe(false);
      expect(isPrivateIP('198.20.0.1')).toBe(false);
    });

    it('should detect 224.0.0.0/4 (multicast) and 240.0.0.0/4 (reserved)', () => {
      expect(isPrivateIP('224.0.0.1')).toBe(true);
      expect(isPrivateIP('239.255.255.255')).toBe(true);
      expect(isPrivateIP('240.0.0.1')).toBe(true);
      expect(isPrivateIP('255.255.255.255')).toBe(true);
    });

    it('should allow public IPs', () => {
      expect(isPrivateIP('8.8.8.8')).toBe(false);
      expect(isPrivateIP('1.1.1.1')).toBe(false);
      expect(isPrivateIP('93.184.216.34')).toBe(false);
    });
  });

  describe('IPv6 private ranges', () => {
    it('should detect loopback', () => {
      expect(isPrivateIP('::1')).toBe(true);
      expect(isPrivateIP('::')).toBe(true);
      expect(isPrivateIP('[::1]')).toBe(true);
    });

    it('should detect unique local (fc/fd) and link-local (fe80::/10)', () => {
      expect(isPrivateIP('fc00::1')).toBe(true);
      expect(isPrivateIP('fd00::1')).toBe(true);
      expect(isPrivateIP('fe80::1')).toBe(true);
      expect(isPrivateIP('fe90::1')).toBe(true);
      expect(isPrivateIP('fea0::1')).toBe(true);
      expect(isPrivateIP('feb0::1')).toBe(true);
      expect(isPrivateIP('febf::1')).toBe(true);
      expect(isPrivateIP('[fe90::1]')).toBe(true);
      expect(isPrivateIP('fec0::1')).toBe(false);
      expect(isPrivateIP('fe90.example.com')).toBe(false);
    });
  });

  describe('IPv4-mapped IPv6 addresses', () => {
    it('should detect private IPs in IPv4-mapped IPv6 form', () => {
      expect(isPrivateIP('::ffff:169.254.169.254')).toBe(true);
      expect(isPrivateIP('::ffff:127.0.0.1')).toBe(true);
      expect(isPrivateIP('::ffff:10.0.0.1')).toBe(true);
      expect(isPrivateIP('::ffff:192.168.1.1')).toBe(true);
    });

    it('should allow public IPs in IPv4-mapped IPv6 form', () => {
      expect(isPrivateIP('::ffff:8.8.8.8')).toBe(false);
      expect(isPrivateIP('::ffff:93.184.216.34')).toBe(false);
    });
  });
});

describe('isPrivateIP - IPv4-mapped IPv6 hex-normalized form (CVE-style SSRF bypass)', () => {
  /**
   * Node.js URL parser normalizes IPv4-mapped IPv6 from dotted-decimal to hex:
   *   new URL('http://[::ffff:169.254.169.254]/').hostname → '::ffff:a9fe:a9fe'
   *
   * These tests confirm whether isPrivateIP catches the hex form that actually
   * reaches it in production (via parseDomainSpec → new URL → hostname).
   */
  it('should detect hex-normalized AWS metadata address (::ffff:a9fe:a9fe)', () => {
    // ::ffff:169.254.169.254 → hex form after URL parsing
    expect(isPrivateIP('::ffff:a9fe:a9fe')).toBe(true);
  });

  it('should detect hex-normalized loopback (::ffff:7f00:1)', () => {
    // ::ffff:127.0.0.1 → hex form after URL parsing
    expect(isPrivateIP('::ffff:7f00:1')).toBe(true);
  });

  it('should detect hex-normalized 192.168.x.x (::ffff:c0a8:101)', () => {
    // ::ffff:192.168.1.1 → hex form after URL parsing
    expect(isPrivateIP('::ffff:c0a8:101')).toBe(true);
  });

  it('should detect hex-normalized 10.x.x.x (::ffff:a00:1)', () => {
    // ::ffff:10.0.0.1 → hex form after URL parsing
    expect(isPrivateIP('::ffff:a00:1')).toBe(true);
  });

  it('should detect hex-normalized 172.16.x.x (::ffff:ac10:1)', () => {
    // ::ffff:172.16.0.1 → hex form after URL parsing
    expect(isPrivateIP('::ffff:ac10:1')).toBe(true);
  });

  it('should detect hex-normalized 0.0.0.0 (::ffff:0:0)', () => {
    // ::ffff:0.0.0.0 → hex form after URL parsing
    expect(isPrivateIP('::ffff:0:0')).toBe(true);
  });

  it('should allow hex-normalized public IPs (::ffff:808:808 = 8.8.8.8)', () => {
    expect(isPrivateIP('::ffff:808:808')).toBe(false);
  });

  it('should detect IPv4-compatible addresses without ffff prefix (::XXXX:XXXX)', () => {
    expect(isPrivateIP('::7f00:1')).toBe(true);
    expect(isPrivateIP('::a9fe:a9fe')).toBe(true);
    expect(isPrivateIP('::c0a8:101')).toBe(true);
    expect(isPrivateIP('::a00:1')).toBe(true);
  });

  it('should allow public IPs in IPv4-compatible form', () => {
    expect(isPrivateIP('::808:808')).toBe(false);
  });

  it('should detect 6to4 addresses embedding private IPv4 (2002:XXXX:XXXX::)', () => {
    expect(isPrivateIP('2002:7f00:1::')).toBe(true);
    expect(isPrivateIP('2002:a9fe:a9fe::')).toBe(true);
    expect(isPrivateIP('2002:c0a8:101::')).toBe(true);
    expect(isPrivateIP('2002:a00:1::')).toBe(true);
  });

  it('should allow 6to4 addresses embedding public IPv4', () => {
    expect(isPrivateIP('2002:808:808::')).toBe(false);
  });

  it('should detect NAT64 addresses embedding private IPv4 (64:ff9b::XXXX:XXXX)', () => {
    expect(isPrivateIP('64:ff9b::7f00:1')).toBe(true);
    expect(isPrivateIP('64:ff9b::a9fe:a9fe')).toBe(true);
  });

  it('should detect Teredo addresses with complement-encoded private IPv4 (RFC 4380)', () => {
    // Teredo stores external IPv4 as bitwise complement in last 32 bits
    // 127.0.0.1 → complement: 0x80ff:0xfffe
    expect(isPrivateIP('2001::80ff:fffe')).toBe(true);
    // 169.254.169.254 → complement: 0x5601:0x5601
    expect(isPrivateIP('2001::5601:5601')).toBe(true);
    // 10.0.0.1 → complement: 0xf5ff:0xfffe
    expect(isPrivateIP('2001::f5ff:fffe')).toBe(true);
  });

  it('should allow Teredo addresses with complement-encoded public IPv4', () => {
    // 8.8.8.8 → complement: 0xf7f7:0xf7f7
    expect(isPrivateIP('2001::f7f7:f7f7')).toBe(false);
  });

  it('should confirm URL parser produces the hex form that bypasses dotted regex', () => {
    // This test documents the exact normalization gap
    const hostname = new URL('http://[::ffff:169.254.169.254]/').hostname.replace(/^\[|\]$/g, '');
    expect(hostname).toBe('::ffff:a9fe:a9fe'); // hex, not dotted
    // The hostname that actually reaches isPrivateIP must be caught
    expect(isPrivateIP(hostname)).toBe(true);
  });
});

describe('isActionDomainAllowed - IPv4-mapped IPv6 hex SSRF bypass (end-to-end)', () => {
  beforeEach(() => {
    mockedLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
  });
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should block http://[::ffff:169.254.169.254]/ (AWS metadata via IPv6)', async () => {
    expect(await isActionDomainAllowed('http://[::ffff:169.254.169.254]/', null)).toBe(false);
  });

  it('should block http://[::ffff:127.0.0.1]/ (loopback via IPv6)', async () => {
    expect(await isActionDomainAllowed('http://[::ffff:127.0.0.1]/', null)).toBe(false);
  });

  it('should block http://[::ffff:192.168.1.1]/ (private via IPv6)', async () => {
    expect(await isActionDomainAllowed('http://[::ffff:192.168.1.1]/', null)).toBe(false);
  });

  it('should block http://[::ffff:10.0.0.1]/ (private via IPv6)', async () => {
    expect(await isActionDomainAllowed('http://[::ffff:10.0.0.1]/', null)).toBe(false);
  });

  it('should allow http://[::ffff:8.8.8.8]/ (public via IPv6)', async () => {
    expect(await isActionDomainAllowed('http://[::ffff:8.8.8.8]/', null)).toBe(true);
  });

  it('should block IPv4-compatible IPv6 without ffff prefix', async () => {
    expect(await isActionDomainAllowed('http://[::127.0.0.1]/', null)).toBe(false);
    expect(await isActionDomainAllowed('http://[::169.254.169.254]/', null)).toBe(false);
    expect(await isActionDomainAllowed('http://[0:0:0:0:0:0:127.0.0.1]/', null)).toBe(false);
  });

  it('should block 6to4 addresses embedding private IPv4', async () => {
    expect(await isActionDomainAllowed('http://[2002:7f00:1::]/', null)).toBe(false);
    expect(await isActionDomainAllowed('http://[2002:a9fe:a9fe::]/', null)).toBe(false);
  });

  it('should block NAT64 addresses embedding private IPv4', async () => {
    expect(await isActionDomainAllowed('http://[64:ff9b::127.0.0.1]/', null)).toBe(false);
    expect(await isActionDomainAllowed('http://[64:ff9b::169.254.169.254]/', null)).toBe(false);
  });
});

describe('resolveHostnameSSRF', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should detect domains that resolve to private IPs (nip.io bypass)', async () => {
    mockedLookup.mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }] as never);
    expect(await resolveHostnameSSRF('169.254.169.254.nip.io')).toBe(true);
  });

  it('should detect domains that resolve to loopback', async () => {
    mockedLookup.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }] as never);
    expect(await resolveHostnameSSRF('loopback.example.com')).toBe(true);
  });

  it('should detect when any resolved address is private', async () => {
    mockedLookup.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ] as never);
    expect(await resolveHostnameSSRF('dual.example.com')).toBe(true);
  });

  it('should allow domains that resolve to public IPs', async () => {
    mockedLookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }] as never);
    expect(await resolveHostnameSSRF('example.com')).toBe(false);
  });

  it('should detect private literal IPv4 addresses without DNS lookup', async () => {
    expect(await resolveHostnameSSRF('169.254.169.254')).toBe(true);
    expect(await resolveHostnameSSRF('127.0.0.1')).toBe(true);
    expect(await resolveHostnameSSRF('10.0.0.1')).toBe(true);
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it('should allow public literal IPv4 addresses without DNS lookup', async () => {
    expect(await resolveHostnameSSRF('8.8.8.8')).toBe(false);
    expect(await resolveHostnameSSRF('93.184.216.34')).toBe(false);
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it('should detect private IPv6 literals without DNS lookup', async () => {
    expect(await resolveHostnameSSRF('::1')).toBe(true);
    expect(await resolveHostnameSSRF('fc00::1')).toBe(true);
    expect(await resolveHostnameSSRF('fe80::1')).toBe(true);
    expect(await resolveHostnameSSRF('fe90::1')).toBe(true);
    expect(await resolveHostnameSSRF('febf::1')).toBe(true);
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it('should detect hex-normalized IPv4-mapped IPv6 literals', async () => {
    expect(await resolveHostnameSSRF('::ffff:a9fe:a9fe')).toBe(true);
    expect(await resolveHostnameSSRF('::ffff:7f00:1')).toBe(true);
    expect(await resolveHostnameSSRF('[::ffff:a9fe:a9fe]')).toBe(true);
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it('should allow public IPv6 literals without DNS lookup', async () => {
    expect(await resolveHostnameSSRF('2001:db8::1')).toBe(false);
    expect(await resolveHostnameSSRF('::ffff:808:808')).toBe(false);
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it('should detect private IPv6 addresses returned from DNS lookup', async () => {
    mockedLookup.mockResolvedValueOnce([{ address: '::1', family: 6 }] as never);
    expect(await resolveHostnameSSRF('ipv6-loopback.example.com')).toBe(true);

    mockedLookup.mockResolvedValueOnce([{ address: 'fc00::1', family: 6 }] as never);
    expect(await resolveHostnameSSRF('ula.example.com')).toBe(true);

    mockedLookup.mockResolvedValueOnce([{ address: '::ffff:a9fe:a9fe', family: 6 }] as never);
    expect(await resolveHostnameSSRF('meta.example.com')).toBe(true);
  });

  it('should fail open on DNS resolution failure', async () => {
    mockedLookup.mockRejectedValueOnce(new Error('ENOTFOUND'));
    expect(await resolveHostnameSSRF('nonexistent.example.com')).toBe(false);
  });
});

describe('isActionDomainAllowed - DNS resolution SSRF protection', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should block domains resolving to cloud metadata IP (169.254.169.254)', async () => {
    mockedLookup.mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }] as never);
    expect(await isActionDomainAllowed('169.254.169.254.nip.io', null)).toBe(false);
  });

  it('should block domains resolving to private 10.x range', async () => {
    mockedLookup.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }] as never);
    expect(await isActionDomainAllowed('internal.attacker.com', null)).toBe(false);
  });

  it('should block domains resolving to 172.16.x range', async () => {
    mockedLookup.mockResolvedValueOnce([{ address: '172.16.0.1', family: 4 }] as never);
    expect(await isActionDomainAllowed('docker.attacker.com', null)).toBe(false);
  });

  it('should allow domains resolving to public IPs when no allowlist', async () => {
    mockedLookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }] as never);
    expect(await isActionDomainAllowed('example.com', null)).toBe(true);
  });

  it('should not perform DNS check when allowedDomains is configured', async () => {
    expect(await isActionDomainAllowed('example.com', ['example.com'])).toBe(true);
    expect(mockedLookup).not.toHaveBeenCalled();
  });
});

describe('isActionDomainAllowed', () => {
  beforeEach(() => {
    mockedLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
  });
  afterEach(() => {
    jest.clearAllMocks();
  });

  // SSRF Protection Tests
  describe('SSRF protection', () => {
    it('should block SSRF targets when no allowedDomains configured', async () => {
      // These should be blocked when no explicit allowlist
      expect(await isActionDomainAllowed('localhost', null)).toBe(false);
      expect(await isActionDomainAllowed('127.0.0.1', null)).toBe(false);
      expect(await isActionDomainAllowed('10.0.0.1', null)).toBe(false);
      expect(await isActionDomainAllowed('192.168.1.1', null)).toBe(false);
      expect(await isActionDomainAllowed('169.254.169.254', null)).toBe(false);
      expect(await isActionDomainAllowed('rag_api', null)).toBe(false);
      expect(await isActionDomainAllowed('http://rag_api:8000', null)).toBe(false);
    });

    it('should allow public domains with no restrictions', async () => {
      expect(await isActionDomainAllowed('api.example.com', null)).toBe(true);
      expect(await isActionDomainAllowed('https://openai.com', null)).toBe(true);
    });

    it('should allow SSRF targets when explicitly in allowedDomains (admin override)', async () => {
      // Admins can explicitly allow internal targets if needed
      const allowedDomains = ['localhost', '127.0.0.1', 'rag_api'];
      expect(await isActionDomainAllowed('localhost', allowedDomains)).toBe(true);
      expect(await isActionDomainAllowed('127.0.0.1', allowedDomains)).toBe(true);
      expect(await isActionDomainAllowed('rag_api', allowedDomains)).toBe(true);
    });

    it('should still block SSRF targets not in allowedDomains even when list is configured', async () => {
      // Only explicitly allowed domains should work
      const allowedDomains = ['example.com'];
      expect(await isActionDomainAllowed('localhost', allowedDomains)).toBe(false);
      expect(await isActionDomainAllowed('127.0.0.1', allowedDomains)).toBe(false);
    });
  });

  // Basic Input Validation Tests
  describe('input validation', () => {
    it('should return false for falsy values', async () => {
      expect(await isActionDomainAllowed()).toBe(false);
      expect(await isActionDomainAllowed(null)).toBe(false);
      expect(await isActionDomainAllowed('')).toBe(false);
      expect(await isActionDomainAllowed(undefined)).toBe(false);
    });

    it('should return false for non-string inputs', async () => {
      /** @ts-expect-error */
      expect(await isActionDomainAllowed(123)).toBe(false);
      /** @ts-expect-error */
      expect(await isActionDomainAllowed({})).toBe(false);
      /** @ts-expect-error */
      expect(await isActionDomainAllowed([])).toBe(false);
    });

    it('should return false for invalid domain formats', async () => {
      expect(await isActionDomainAllowed('http://', ['http://', 'https://'])).toBe(false);
      expect(await isActionDomainAllowed('https://', ['http://', 'https://'])).toBe(false);
    });
  });

  // Configuration Tests
  describe('configuration handling', () => {
    it('should return true if customConfig is null', async () => {
      expect(await isActionDomainAllowed('example.com', null)).toBe(true);
    });

    it('should return true if actions.allowedDomains is not defined', async () => {
      expect(await isActionDomainAllowed('example.com', undefined)).toBe(true);
    });

    it('should return true if allowedDomains is empty array', async () => {
      expect(await isActionDomainAllowed('example.com', [])).toBe(true);
    });
  });

  // Domain Matching Tests
  describe('domain matching', () => {
    const allowedDomains = [
      'example.com',
      '*.subdomain.com',
      'specific.domain.com',
      'www.withprefix.com',
      'swapi.dev',
    ];

    it('should match exact domains', async () => {
      expect(await isActionDomainAllowed('example.com', allowedDomains)).toBe(true);
      expect(await isActionDomainAllowed('other.com', allowedDomains)).toBe(false);
      expect(await isActionDomainAllowed('swapi.dev', allowedDomains)).toBe(true);
    });

    it('should handle domains with www prefix', async () => {
      expect(await isActionDomainAllowed('www.example.com', allowedDomains)).toBe(true);
      expect(await isActionDomainAllowed('www.withprefix.com', allowedDomains)).toBe(true);
    });

    it('should handle full URLs', async () => {
      expect(await isActionDomainAllowed('https://example.com', allowedDomains)).toBe(true);
      expect(await isActionDomainAllowed('http://example.com', allowedDomains)).toBe(true);
      expect(await isActionDomainAllowed('https://example.com/path', allowedDomains)).toBe(true);
    });

    it('should handle wildcard subdomains', async () => {
      expect(await isActionDomainAllowed('test.subdomain.com', allowedDomains)).toBe(true);
      expect(await isActionDomainAllowed('any.subdomain.com', allowedDomains)).toBe(true);
      expect(await isActionDomainAllowed('subdomain.com', allowedDomains)).toBe(true);
    });

    it('should handle specific subdomains', async () => {
      expect(await isActionDomainAllowed('specific.domain.com', allowedDomains)).toBe(true);
      expect(await isActionDomainAllowed('other.domain.com', allowedDomains)).toBe(false);
    });
  });

  // Edge Cases
  describe('edge cases', () => {
    const edgeAllowedDomains = ['example.com', '*.test.com'];

    it('should handle domains with query parameters', async () => {
      expect(await isActionDomainAllowed('example.com?param=value', edgeAllowedDomains)).toBe(true);
    });

    it('should handle domains with ports', async () => {
      expect(await isActionDomainAllowed('example.com:8080', edgeAllowedDomains)).toBe(true);
    });

    it('should handle domains with trailing slashes', async () => {
      expect(await isActionDomainAllowed('example.com/', edgeAllowedDomains)).toBe(true);
    });

    it('should handle case insensitivity', async () => {
      expect(await isActionDomainAllowed('EXAMPLE.COM', edgeAllowedDomains)).toBe(true);
      expect(await isActionDomainAllowed('Example.Com', edgeAllowedDomains)).toBe(true);
    });

    it('should handle invalid entries in allowedDomains', async () => {
      const invalidAllowedDomains = ['example.com', null, undefined, '', 'test.com'];
      /** @ts-expect-error */
      expect(await isActionDomainAllowed('example.com', invalidAllowedDomains)).toBe(true);
      /** @ts-expect-error */
      expect(await isActionDomainAllowed('test.com', invalidAllowedDomains)).toBe(true);
    });
  });

  // Protocol and Port Restrictions (Recommendation #2)
  describe('protocol and port restrictions', () => {
    describe('OpenAPI Actions reject WebSocket protocols', () => {
      it('should reject ws:// URLs (not part of OpenAPI spec)', async () => {
        expect(await isActionDomainAllowed('ws://example.com', ['example.com'])).toBe(false);
        expect(await isActionDomainAllowed('ws://example.com', null)).toBe(false);
      });

      it('should reject wss:// URLs (not part of OpenAPI spec)', async () => {
        expect(await isActionDomainAllowed('wss://example.com', ['example.com'])).toBe(false);
        expect(await isActionDomainAllowed('wss://example.com', null)).toBe(false);
      });

      it('should reject WebSocket URLs even if explicitly in allowedDomains', async () => {
        expect(await isActionDomainAllowed('wss://ws.example.com', ['wss://ws.example.com'])).toBe(
          false,
        );
        expect(await isActionDomainAllowed('ws://ws.example.com', ['ws://ws.example.com'])).toBe(
          false,
        );
      });

      it('should allow only HTTP/HTTPS for OpenAPI Actions', async () => {
        expect(await isActionDomainAllowed('http://example.com', ['example.com'])).toBe(true);
        expect(await isActionDomainAllowed('https://example.com', ['example.com'])).toBe(true);
      });
    });

    describe('protocol-only restrictions', () => {
      const httpsOnlyDomains = ['https://api.example.com', 'https://secure.test.com'];

      it('should allow HTTPS when HTTPS is required', async () => {
        expect(await isActionDomainAllowed('https://api.example.com', httpsOnlyDomains)).toBe(true);
        expect(await isActionDomainAllowed('https://secure.test.com', httpsOnlyDomains)).toBe(true);
      });

      it('should deny HTTP when HTTPS is required', async () => {
        expect(await isActionDomainAllowed('http://api.example.com', httpsOnlyDomains)).toBe(false);
        expect(await isActionDomainAllowed('http://secure.test.com', httpsOnlyDomains)).toBe(false);
      });

      it('should deny domain without protocol when protocol is required', async () => {
        // When allowedDomains specifies protocol, input should also have protocol
        expect(await isActionDomainAllowed('api.example.com', httpsOnlyDomains)).toBe(false);
      });
    });

    describe('port restrictions', () => {
      const portRestrictedDomains = ['https://api.example.com:443', 'http://internal:8080'];

      it('should allow matching port', async () => {
        expect(
          await isActionDomainAllowed('https://api.example.com:443', portRestrictedDomains),
        ).toBe(true);
        expect(await isActionDomainAllowed('http://internal:8080', portRestrictedDomains)).toBe(
          true,
        );
      });

      it('should deny different port', async () => {
        expect(
          await isActionDomainAllowed('https://api.example.com:8443', portRestrictedDomains),
        ).toBe(false);
        expect(await isActionDomainAllowed('http://internal:9000', portRestrictedDomains)).toBe(
          false,
        );
      });

      it('should deny when no port specified but port required', async () => {
        expect(await isActionDomainAllowed('https://api.example.com', portRestrictedDomains)).toBe(
          false,
        );
      });
    });

    describe('mixed restrictions', () => {
      const mixedDomains = [
        'example.com', // Any protocol, any port
        'https://secure.example.com', // HTTPS only, default port
        'https://api.example.com:8443', // HTTPS only, specific port
        'http://localhost:3000', // HTTP only, specific port (admin override for internal)
      ];

      it('should allow any protocol/port for unrestricted domain', async () => {
        expect(await isActionDomainAllowed('http://example.com', mixedDomains)).toBe(true);
        expect(await isActionDomainAllowed('https://example.com', mixedDomains)).toBe(true);
        expect(await isActionDomainAllowed('https://example.com:8080', mixedDomains)).toBe(true);
        expect(await isActionDomainAllowed('example.com', mixedDomains)).toBe(true);
      });

      it('should enforce protocol for protocol-restricted domain', async () => {
        expect(await isActionDomainAllowed('https://secure.example.com', mixedDomains)).toBe(true);
        expect(await isActionDomainAllowed('http://secure.example.com', mixedDomains)).toBe(false);
      });

      it('should enforce both protocol and port when both specified', async () => {
        expect(await isActionDomainAllowed('https://api.example.com:8443', mixedDomains)).toBe(
          true,
        );
        expect(await isActionDomainAllowed('http://api.example.com:8443', mixedDomains)).toBe(
          false,
        );
        expect(await isActionDomainAllowed('https://api.example.com:443', mixedDomains)).toBe(
          false,
        );
        expect(await isActionDomainAllowed('https://api.example.com', mixedDomains)).toBe(false);
      });

      it('should allow internal targets with explicit protocol/port (admin override)', async () => {
        expect(await isActionDomainAllowed('http://localhost:3000', mixedDomains)).toBe(true);
        // Different port should fail
        expect(await isActionDomainAllowed('http://localhost:8080', mixedDomains)).toBe(false);
        // Different protocol should fail
        expect(await isActionDomainAllowed('https://localhost:3000', mixedDomains)).toBe(false);
      });
    });
  });
});

describe('extractMCPServerDomain', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('URL extraction (returns full origin for protocol/port matching)', () => {
    it('should extract full origin from HTTPS URL', () => {
      const config = { url: 'https://api.example.com/sse' };
      expect(extractMCPServerDomain(config)).toBe('https://api.example.com');
    });

    it('should extract full origin from HTTP URL', () => {
      const config = { url: 'http://api.example.com/sse' };
      expect(extractMCPServerDomain(config)).toBe('http://api.example.com');
    });

    it('should extract full origin from WebSocket URL', () => {
      const config = { url: 'wss://ws.example.com' };
      expect(extractMCPServerDomain(config)).toBe('wss://ws.example.com');
    });

    it('should include port in origin when specified', () => {
      const config = { url: 'https://localhost:3001/sse' };
      expect(extractMCPServerDomain(config)).toBe('https://localhost:3001');
    });

    it('should include port for non-default ports', () => {
      const config = { url: 'http://host.docker.internal:8044/mcp' };
      expect(extractMCPServerDomain(config)).toBe('http://host.docker.internal:8044');
    });

    it('should preserve www prefix in origin (matching handles www normalization)', () => {
      const config = { url: 'https://www.example.com/api' };
      expect(extractMCPServerDomain(config)).toBe('https://www.example.com');
    });

    it('should strip path and query parameters', () => {
      const config = { url: 'https://api.example.com/v1/sse?token=abc' };
      expect(extractMCPServerDomain(config)).toBe('https://api.example.com');
    });
  });

  describe('stdio transports (no URL)', () => {
    it('should return null for stdio transport with command only', () => {
      const config = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'] };
      expect(extractMCPServerDomain(config)).toBeNull();
    });

    it('should return null when url is undefined', () => {
      const config = { command: 'node', args: ['server.js'] };
      expect(extractMCPServerDomain(config)).toBeNull();
    });

    it('should return null for empty object', () => {
      const config = {};
      expect(extractMCPServerDomain(config)).toBeNull();
    });
  });

  describe('invalid URLs', () => {
    it('should return null for invalid URL format', () => {
      const config = { url: 'not-a-valid-url' };
      expect(extractMCPServerDomain(config)).toBeNull();
    });

    it('should return null for empty URL string', () => {
      const config = { url: '' };
      expect(extractMCPServerDomain(config)).toBeNull();
    });

    it('should return null for non-string url', () => {
      const config = { url: 12345 };
      expect(extractMCPServerDomain(config)).toBeNull();
    });

    it('should return null for null url', () => {
      const config = { url: null };
      expect(extractMCPServerDomain(config)).toBeNull();
    });
  });
});

describe('isMCPDomainAllowed', () => {
  beforeEach(() => {
    mockedLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
  });
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('stdio transports (always allowed)', () => {
    it('should allow stdio transport regardless of allowlist', async () => {
      const config = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'] };
      expect(await isMCPDomainAllowed(config, ['example.com'])).toBe(true);
    });

    it('should allow stdio transport even with empty allowlist', async () => {
      const config = { command: 'node', args: ['server.js'] };
      expect(await isMCPDomainAllowed(config, [])).toBe(true);
    });

    it('should allow stdio transport when no URL present', async () => {
      const config = {};
      expect(await isMCPDomainAllowed(config, ['restricted.com'])).toBe(true);
    });
  });

  describe('permissive defaults (no restrictions)', () => {
    it('should allow all domains when allowedDomains is null', async () => {
      const config = { url: 'https://any-domain.com/sse' };
      expect(await isMCPDomainAllowed(config, null)).toBe(true);
    });

    it('should allow all domains when allowedDomains is undefined', async () => {
      const config = { url: 'https://any-domain.com/sse' };
      expect(await isMCPDomainAllowed(config, undefined)).toBe(true);
    });

    it('should allow all domains when allowedDomains is empty array', async () => {
      const config = { url: 'https://any-domain.com/sse' };
      expect(await isMCPDomainAllowed(config, [])).toBe(true);
    });
  });

  describe('exact domain matching', () => {
    const allowedDomains = ['example.com', 'localhost', 'trusted-mcp.com'];

    it('should allow exact domain match', async () => {
      const config = { url: 'https://example.com/api' };
      expect(await isMCPDomainAllowed(config, allowedDomains)).toBe(true);
    });

    it('should allow localhost when explicitly in allowedDomains (admin override)', async () => {
      // Admins can explicitly allow localhost for local MCP servers
      const config = { url: 'http://localhost:3001/sse' };
      expect(await isMCPDomainAllowed(config, allowedDomains)).toBe(true);
    });

    it('should reject non-allowed domain', async () => {
      const config = { url: 'https://malicious.com/sse' };
      expect(await isMCPDomainAllowed(config, allowedDomains)).toBe(false);
    });

    it('should reject subdomain when only parent is allowed', async () => {
      const config = { url: 'https://api.example.com/sse' };
      expect(await isMCPDomainAllowed(config, allowedDomains)).toBe(false);
    });
  });

  describe('wildcard domain matching', () => {
    const allowedDomains = ['*.example.com', 'localhost'];

    it('should allow subdomain with wildcard', async () => {
      const config = { url: 'https://api.example.com/sse' };
      expect(await isMCPDomainAllowed(config, allowedDomains)).toBe(true);
    });

    it('should allow any subdomain with wildcard', async () => {
      const config = { url: 'https://staging.example.com/sse' };
      expect(await isMCPDomainAllowed(config, allowedDomains)).toBe(true);
    });

    it('should allow base domain with wildcard', async () => {
      const config = { url: 'https://example.com/sse' };
      expect(await isMCPDomainAllowed(config, allowedDomains)).toBe(true);
    });

    it('should allow nested subdomain with wildcard', async () => {
      const config = { url: 'https://deep.nested.example.com/sse' };
      expect(await isMCPDomainAllowed(config, allowedDomains)).toBe(true);
    });

    it('should reject different domain even with wildcard', async () => {
      const config = { url: 'https://api.other.com/sse' };
      expect(await isMCPDomainAllowed(config, allowedDomains)).toBe(false);
    });
  });

  describe('case insensitivity', () => {
    it('should match domains case-insensitively', async () => {
      const config = { url: 'https://EXAMPLE.COM/sse' };
      expect(await isMCPDomainAllowed(config, ['example.com'])).toBe(true);
    });

    it('should match with uppercase in allowlist', async () => {
      const config = { url: 'https://example.com/sse' };
      expect(await isMCPDomainAllowed(config, ['EXAMPLE.COM'])).toBe(true);
    });

    it('should match with mixed case', async () => {
      const config = { url: 'https://Api.Example.Com/sse' };
      expect(await isMCPDomainAllowed(config, ['*.example.com'])).toBe(true);
    });
  });

  describe('www prefix handling', () => {
    it('should strip www prefix from URL before matching', async () => {
      const config = { url: 'https://www.example.com/sse' };
      expect(await isMCPDomainAllowed(config, ['example.com'])).toBe(true);
    });

    it('should match www in allowlist to non-www URL', async () => {
      const config = { url: 'https://example.com/sse' };
      expect(await isMCPDomainAllowed(config, ['www.example.com'])).toBe(true);
    });
  });

  describe('invalid URL handling', () => {
    it('should reject invalid URL when allowlist is configured', async () => {
      const config = { url: 'not-a-valid-url' };
      expect(await isMCPDomainAllowed(config, ['example.com'])).toBe(false);
    });

    it('should reject templated URL when allowlist is configured', async () => {
      const config = { url: 'http://{{CUSTOM_HOST}}/mcp' };
      expect(await isMCPDomainAllowed(config, ['example.com'])).toBe(false);
    });

    it('should allow invalid URL when no allowlist is configured (defers to connection-level SSRF)', async () => {
      const config = { url: 'http://{{CUSTOM_HOST}}/mcp' };
      expect(await isMCPDomainAllowed(config, null)).toBe(true);
      expect(await isMCPDomainAllowed(config, undefined)).toBe(true);
      expect(await isMCPDomainAllowed(config, [])).toBe(true);
    });

    it('should allow config with whitespace-only URL (treated as absent)', async () => {
      const config = { url: '   ' };
      expect(await isMCPDomainAllowed(config, [])).toBe(true);
      expect(await isMCPDomainAllowed(config, ['example.com'])).toBe(true);
      expect(await isMCPDomainAllowed(config, null)).toBe(true);
    });

    it('should allow config with empty string URL (treated as absent)', async () => {
      const config = { url: '' };
      expect(await isMCPDomainAllowed(config, ['example.com'])).toBe(true);
    });

    it('should allow config with no url property (stdio)', async () => {
      const config = { command: 'node', args: ['server.js'] };
      expect(await isMCPDomainAllowed(config, ['example.com'])).toBe(true);
    });
  });

  describe('Docker/internal hostname handling (SSRF protection)', () => {
    it('should block host.docker.internal without allowedDomains (ends with .internal)', async () => {
      const config = { url: 'http://host.docker.internal:8044/mcp' };
      expect(await isMCPDomainAllowed(config, null)).toBe(false);
      expect(await isMCPDomainAllowed(config, undefined)).toBe(false);
      expect(await isMCPDomainAllowed(config, [])).toBe(false);
    });

    it('should allow host.docker.internal when explicitly in allowedDomains', async () => {
      const config = { url: 'http://host.docker.internal:8044/mcp' };
      expect(await isMCPDomainAllowed(config, ['host.docker.internal'])).toBe(true);
    });

    it('should allow host.docker.internal with protocol/port restriction', async () => {
      const config = { url: 'http://host.docker.internal:8044/mcp' };
      expect(await isMCPDomainAllowed(config, ['http://host.docker.internal:8044'])).toBe(true);
    });

    it('should reject host.docker.internal with wrong protocol restriction', async () => {
      const config = { url: 'http://host.docker.internal:8044/mcp' };
      expect(await isMCPDomainAllowed(config, ['https://host.docker.internal:8044'])).toBe(false);
    });

    it('should reject host.docker.internal with wrong port restriction', async () => {
      const config = { url: 'http://host.docker.internal:8044/mcp' };
      expect(await isMCPDomainAllowed(config, ['http://host.docker.internal:9000'])).toBe(false);
    });

    it('should block .local TLD without allowedDomains', async () => {
      const config = { url: 'http://myserver.local/mcp' };
      expect(await isMCPDomainAllowed(config, null)).toBe(false);
    });

    it('should allow .local TLD when explicitly in allowedDomains', async () => {
      const config = { url: 'http://myserver.local/mcp' };
      expect(await isMCPDomainAllowed(config, ['myserver.local'])).toBe(true);
    });
  });

  describe('protocol/port matching with full origin extraction', () => {
    it('should match unrestricted allowedDomain against full origin', async () => {
      // When allowedDomain has no protocol/port, it should match any protocol/port
      const config = { url: 'https://api.example.com:8443/sse' };
      expect(await isMCPDomainAllowed(config, ['api.example.com'])).toBe(true);
    });

    it('should enforce protocol restriction from allowedDomain', async () => {
      const config = { url: 'http://api.example.com/sse' };
      expect(await isMCPDomainAllowed(config, ['https://api.example.com'])).toBe(false);
      expect(await isMCPDomainAllowed(config, ['http://api.example.com'])).toBe(true);
    });

    it('should enforce port restriction from allowedDomain', async () => {
      const config = { url: 'https://api.example.com:8443/sse' };
      expect(await isMCPDomainAllowed(config, ['https://api.example.com:8443'])).toBe(true);
      expect(await isMCPDomainAllowed(config, ['https://api.example.com:443'])).toBe(false);
    });
  });

  describe('WebSocket URL handling (MCP supports ws/wss)', () => {
    it('should allow WebSocket URL when hostname is in allowedDomains', async () => {
      const config = { url: 'wss://ws.example.com/mcp' };
      expect(await isMCPDomainAllowed(config, ['ws.example.com'])).toBe(true);
    });

    it('should allow WebSocket URL with protocol restriction', async () => {
      const config = { url: 'wss://ws.example.com/mcp' };
      expect(await isMCPDomainAllowed(config, ['wss://ws.example.com'])).toBe(true);
    });

    it('should reject WebSocket URL with wrong protocol restriction', async () => {
      const config = { url: 'wss://ws.example.com/mcp' };
      expect(await isMCPDomainAllowed(config, ['ws://ws.example.com'])).toBe(false);
    });

    it('should allow ws:// URL when hostname is in allowedDomains', async () => {
      const config = { url: 'ws://localhost:8080/mcp' };
      expect(await isMCPDomainAllowed(config, ['localhost'])).toBe(true);
    });

    it('should allow all MCP protocols (http, https, ws, wss)', async () => {
      expect(await isMCPDomainAllowed({ url: 'http://example.com' }, ['example.com'])).toBe(true);
      expect(await isMCPDomainAllowed({ url: 'https://example.com' }, ['example.com'])).toBe(true);
      expect(await isMCPDomainAllowed({ url: 'ws://example.com' }, ['example.com'])).toBe(true);
      expect(await isMCPDomainAllowed({ url: 'wss://example.com' }, ['example.com'])).toBe(true);
    });
  });

  describe('IPv4-mapped IPv6 hex SSRF bypass', () => {
    it('should block MCP server targeting AWS metadata via IPv6-mapped address', async () => {
      const config = { url: 'http://[::ffff:169.254.169.254]/mcp' };
      expect(await isMCPDomainAllowed(config, null)).toBe(false);
    });

    it('should block MCP server targeting loopback via IPv6-mapped address', async () => {
      const config = { url: 'http://[::ffff:127.0.0.1]/mcp' };
      expect(await isMCPDomainAllowed(config, null)).toBe(false);
    });

    it('should block MCP server targeting private range via IPv6-mapped address', async () => {
      expect(await isMCPDomainAllowed({ url: 'http://[::ffff:10.0.0.1]/mcp' }, null)).toBe(false);
      expect(await isMCPDomainAllowed({ url: 'http://[::ffff:192.168.1.1]/mcp' }, null)).toBe(
        false,
      );
    });

    it('should block WebSocket MCP targeting private range via IPv6-mapped address', async () => {
      expect(await isMCPDomainAllowed({ url: 'ws://[::ffff:127.0.0.1]/mcp' }, null)).toBe(false);
      expect(await isMCPDomainAllowed({ url: 'wss://[::ffff:10.0.0.1]/mcp' }, null)).toBe(false);
    });

    it('should allow MCP server targeting public IP via IPv6-mapped address', async () => {
      const config = { url: 'http://[::ffff:8.8.8.8]/mcp' };
      expect(await isMCPDomainAllowed(config, null)).toBe(true);
    });

    it('should block MCP server targeting 6to4 embedded private IPv4', async () => {
      expect(await isMCPDomainAllowed({ url: 'http://[2002:7f00:1::]/mcp' }, null)).toBe(false);
      expect(await isMCPDomainAllowed({ url: 'ws://[2002:a9fe:a9fe::]/mcp' }, null)).toBe(false);
    });

    it('should block MCP server targeting NAT64 embedded private IPv4', async () => {
      expect(await isMCPDomainAllowed({ url: 'http://[64:ff9b::127.0.0.1]/mcp' }, null)).toBe(
        false,
      );
    });
  });
});

describe('isOAuthUrlAllowed', () => {
  it('should return false when allowedDomains is null/undefined/empty', () => {
    expect(isOAuthUrlAllowed('https://example.com/token', null)).toBe(false);
    expect(isOAuthUrlAllowed('https://example.com/token', undefined)).toBe(false);
    expect(isOAuthUrlAllowed('https://example.com/token', [])).toBe(false);
  });

  it('should return false for unparseable URLs', () => {
    expect(isOAuthUrlAllowed('not-a-url', ['example.com'])).toBe(false);
  });

  it('should match exact hostnames', () => {
    expect(isOAuthUrlAllowed('https://example.com/token', ['example.com'])).toBe(true);
    expect(isOAuthUrlAllowed('https://other.com/token', ['example.com'])).toBe(false);
  });

  it('should match wildcard subdomains', () => {
    expect(isOAuthUrlAllowed('https://api.example.com/token', ['*.example.com'])).toBe(true);
    expect(isOAuthUrlAllowed('https://deep.nested.example.com/token', ['*.example.com'])).toBe(
      true,
    );
    expect(isOAuthUrlAllowed('https://example.com/token', ['*.example.com'])).toBe(true);
    expect(isOAuthUrlAllowed('https://other.com/token', ['*.example.com'])).toBe(false);
  });

  it('should be case-insensitive', () => {
    expect(isOAuthUrlAllowed('https://EXAMPLE.COM/token', ['example.com'])).toBe(true);
    expect(isOAuthUrlAllowed('https://example.com/token', ['EXAMPLE.COM'])).toBe(true);
  });

  it('should match private/internal URLs when hostname is in allowedDomains', () => {
    expect(isOAuthUrlAllowed('http://localhost:8080/token', ['localhost'])).toBe(true);
    expect(isOAuthUrlAllowed('http://10.0.0.1/token', ['10.0.0.1'])).toBe(true);
    expect(
      isOAuthUrlAllowed('http://host.docker.internal:8044/token', ['host.docker.internal']),
    ).toBe(true);
    expect(isOAuthUrlAllowed('http://myserver.local/token', ['*.local'])).toBe(true);
  });

  it('should match internal URLs with wildcard patterns', () => {
    expect(isOAuthUrlAllowed('https://auth.company.internal/token', ['*.company.internal'])).toBe(
      true,
    );
    expect(isOAuthUrlAllowed('https://company.internal/token', ['*.company.internal'])).toBe(true);
  });

  it('should not match when hostname is absent from allowedDomains', () => {
    expect(isOAuthUrlAllowed('http://10.0.0.1/token', ['192.168.1.1'])).toBe(false);
    expect(isOAuthUrlAllowed('http://localhost/token', ['host.docker.internal'])).toBe(false);
  });

  describe('protocol and port constraint enforcement', () => {
    it('should enforce protocol when allowedDomains specifies one', () => {
      expect(isOAuthUrlAllowed('https://auth.internal/token', ['https://auth.internal'])).toBe(
        true,
      );
      expect(isOAuthUrlAllowed('http://auth.internal/token', ['https://auth.internal'])).toBe(
        false,
      );
    });

    it('should allow any protocol when allowedDomains has bare hostname', () => {
      expect(isOAuthUrlAllowed('http://auth.internal/token', ['auth.internal'])).toBe(true);
      expect(isOAuthUrlAllowed('https://auth.internal/token', ['auth.internal'])).toBe(true);
    });

    it('should enforce port when allowedDomains specifies one', () => {
      expect(
        isOAuthUrlAllowed('https://auth.internal:8443/token', ['https://auth.internal:8443']),
      ).toBe(true);
      expect(
        isOAuthUrlAllowed('https://auth.internal:6379/token', ['https://auth.internal:8443']),
      ).toBe(false);
      expect(isOAuthUrlAllowed('https://auth.internal/token', ['https://auth.internal:8443'])).toBe(
        false,
      );
    });

    it('should allow any port when allowedDomains has no explicit port', () => {
      expect(isOAuthUrlAllowed('https://auth.internal:8443/token', ['auth.internal'])).toBe(true);
      expect(isOAuthUrlAllowed('https://auth.internal:22/token', ['auth.internal'])).toBe(true);
    });

    it('should reject wrong port even when hostname matches (prevents port-scanning)', () => {
      expect(isOAuthUrlAllowed('http://10.0.0.1:6379/token', ['http://10.0.0.1:8080'])).toBe(false);
      expect(isOAuthUrlAllowed('http://10.0.0.1:25/token', ['http://10.0.0.1:8080'])).toBe(false);
    });
  });
});

describe('validateEndpointURL', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should throw for unparseable URLs', async () => {
    await expect(validateEndpointURL('not-a-url', 'test-ep')).rejects.toThrow(
      'Invalid base URL for test-ep',
    );
  });

  it('should throw for localhost URLs', async () => {
    await expect(validateEndpointURL('http://localhost:8080/v1', 'test-ep')).rejects.toThrow(
      'targets a restricted address',
    );
  });

  it('should throw for private IP URLs', async () => {
    await expect(validateEndpointURL('http://192.168.1.1/v1', 'test-ep')).rejects.toThrow(
      'targets a restricted address',
    );
    await expect(validateEndpointURL('http://10.0.0.1/v1', 'test-ep')).rejects.toThrow(
      'targets a restricted address',
    );
    await expect(validateEndpointURL('http://172.16.0.1/v1', 'test-ep')).rejects.toThrow(
      'targets a restricted address',
    );
  });

  it('should throw for link-local / metadata IP', async () => {
    await expect(
      validateEndpointURL('http://169.254.169.254/latest/meta-data/', 'test-ep'),
    ).rejects.toThrow('targets a restricted address');
  });

  it('should throw for loopback IP', async () => {
    await expect(validateEndpointURL('http://127.0.0.1:11434/v1', 'test-ep')).rejects.toThrow(
      'targets a restricted address',
    );
  });

  it('should throw for internal Docker/Kubernetes hostnames', async () => {
    await expect(validateEndpointURL('http://redis:6379/', 'test-ep')).rejects.toThrow(
      'targets a restricted address',
    );
    await expect(validateEndpointURL('http://mongodb:27017/', 'test-ep')).rejects.toThrow(
      'targets a restricted address',
    );
  });

  it('should throw when hostname DNS-resolves to a private IP', async () => {
    mockedLookup.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }] as never);
    await expect(validateEndpointURL('https://evil.example.com/v1', 'test-ep')).rejects.toThrow(
      'resolves to a restricted address',
    );
  });

  it('should allow public URLs', async () => {
    mockedLookup.mockResolvedValueOnce([{ address: '104.18.7.192', family: 4 }] as never);
    await expect(
      validateEndpointURL('https://api.openai.com/v1', 'test-ep'),
    ).resolves.toBeUndefined();
  });

  it('should allow public URLs that resolve to public IPs', async () => {
    mockedLookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }] as never);
    await expect(
      validateEndpointURL('https://api.example.com/v1/chat', 'test-ep'),
    ).resolves.toBeUndefined();
  });

  it('should throw for non-HTTP/HTTPS schemes', async () => {
    await expect(validateEndpointURL('ftp://example.com/v1', 'test-ep')).rejects.toThrow(
      'only HTTP and HTTPS are permitted',
    );
    await expect(validateEndpointURL('file:///etc/passwd', 'test-ep')).rejects.toThrow(
      'only HTTP and HTTPS are permitted',
    );
    await expect(validateEndpointURL('data:text/plain,hello', 'test-ep')).rejects.toThrow(
      'only HTTP and HTTPS are permitted',
    );
  });

  it('should throw for IPv6 loopback URL', async () => {
    await expect(validateEndpointURL('http://[::1]:8080/v1', 'test-ep')).rejects.toThrow(
      'targets a restricted address',
    );
  });

  it('should throw for IPv6 link-local URL', async () => {
    await expect(validateEndpointURL('http://[fe80::1]/v1', 'test-ep')).rejects.toThrow(
      'targets a restricted address',
    );
  });

  it('should throw for IPv6 unique-local URL', async () => {
    await expect(validateEndpointURL('http://[fc00::1]/v1', 'test-ep')).rejects.toThrow(
      'targets a restricted address',
    );
  });

  it('should throw for .local TLD hostname', async () => {
    await expect(validateEndpointURL('http://myservice.local/v1', 'test-ep')).rejects.toThrow(
      'targets a restricted address',
    );
  });

  it('should throw for .internal TLD hostname', async () => {
    await expect(validateEndpointURL('http://api.internal/v1', 'test-ep')).rejects.toThrow(
      'targets a restricted address',
    );
  });

  it('should pass when DNS lookup fails (fail-open)', async () => {
    mockedLookup.mockRejectedValueOnce(new Error('ENOTFOUND'));
    await expect(
      validateEndpointURL('https://nonexistent.example.com/v1', 'test-ep'),
    ).resolves.toBeUndefined();
  });

  it('should throw structured JSON with type invalid_base_url', async () => {
    const error = await validateEndpointURL('http://169.254.169.254/latest/', 'my-ep').catch(
      (err: Error) => err,
    );
    expect(error).toBeInstanceOf(Error);
    const parsed = JSON.parse((error as Error).message);
    expect(parsed.type).toBe('invalid_base_url');
    expect(parsed.message).toContain('my-ep');
    expect(parsed.message).toContain('targets a restricted address');
  });
});

describe('isAddressAllowed', () => {
  it('returns false when no allowedAddresses configured', () => {
    expect(isAddressAllowed('127.0.0.1')).toBe(false);
    expect(isAddressAllowed('127.0.0.1', null)).toBe(false);
    expect(isAddressAllowed('127.0.0.1', [])).toBe(false);
  });

  it('matches literal IPv4 entries', () => {
    expect(isAddressAllowed('127.0.0.1', ['127.0.0.1:11434'], '11434')).toBe(true);
    expect(isAddressAllowed('10.0.0.5', ['127.0.0.1:11434', '10.0.0.5:8080'], 8080)).toBe(true);
    expect(isAddressAllowed('192.168.1.1', ['10.0.0.5:8080'], '8080')).toBe(false);
  });

  it('matches literal hostnames case-insensitively', () => {
    expect(isAddressAllowed('localhost', ['localhost:11434'], '11434')).toBe(true);
    expect(isAddressAllowed('LOCALHOST', ['localhost:11434'], '11434')).toBe(true);
    expect(isAddressAllowed('host.docker.internal', ['HOST.DOCKER.INTERNAL:8080'], 8080)).toBe(
      true,
    );
  });

  it('strips IPv6 brackets when matching', () => {
    expect(isAddressAllowed('[::1]', ['[::1]:11434'], '11434')).toBe(true);
    expect(isAddressAllowed('::1', ['[::1]:11434'], '11434')).toBe(true);
  });

  it('does not match a different port on the same address', () => {
    expect(isAddressAllowed('localhost', ['localhost:11434'], '8080')).toBe(false);
    expect(isAddressAllowed('127.0.0.1', ['127.0.0.1:11434'], '8080')).toBe(false);
  });

  it('does not match bare allowedAddresses entries', () => {
    expect(isAddressAllowed('localhost', ['localhost'], '11434')).toBe(false);
    expect(isAddressAllowed('127.0.0.1', ['127.0.0.1'], '11434')).toBe(false);
  });

  it('does not partial-match hostnames', () => {
    expect(isAddressAllowed('evil.localhost', ['localhost:11434'], '11434')).toBe(false);
    expect(isAddressAllowed('host', ['host.docker.internal:11434'], '11434')).toBe(false);
  });

  it('ignores empty entries', () => {
    expect(isAddressAllowed('localhost', ['', '   ', 'localhost:11434'], '11434')).toBe(true);
    expect(isAddressAllowed('localhost', ['', '   '], '11434')).toBe(false);
  });
});

describe('SSRF allowedAddresses exemption', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('isSSRFTarget', () => {
    it('exempts a hostname listed in allowedAddresses', () => {
      expect(isSSRFTarget('localhost')).toBe(true);
      expect(isSSRFTarget('localhost', ['localhost:11434'], '11434')).toBe(false);
    });

    it('exempts a private IP listed in allowedAddresses', () => {
      expect(isSSRFTarget('10.0.0.5')).toBe(true);
      expect(isSSRFTarget('10.0.0.5', ['10.0.0.5:11434'], '11434')).toBe(false);
    });

    it('does not exempt a different port on an allowed private target', () => {
      expect(isSSRFTarget('localhost', ['localhost:11434'], '22')).toBe(true);
      expect(isSSRFTarget('10.0.0.5', ['10.0.0.5:11434'], '22')).toBe(true);
    });

    it('does not exempt an unlisted private target', () => {
      expect(isSSRFTarget('192.168.1.1', ['10.0.0.5:11434'], '11434')).toBe(true);
    });

    it('leaves public destinations unaffected when allowedAddresses is set', () => {
      expect(isSSRFTarget('api.openai.com', ['localhost:11434'], '11434')).toBe(false);
    });
  });

  describe('resolveHostnameSSRF', () => {
    it('exempts when the hostname itself matches allowedAddresses', async () => {
      // No lookup mock needed: a hostname-literal match short-circuits before DNS.
      expect(await resolveHostnameSSRF('ollama.internal', ['ollama.internal:11434'], '11434')).toBe(
        false,
      );
    });

    it('exempts when a resolved IP matches allowedAddresses', async () => {
      mockedLookup.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }] as never);
      expect(await resolveHostnameSSRF('private.example.com', ['10.0.0.5:11434'], '11434')).toBe(
        false,
      );
    });

    it('blocks when the host matches but the port does not', async () => {
      mockedLookup.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }] as never);
      expect(await resolveHostnameSSRF('private.example.com', ['10.0.0.5:11434'], '22')).toBe(true);
    });

    it('still blocks when no entry matches', async () => {
      mockedLookup.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }] as never);
      expect(await resolveHostnameSSRF('private.example.com', ['127.0.0.1:11434'], '11434')).toBe(
        true,
      );
    });

    it('blocks when one of multiple resolved IPs is private and unlisted', async () => {
      mockedLookup.mockResolvedValueOnce([
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ] as never);
      expect(await resolveHostnameSSRF('mixed.example.com', ['127.0.0.1:11434'], '11434')).toBe(
        true,
      );
    });

    it('passes when all resolved private IPs are listed', async () => {
      mockedLookup.mockResolvedValueOnce([
        { address: '10.0.0.5', family: 4 },
        { address: '10.0.0.6', family: 4 },
      ] as never);
      expect(
        await resolveHostnameSSRF(
          'cluster.example.com',
          ['10.0.0.5:11434', '10.0.0.6:11434'],
          '11434',
        ),
      ).toBe(false);
    });
  });

  describe('validateEndpointURL', () => {
    it('passes a private-IP URL when its IP is in allowedAddresses', async () => {
      await expect(
        validateEndpointURL('http://10.0.0.5/v1', 'ollama', ['10.0.0.5:80']),
      ).resolves.toBeUndefined();
    });

    it('passes a localhost URL when localhost is in allowedAddresses', async () => {
      await expect(
        validateEndpointURL('http://localhost:11434/v1', 'ollama', ['localhost:11434']),
      ).resolves.toBeUndefined();
    });

    it('passes a hostname URL when DNS resolves to an exempted IP', async () => {
      mockedLookup.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }] as never);
      await expect(
        validateEndpointURL('https://ollama.example.com/v1', 'ollama', ['10.0.0.5:443']),
      ).resolves.toBeUndefined();
    });

    it('rejects a different port on the same allowed private address', async () => {
      await expect(
        validateEndpointURL('http://localhost:22/v1', 'ollama', ['localhost:11434']),
      ).rejects.toThrow('targets a restricted address');
    });

    it('still rejects unlisted private IPs when allowedAddresses is set', async () => {
      await expect(
        validateEndpointURL('http://192.168.1.1/v1', 'test-ep', ['10.0.0.5:80']),
      ).rejects.toThrow('targets a restricted address');
    });

    it('still rejects non-http schemes regardless of allowedAddresses', async () => {
      await expect(
        validateEndpointURL('file:///etc/passwd', 'test-ep', ['localhost:11434']),
      ).rejects.toThrow('only HTTP and HTTPS are permitted');
    });
  });

  describe('isActionDomainAllowed', () => {
    it('exempts a private IP when listed in allowedAddresses (no allowedDomains)', async () => {
      expect(await isActionDomainAllowed('http://10.0.0.5:8080/api', null, ['10.0.0.5:8080'])).toBe(
        true,
      );
    });

    it('does not exempt a different port on an allowed private IP', async () => {
      expect(await isActionDomainAllowed('http://10.0.0.5:8081/api', null, ['10.0.0.5:8080'])).toBe(
        false,
      );
    });

    it('still blocks unlisted private IPs', async () => {
      expect(await isActionDomainAllowed('http://192.168.1.1/api', null, ['10.0.0.5:80'])).toBe(
        false,
      );
    });
  });

  describe('isMCPDomainAllowed', () => {
    it('exempts a private-IP MCP server when its IP is in allowedAddresses', async () => {
      expect(
        await isMCPDomainAllowed({ url: 'https://10.0.0.5:8443/mcp' }, null, ['10.0.0.5:8443']),
      ).toBe(true);
    });

    it('still blocks an unlisted private MCP target', async () => {
      expect(
        await isMCPDomainAllowed({ url: 'https://192.168.1.1/mcp' }, null, ['10.0.0.5:443']),
      ).toBe(false);
    });
  });

  describe('isOAuthUrlAllowed', () => {
    it('returns true when the URL host:port is in allowedAddresses (no allowedDomains)', () => {
      expect(isOAuthUrlAllowed('https://10.0.0.5/oauth', null, ['10.0.0.5:443'])).toBe(true);
    });

    it('returns false when the OAuth URL uses a different port than allowedAddresses', () => {
      expect(isOAuthUrlAllowed('https://10.0.0.5:8443/oauth', null, ['10.0.0.5:443'])).toBe(false);
    });

    it('still requires allowedDomains match for non-exempted URLs', () => {
      expect(isOAuthUrlAllowed('https://other.example.com/oauth', null, ['10.0.0.5:443'])).toBe(
        false,
      );
      expect(
        isOAuthUrlAllowed(
          'https://other.example.com/oauth',
          ['other.example.com'],
          ['10.0.0.5:443'],
        ),
      ).toBe(true);
    });

    it('does not let allowedAddresses bypass a configured allowedDomains list', () => {
      // Admin set `mcpSettings.allowedDomains` to constrain OAuth metadata/token/revocation
      // hosts. An unrelated `allowedAddresses` entry (e.g. for self-hosted Ollama) must NOT
      // broaden that bound — otherwise a malicious MCP server could advertise OAuth at any
      // exempted private address and pass validation.
      expect(
        isOAuthUrlAllowed('http://10.0.0.5/oauth', ['oauth.trusted.com'], ['10.0.0.5:80']),
      ).toBe(false);
      expect(
        isOAuthUrlAllowed('http://127.0.0.1/oauth', ['oauth.trusted.com'], ['127.0.0.1:80']),
      ).toBe(false);
    });

    it('rejects schemeless inputs even when the host:port is in allowedAddresses', () => {
      // `parseDomainSpec` quietly prepends `https://` to schemeless inputs.
      // Without a strict `new URL(url)` gate, a value like `10.0.0.5/oauth`
      // would short-circuit the trust-bypass and skip `validateOAuthUrl`'s
      // own parse-or-throw. The check must require an absolute URL.
      expect(isOAuthUrlAllowed('10.0.0.5/oauth', null, ['10.0.0.5:443'])).toBe(false);
      expect(isOAuthUrlAllowed('127.0.0.1', null, ['127.0.0.1:443'])).toBe(false);
      expect(isOAuthUrlAllowed('//10.0.0.5/oauth', null, ['10.0.0.5:443'])).toBe(false);
    });
  });
});

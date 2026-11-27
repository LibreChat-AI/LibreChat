/**
 * Tests for the SSRF-safe avatar fetcher in `avatar.js`.
 *
 * The function is the sole line of defense against SSRF when a social
 * login surfaces a user-controllable `picture` URL. We assert each
 * rejection branch (protocol, status, redirect, size, agent) and the
 * happy path so that a future refactor of the fetch / agent / URL
 * handling cannot silently break the protection.
 */
jest.mock('node-fetch');
jest.mock('@librechat/api', () => ({
  createSSRFSafeAgents: jest.fn(() => ({
    httpAgent: { __kind: 'http' },
    httpsAgent: { __kind: 'https' },
  })),
}));
jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('librechat-data-provider', () => ({
  EImageOutputType: { PNG: 'png' },
}));
jest.mock('./resize', () => ({
  resizeAndConvert: jest.fn(async ({ inputBuffer }) => ({ buffer: inputBuffer })),
}));
jest.mock('sharp', () => {
  const sharpFn = jest.fn();
  return sharpFn;
});

const fetch = require('node-fetch');
const { createSSRFSafeAgents } = require('@librechat/api');
const sharp = require('sharp');
const { resizeAvatar } = require('./avatar');

function makeResponse({ ok = true, status = 200, body = Buffer.from(''), contentLength } = {}) {
  return {
    ok,
    status,
    headers: {
      get: (name) => {
        if (name.toLowerCase() === 'content-length') {
          return contentLength != null ? String(contentLength) : null;
        }
        return null;
      },
    },
    buffer: jest.fn(async () => body),
  };
}

function makeSharpStub(format = 'png', width = 100, height = 100) {
  const chain = {
    metadata: jest.fn(async () => ({ format, width, height })),
    extract: jest.fn(() => chain),
    resize: jest.fn(() => chain),
    gif: jest.fn(() => chain),
    toBuffer: jest.fn(async () => Buffer.from('squared')),
  };
  return chain;
}

const callResize = (input) => resizeAvatar({ userId: 'u1', input });

describe('resizeAvatar — fetchAvatarBuffer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sharp.mockImplementation(() => makeSharpStub());
  });

  describe('rejects unsafe inputs before any network call', () => {
    it('rejects a malformed URL string', async () => {
      await expect(callResize('not-a-url')).rejects.toThrow('Invalid avatar URL');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('rejects file:// URLs', async () => {
      await expect(callResize('file:///etc/passwd')).rejects.toThrow(/Refusing to fetch.*file:/);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('rejects data: URLs', async () => {
      await expect(callResize('data:image/png;base64,AAAA')).rejects.toThrow(
        /Refusing to fetch.*data:/,
      );
      expect(fetch).not.toHaveBeenCalled();
    });

    it('rejects javascript: URLs', async () => {
      await expect(callResize('javascript:void(0)')).rejects.toThrow(
        /Refusing to fetch.*javascript:/,
      );
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    it('returns a processed buffer for a valid https URL', async () => {
      fetch.mockResolvedValueOnce(makeResponse({ body: Buffer.from('rawimg') }));
      const result = await callResize('https://cdn.example.com/avatar.png');
      expect(fetch).toHaveBeenCalledTimes(1);
      // `parsed.href` canonicalizes the input — assert we did not pass the raw string.
      expect(fetch.mock.calls[0][0]).toBe('https://cdn.example.com/avatar.png');
      const opts = fetch.mock.calls[0][1];
      expect(opts.redirect).toBe('error');
      expect(opts.timeout).toBe(5000);
      expect(opts.size).toBe(10 * 1024 * 1024);
      expect(typeof opts.agent).toBe('function');
      expect(result).toEqual(Buffer.from('squared'));
    });

    it('passes an SSRF-safe agent factory routing https→httpsAgent and http→httpAgent', async () => {
      fetch.mockResolvedValueOnce(makeResponse({ body: Buffer.from('rawimg') }));
      await callResize('https://cdn.example.com/avatar.png');
      const agentFn = fetch.mock.calls[0][1].agent;
      expect(agentFn(new URL('https://anything'))).toEqual({ __kind: 'https' });
      expect(agentFn(new URL('http://anything'))).toEqual({ __kind: 'http' });
      expect(createSSRFSafeAgents).toHaveBeenCalledTimes(1);
    });

    it('passes configured fetch headers while preserving shared fetch controls', async () => {
      fetch.mockResolvedValueOnce(makeResponse({ body: Buffer.from('rawimg') }));
      await resizeAvatar({
        userId: 'u1',
        input: 'https://cdn.example.com/avatar.png',
        fetchOptions: {
          headers: {
            Authorization: 'Bearer avatar-token',
          },
        },
      });

      const opts = fetch.mock.calls[0][1];
      expect(opts.headers).toEqual({ Authorization: 'Bearer avatar-token' });
      expect(opts.redirect).toBe('error');
      expect(opts.timeout).toBe(5000);
      expect(opts.size).toBe(10 * 1024 * 1024);
      expect(typeof opts.agent).toBe('function');
    });
  });

  describe('rejects unsafe responses', () => {
    it('rejects non-2xx HTTP status', async () => {
      fetch.mockResolvedValueOnce(makeResponse({ ok: false, status: 500 }));
      await expect(callResize('https://cdn.example.com/avatar.png')).rejects.toThrow(
        /Status:\s*500/,
      );
    });

    it('rejects an oversized Content-Length header before reading the body', async () => {
      const oversize = 11 * 1024 * 1024;
      const resp = makeResponse({ contentLength: oversize });
      fetch.mockResolvedValueOnce(resp);
      await expect(callResize('https://cdn.example.com/big.png')).rejects.toThrow(
        /Avatar response too large.*11534336/,
      );
      // We must not even read the body once the header has already disqualified it.
      expect(resp.buffer).not.toHaveBeenCalled();
    });

    it('rejects a body whose actual size exceeds the cap (lying / missing Content-Length)', async () => {
      const oversize = Buffer.alloc(11 * 1024 * 1024);
      // No content-length header — server lies or omits.
      fetch.mockResolvedValueOnce(makeResponse({ body: oversize }));
      await expect(callResize('https://cdn.example.com/lies.png')).rejects.toThrow(
        /Avatar response too large.*11534336/,
      );
    });
  });

  describe('propagates fetch-layer errors', () => {
    it('surfaces SSRF rejection thrown by the agent (ESSRF)', async () => {
      const ssrfError = Object.assign(new Error('SSRF protection: 127.0.0.1 blocked'), {
        code: 'ESSRF',
      });
      fetch.mockRejectedValueOnce(ssrfError);
      await expect(callResize('http://internal.attacker.example/img.png')).rejects.toThrow(
        /SSRF protection/,
      );
    });

    it('surfaces redirect rejection from `redirect: error`', async () => {
      const redirectError = Object.assign(new Error('redirect mode is set to error'), {
        type: 'no-redirect',
      });
      fetch.mockRejectedValueOnce(redirectError);
      await expect(callResize('https://cdn.example.com/redirected.png')).rejects.toThrow(
        /redirect mode/,
      );
    });

    it('surfaces a `size` overflow thrown by node-fetch', async () => {
      const sizeError = Object.assign(new Error('content size at 11534336 over limit: 10485760'), {
        type: 'max-size',
      });
      fetch.mockRejectedValueOnce(sizeError);
      await expect(callResize('https://cdn.example.com/large.png')).rejects.toThrow(/over limit/);
    });
  });

  describe('non-string inputs bypass the fetcher', () => {
    it('accepts a Buffer input directly without calling fetch', async () => {
      const buf = Buffer.from('inline');
      const result = await callResize(buf);
      expect(fetch).not.toHaveBeenCalled();
      expect(result).toEqual(Buffer.from('squared'));
    });
  });
});

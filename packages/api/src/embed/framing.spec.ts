import type { Request, Response } from 'express';
import { createEmbedFramingMiddleware, withEmbedFrameAncestors } from './framing';

function run(path: string, initialHeaders: Record<string, string> = {}) {
  const middleware = createEmbedFramingMiddleware(['https://portal.example.com']);
  const headers = new Map(Object.entries(initialHeaders));
  const res = {
    setHeader: (name: string, value: string) => headers.set(name, value),
    getHeader: (name: string) => headers.get(name),
    removeHeader: (name: string) => headers.delete(name),
  } as unknown as Response;
  const next = jest.fn();
  middleware?.({ path } as Request, res, next);
  expect(next).toHaveBeenCalled();
  return headers;
}

describe('createEmbedFramingMiddleware', () => {
  it('is not created without embed origins', () => {
    expect(createEmbedFramingMiddleware([])).toBeNull();
  });

  it('replaces X-Frame-Options with frame-ancestors naming the embed origins', () => {
    const headers = run('/c/new', { 'X-Frame-Options': 'SAMEORIGIN' });
    expect(headers.has('X-Frame-Options')).toBe(false);
    expect(headers.get('Content-Security-Policy')).toBe(
      "frame-ancestors 'self' https://portal.example.com",
    );
  });

  it('keeps a Content-Security-Policy already on the response', () => {
    const headers = run('/c/new', { 'Content-Security-Policy': "default-src 'self'" });
    expect(headers.get('Content-Security-Policy')).toBe("default-src 'self'");
  });

  it('lets other origins load the loader script', () => {
    const headers = run('/embed.js', { 'Cross-Origin-Resource-Policy': 'same-origin' });
    expect(headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
  });
});

describe('withEmbedFrameAncestors', () => {
  it('returns the environment unchanged without embed origins', () => {
    const env = { CSP_ENABLED: 'true' };
    expect(withEmbedFrameAncestors(env, [])).toBe(env);
  });

  it("adds the embed origins to 'self' when none are configured", () => {
    const env = withEmbedFrameAncestors({}, ['https://portal.example.com']);
    expect(env.CSP_FRAME_ANCESTORS).toBe("'self' https://portal.example.com");
  });

  it('adds the embed origins to configured ancestors', () => {
    const env = withEmbedFrameAncestors(
      { CSP_FRAME_ANCESTORS: "'self' https://intranet.example" },
      ['https://portal.example.com'],
    );
    expect(env.CSP_FRAME_ANCESTORS).toBe(
      "'self' https://intranet.example https://portal.example.com",
    );
  });
});

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { createJwtExtractor } from './jwt';
import type { IncomingHttpHeaders } from 'node:http';
import type { JwtExtractor } from './jwt';

const request = (headers: IncomingHttpHeaders) => ({ headers });

describe('createJwtExtractor', () => {
  let fallback: JwtExtractor;

  beforeEach(() => {
    fallback = jest.fn(() => 'from-authorization');
  });

  describe('when no header is configured', () => {
    it('returns the fallback unchanged', () => {
      expect(createJwtExtractor(undefined, fallback)).toBe(fallback);
      expect(createJwtExtractor('', fallback)).toBe(fallback);
      expect(createJwtExtractor('   ', fallback)).toBe(fallback);
    });
  });

  describe('when a header is configured', () => {
    it('reads a raw token from it', () => {
      const extract = createJwtExtractor('x-original-authorization', fallback);

      expect(extract(request({ 'x-original-authorization': 'raw.jwt.value' }))).toBe(
        'raw.jwt.value',
      );
      expect(fallback).not.toHaveBeenCalled();
    });

    it('accepts a value that still carries the Bearer scheme', () => {
      const extract = createJwtExtractor('x-original-authorization', fallback);

      expect(extract(request({ 'x-original-authorization': 'Bearer raw.jwt.value' }))).toBe(
        'raw.jwt.value',
      );
      expect(extract(request({ 'x-original-authorization': 'bearer   raw.jwt.value' }))).toBe(
        'raw.jwt.value',
      );
      expect(fallback).not.toHaveBeenCalled();
    });

    it('lowercases the configured name, since node lowercases incoming headers', () => {
      const extract = createJwtExtractor('X-Original-Authorization', fallback);

      expect(extract(request({ 'x-original-authorization': 'raw.jwt.value' }))).toBe(
        'raw.jwt.value',
      );
    });

    it('trims the configured name', () => {
      const extract = createJwtExtractor('  x-original-authorization  ', fallback);

      expect(extract(request({ 'x-original-authorization': 'raw.jwt.value' }))).toBe(
        'raw.jwt.value',
      );
    });

    it('falls back when the header is absent, empty or scheme-only', () => {
      const extract = createJwtExtractor('x-original-authorization', fallback);

      expect(extract(request({ authorization: 'Bearer other.jwt' }))).toBe('from-authorization');
      expect(extract(request({ 'x-original-authorization': '' }))).toBe('from-authorization');
      expect(extract(request({ 'x-original-authorization': '   ' }))).toBe('from-authorization');
      expect(extract(request({ 'x-original-authorization': 'Bearer ' }))).toBe('from-authorization');
      expect(fallback).toHaveBeenCalledTimes(4);
    });

    it('refuses a header sent more than once rather than guessing which value to trust', () => {
      const extract = createJwtExtractor('x-original-authorization', fallback);

      expect(extract(request({ 'x-original-authorization': ['first.jwt', 'second.jwt'] }))).toBe(
        'from-authorization',
      );
    });

    it('passes the same request to the fallback', () => {
      const extract = createJwtExtractor('x-original-authorization', fallback);
      const req = request({ authorization: 'Bearer other.jwt' });

      extract(req);

      expect(fallback).toHaveBeenCalledWith(req);
    });
  });
});

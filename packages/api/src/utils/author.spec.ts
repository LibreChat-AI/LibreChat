import { createHash } from 'node:crypto';
import { isValidObjectIdString } from '@librechat/data-schemas';
import { makeSourceAuthorId } from './author';

describe('makeSourceAuthorId', () => {
  it('returns 24 lowercase hex characters', () => {
    const id = makeSourceAuthorId('github', 'librechat-skills');
    expect(id).toMatch(/^[0-9a-f]{24}$/);
  });

  it('returns the same output for the same inputs', () => {
    const first = makeSourceAuthorId('github', 'librechat-skills', 'tenant-1');
    const second = makeSourceAuthorId('github', 'librechat-skills', 'tenant-1');
    expect(first).toBe(second);
  });

  it('returns a different output for a different sourceId', () => {
    const first = makeSourceAuthorId('github', 'librechat-skills');
    const second = makeSourceAuthorId('github', 'other-skills');
    expect(first).not.toBe(second);
  });

  it('returns a different output for a different tenantId', () => {
    const first = makeSourceAuthorId('github', 'librechat-skills', 'tenant-1');
    const second = makeSourceAuthorId('github', 'librechat-skills', 'tenant-2');
    expect(first).not.toBe(second);
  });

  it('treats an undefined tenantId and an empty tenantId the same', () => {
    const withUndefined = makeSourceAuthorId('github', 'librechat-skills', undefined);
    const withEmpty = makeSourceAuthorId('github', 'librechat-skills', '');
    expect(withUndefined).toBe(withEmpty);
  });

  it('matches the GitHub sync reference computation without a tenant', () => {
    const seed = 'github:librechat-skills';
    const expected = createHash('sha256').update(seed).digest('hex').slice(0, 24);
    expect(makeSourceAuthorId('github', 'librechat-skills')).toBe(expected);
  });

  it('matches the GitHub sync reference computation with a tenant', () => {
    const seed = 'github:librechat-skills:tenant-1';
    const expected = createHash('sha256').update(seed).digest('hex').slice(0, 24);
    expect(makeSourceAuthorId('github', 'librechat-skills', 'tenant-1')).toBe(expected);
  });

  it('produces a valid 24-hex ObjectId string', () => {
    const id = makeSourceAuthorId('github', 'librechat-skills', 'tenant-1');
    expect(isValidObjectIdString(id)).toBe(true);
  });

  it('throws when provider contains ":"', () => {
    expect(() => makeSourceAuthorId('git:hub', 'librechat-skills')).toThrow(/must not contain/);
  });

  it('throws when sourceId contains ":"', () => {
    expect(() => makeSourceAuthorId('github', 'librechat:skills')).toThrow(/must not contain/);
  });

  it('throws when tenantId contains ":"', () => {
    expect(() => makeSourceAuthorId('github', 'librechat-skills', 'tenant:1')).toThrow(
      /must not contain/,
    );
  });

  it('does not throw for a tenantId of undefined or empty string', () => {
    expect(() => makeSourceAuthorId('github', 'librechat-skills', undefined)).not.toThrow();
    expect(() => makeSourceAuthorId('github', 'librechat-skills', '')).not.toThrow();
  });
});

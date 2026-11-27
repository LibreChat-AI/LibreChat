import { resolveCodeWorkerEnrollmentLimit } from './enrollment';

describe('personal worker enrollment policy', () => {
  test.each([
    [undefined, undefined, 5],
    [{ maxPerUser: 100 }, undefined, 100],
    [{ maxPerUser: 100 }, { maxPerUser: 20 }, 20],
    [{ maxPerUser: 10 }, { maxPerUser: 100 }, 10],
    [undefined, { maxPerUser: 100 }, 5],
    [{ enabled: false }, { enabled: true }, 0],
    [{ enabled: true }, { enabled: false }, 0],
    [{ maxPerUser: 0 }, { maxPerUser: 100 }, 0],
    [{ maxPerUser: 100 }, { maxPerUser: 0 }, 0],
    [{ maxPerUser: -1 }, undefined, 0],
    [{ maxPerUser: Infinity }, undefined, 0],
    [undefined, { maxPerUser: NaN }, 0],
    [undefined, { maxPerUser: 1.5 }, 0],
    [{ maxPerUser: Number.MAX_SAFE_INTEGER + 1 }, undefined, 0],
  ])('resolves deployment %j and principal %j to %i', (deployment, effective, expected) => {
    expect(resolveCodeWorkerEnrollmentLimit(deployment, effective)).toBe(expected);
  });

  test('supports a caller fallback without replacing an explicit deployment policy', () => {
    expect(resolveCodeWorkerEnrollmentLimit(undefined, undefined, 3)).toBe(3);
    expect(resolveCodeWorkerEnrollmentLimit({ maxPerUser: 10 }, undefined, 3)).toBe(10);
  });
});

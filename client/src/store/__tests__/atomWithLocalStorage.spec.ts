import { snapshot_UNSTABLE } from 'recoil';
import { atomWithLocalStorage } from '../utils';

/**
 * The helper now normalizes the default when nothing is persisted, not only a
 * saved value. That reaches every atom built with it, so the cases that matter
 * are the ones where a normalizer exists and could change an untouched default.
 */
describe('atomWithLocalStorage default normalization', () => {
  beforeEach(() => localStorage.clear());

  const read = <T>(atom: ReturnType<typeof atomWithLocalStorage<T>>) =>
    snapshot_UNSTABLE().getLoadable(atom).valueOrThrow();

  it('leaves the default alone without a normalizer', () => {
    expect(read(atomWithLocalStorage('plain-default', 'kept'))).toBe('kept');
  });

  it('leaves the default alone when the normalizer accepts it', () => {
    /** The shape the speech-engine atoms have: valid defaults pass through. */
    const atom = atomWithLocalStorage('idempotent-default', 'browser', (engine) =>
      engine === 'browser' ? engine : 'browser',
    );

    expect(read(atom)).toBe('browser');
  });

  it('corrects a default the normalizer rejects', () => {
    const atom = atomWithLocalStorage('rejected-default', 'legacy', (engine) =>
      engine === 'legacy' ? 'external' : engine,
    );

    expect(read(atom)).toBe('external');
  });

  it('still normalizes a persisted value', () => {
    localStorage.setItem('persisted-value', JSON.stringify('legacy'));
    const atom = atomWithLocalStorage('persisted-value', 'browser', (engine) =>
      engine === 'legacy' ? 'external' : engine,
    );

    expect(read(atom)).toBe('external');
  });

  /**
   * Unparseable storage falls back to the default too, and that fallback is
   * subject to the same stale-at-module-load problem as the missing-key one.
   */
  describe('when the persisted value cannot be parsed', () => {
    beforeEach(() => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      localStorage.setItem('corrupt-value', '{not json');
    });

    it('falls back to the normalized default', () => {
      const atom = atomWithLocalStorage('corrupt-value', 'legacy', (engine) =>
        engine === 'legacy' ? 'external' : engine,
      );

      expect(read(atom)).toBe('external');
    });

    it('persists the normalized default over the unusable value', () => {
      const atom = atomWithLocalStorage('corrupt-value', 'legacy', (engine) =>
        engine === 'legacy' ? 'external' : engine,
      );
      read(atom);

      expect(localStorage.getItem('corrupt-value')).toBe(JSON.stringify('external'));
    });
  });
});

/**
 * @jest-environment jsdom
 */
import {
  clearTwoFactorSetupToken,
  persistTwoFactorSetupToken,
  readTwoFactorSetupToken,
} from './twoFactor';

const STORAGE_KEY = 'two_factor_setup_token';

describe('two-factor setup token hand-off', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    clearTwoFactorSetupToken();
  });

  it('round-trips a token without touching the URL', () => {
    persistTwoFactorSetupToken('setup-token');

    expect(readTwoFactorSetupToken()).toBe('setup-token');
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe('setup-token');
    expect(window.location.search).toBe('');
  });

  it('reads nothing before a token is handed over', () => {
    expect(readTwoFactorSetupToken()).toBe('');
  });

  it('trims the surrounding whitespace a transport may add', () => {
    persistTwoFactorSetupToken('  setup-token  ');

    expect(readTwoFactorSetupToken()).toBe('setup-token');
  });

  it('drops the credential from both storage and memory when cleared', () => {
    persistTwoFactorSetupToken('setup-token');

    clearTwoFactorSetupToken();

    expect(readTwoFactorSetupToken()).toBe('');
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('falls back to the in-memory mirror when session storage is unavailable', () => {
    persistTwoFactorSetupToken('setup-token');
    const getItem = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });

    expect(readTwoFactorSetupToken()).toBe('setup-token');

    getItem.mockRestore();
  });

  it('survives a persist that session storage refuses', () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });

    expect(() => persistTwoFactorSetupToken('setup-token')).not.toThrow();
    setItem.mockRestore();
    expect(readTwoFactorSetupToken()).toBe('setup-token');
  });

  it('reports that a stored token outlives the current document', () => {
    expect(persistTwoFactorSetupToken('setup-token')).toBe(true);
  });

  /**
   * The mirror lives on `window`, so a caller that is about to replace the document has to know it
   * is the only copy left. Reporting the refusal is what keeps that navigation in the same page.
   */
  it('reports a refused persist so the caller can keep the document', () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });

    expect(persistTwoFactorSetupToken('setup-token')).toBe(false);

    setItem.mockRestore();
  });
});

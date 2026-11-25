import { readThemeColor } from './color';

describe('readThemeColor', () => {
  const root = document.documentElement;

  afterEach(() => {
    root.removeAttribute('style');
  });

  it('wraps a channel triplet in rgb()', () => {
    root.style.setProperty('--probe', '13 13 13');
    expect(readThemeColor('--probe')).toBe('rgb(13 13 13)');
  });

  it('keeps an alpha written after the triplet', () => {
    root.style.setProperty('--probe', '0 0 0 / 0.4');
    expect(readThemeColor('--probe')).toBe('rgb(0 0 0 / 0.4)');
  });

  it('returns a value that is already a color as set', () => {
    root.style.setProperty('--probe', '#fafafa');
    expect(readThemeColor('--probe')).toBe('#fafafa');
  });

  it('returns null for an unset or unresolved property', () => {
    expect(readThemeColor('--probe')).toBeNull();
    root.style.setProperty('--probe', 'var(--missing)');
    expect(readThemeColor('--probe')).toBeNull();
  });

  it('reads the element it is given', () => {
    const scoped = document.createElement('div');
    scoped.style.setProperty('--probe', '1 2 3');
    document.body.append(scoped);
    expect(readThemeColor('--probe', scoped)).toBe('rgb(1 2 3)');
    scoped.remove();
  });
});

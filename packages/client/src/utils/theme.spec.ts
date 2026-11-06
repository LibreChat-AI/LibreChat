import { applyUiScale, MIN_UI_SCALE, MAX_UI_SCALE, DEFAULT_UI_SCALE } from './theme';

describe('applyUiScale', () => {
  const readScale = () => document.documentElement.style.getPropertyValue('--ui-scale');

  afterEach(() => {
    document.documentElement.style.removeProperty('--ui-scale');
  });

  it('sets the scale custom property on the root element', () => {
    applyUiScale(1.25);
    expect(readScale()).toBe('1.25');
  });

  it('clamps values below the minimum', () => {
    applyUiScale(0.1);
    expect(readScale()).toBe(String(MIN_UI_SCALE));
  });

  it('clamps values above the maximum', () => {
    applyUiScale(4);
    expect(readScale()).toBe(String(MAX_UI_SCALE));
  });

  it('falls back to the default for non-finite values', () => {
    applyUiScale(Number.NaN);
    expect(readScale()).toBe(String(DEFAULT_UI_SCALE));

    applyUiScale(Number.POSITIVE_INFINITY);
    expect(readScale()).toBe(String(DEFAULT_UI_SCALE));
  });

  it('falls back to the default when a persisted value is not a number', () => {
    applyUiScale('1.25' as unknown as number);
    expect(readScale()).toBe(String(DEFAULT_UI_SCALE));
  });
});

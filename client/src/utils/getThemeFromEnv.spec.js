import { getThemeFromEnv } from './getThemeFromEnv';

describe('getThemeFromEnv', () => {
  it('loads link and accent colors', () => {
    expect(
      getThemeFromEnv({
        REACT_APP_THEME_LINK: '1 2 3',
        REACT_APP_THEME_LINK_HOVER: '4 5 6',
        REACT_APP_THEME_LINK_VISITED: '7 8 9',
        REACT_APP_THEME_ACCENT_PRIMARY: '10 11 12',
        REACT_APP_THEME_ACCENT_PRIMARY_HOVER: '13 14 15',
      }),
    ).toEqual({
      'rgb-link': '1 2 3',
      'rgb-link-hover': '4 5 6',
      'rgb-link-visited': '7 8 9',
      'rgb-accent-primary': '10 11 12',
      'rgb-accent-primary-hover': '13 14 15',
    });
  });

  it('loads status, inverted, fixed and destructive colors', () => {
    expect(
      getThemeFromEnv({
        REACT_APP_THEME_STATUS_ERROR: '1 2 3',
        REACT_APP_THEME_STATUS_SUCCESS_SUBTLE: '4 5 6',
        REACT_APP_THEME_STATUS_NEUTRAL_BORDER: '7 8 9',
        REACT_APP_THEME_TEXT_DESTRUCTIVE: '10 11 12',
        REACT_APP_THEME_BORDER_DESTRUCTIVE: '13 14 15',
        REACT_APP_THEME_SURFACE_INVERTED: '16 17 18',
        REACT_APP_THEME_TEXT_INVERTED: '19 20 21',
        REACT_APP_THEME_SURFACE_FIXED_HOVER: '22 23 24',
        REACT_APP_THEME_TEXT_FIXED: '25 26 27',
        REACT_APP_THEME_SURFACE_OVERLAY: '28 29 30',
        REACT_APP_THEME_STATUS_SUCCESS_STRONG: '31 32 33',
        REACT_APP_THEME_STATUS_INFO_STRONG: '34 35 36',
        REACT_APP_THEME_STATUS_WARNING_STRONG: '37 38 39',
        REACT_APP_THEME_STATUS_ERROR_STRONG: '40 41 42',
        REACT_APP_THEME_TEXT_ON_STATUS: '43 44 45',
        REACT_APP_THEME_SURFACE_COMPOSER_HOVER: '46 47 48',
      }),
    ).toEqual({
      'rgb-status-error': '1 2 3',
      'rgb-status-success-subtle': '4 5 6',
      'rgb-status-neutral-border': '7 8 9',
      'rgb-text-destructive': '10 11 12',
      'rgb-border-destructive': '13 14 15',
      'rgb-surface-inverted': '16 17 18',
      'rgb-text-inverted': '19 20 21',
      'rgb-surface-fixed-hover': '22 23 24',
      'rgb-text-fixed': '25 26 27',
      'rgb-surface-overlay': '28 29 30',
      'rgb-status-success-strong': '31 32 33',
      'rgb-status-info-strong': '34 35 36',
      'rgb-status-warning-strong': '37 38 39',
      'rgb-status-error-strong': '40 41 42',
      'rgb-text-on-status': '43 44 45',
      'rgb-surface-composer-hover': '46 47 48',
    });
  });

  it('ignores unrelated and empty values', () => {
    expect(
      getThemeFromEnv({
        MODE: 'test',
        REACT_APP_THEME_TEXT_PRIMARY: '',
        REACT_APP_THEME_UNKNOWN_TOKEN: '1 2 3',
        REACT_APP_THEME_SURFACE_PRIMARY: '4 5 6',
      }),
    ).toEqual({ 'rgb-surface-primary': '4 5 6' });
  });

  it('returns undefined when no theme variables are set', () => {
    expect(getThemeFromEnv({})).toBeUndefined();
  });

  it('reads the build-time environment when no source is given', () => {
    expect(getThemeFromEnv()).toBeUndefined();
  });
});

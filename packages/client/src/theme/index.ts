// Export types
export * from './types';

// Export ThemeProvider, ThemeContext, useTheme hook, and the mode predicates
export {
  ThemeProvider,
  ThemeContext,
  useTheme,
  isDark,
  isHighContrast,
  resolvesToHighContrast,
} from './context/ThemeProvider';

// Export utility functions
export {
  default as applyTheme,
  applyResolvedTheme,
  clearAppliedTheme,
  themeOwnedProperties,
} from './utils/applyTheme';

export {
  HIGH_CONTRAST_THEME_NAME,
  THEME_VERSION,
  defaultAppearance,
  defaultBrands,
  fromLegacyTheme,
  highContrastTheme,
  libreChatTheme,
  resolveTheme,
  themeAppearanceProperties,
  themeBrandTokens,
  themeColorTokens,
  validateThemeDefinition,
} from './registry';

// Export theme atoms for persistence
export { themeModeAtom, themeColorsAtom, themeNameAtom } from './atoms/themeAtoms';

// Export predefined themes
export * from './themes';

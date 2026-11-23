import {
  describeThemeColors,
  describeResolvedTheme,
  THEME_DISABLED_ATTRIBUTE,
  THEME_FIELD_FOCUS_ATTRIBUTE,
  themeOwnedProperties,
} from 'librechat-data-provider';
import type { IThemeRGB, ResolvedThemeDefinition } from 'librechat-data-provider';

export {
  describeResolvedTheme,
  themeOwnedProperties,
  THEME_DISABLED_ATTRIBUTE,
  THEME_FIELD_FOCUS_ATTRIBUTE,
} from 'librechat-data-provider';
export type { ResolvedThemeStyle } from 'librechat-data-provider';

const rgbPattern = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})$/;

function validateRGB(rgb: string): boolean {
  const match = rgb.match(rgbPattern);
  return match !== null && match.slice(1).every((channel) => Number(channel) <= 255);
}

/**
 * Marks a root other than the document one that a legacy palette themes. The stylesheet points
 * the avatar backdrop at that root's own secondary surface, or its tertiary one under a `.dark`
 * ancestor, as the document root's alias does, so the backdrop follows a later mode change.
 */
export const THEME_SCOPE_ATTRIBUTE = 'data-theme-scope';

/**
 * Marks a root that `client/index.html` painted from the cached deployment theme before the
 * bundle ran. The provider drops that copy before it snapshots the root, so a later restore
 * returns to the stylesheet rather than to a theme the server may since have withdrawn.
 */
export const THEME_BOOT_ATTRIBUTE = 'data-theme-boot';

export function clearAppliedTheme(root: HTMLElement = document.documentElement): void {
  themeOwnedProperties.forEach((property) => root.style.removeProperty(property));
  root.removeAttribute('data-theme');
  root.removeAttribute(THEME_DISABLED_ATTRIBUTE);
  root.removeAttribute(THEME_SCOPE_ATTRIBUTE);
  root.removeAttribute(THEME_FIELD_FOCUS_ATTRIBUTE);
  root.removeAttribute(THEME_BOOT_ATTRIBUTE);
}

export function applyResolvedTheme(
  theme: ResolvedThemeDefinition,
  root: HTMLElement = document.documentElement,
): void {
  const { properties, attributes } = describeResolvedTheme(theme);
  properties.forEach(([property, value]) => root.style.setProperty(property, value));
  root.removeAttribute(THEME_DISABLED_ATTRIBUTE);
  root.removeAttribute(THEME_FIELD_FOCUS_ATTRIBUTE);
  Object.entries(attributes).forEach(([name, value]) => root.setAttribute(name, value));
}

/**
 * Backward-compatible adapter for the original partial RGB theme interface.
 * New theme implementations should resolve a ThemeDefinition and use applyResolvedTheme.
 */
export default function applyTheme(
  themeRGB?: IThemeRGB,
  root: HTMLElement = document.documentElement,
  base?: IThemeRGB,
): void {
  if (!themeRGB) {
    return;
  }

  if (root !== root.ownerDocument.documentElement) {
    root.setAttribute(THEME_SCOPE_ATTRIBUTE, '');
  }
  describeThemeColors(themeRGB, base).forEach(([property, value]) => {
    if (!validateRGB(value)) {
      console.error(`Invalid RGB value for ${property}: ${value}`);
      return;
    }
    root.style.setProperty(property, value);
  });
}

import { isThemeRGB } from 'librechat-data-provider';
import type { VisualColorVariable } from 'librechat-data-provider';

export type VisualAppearance = 'light' | 'dark';

/** The resolved theme a visual is handed as CSS custom properties on its `:root`. */
export interface VisualTheme {
  appearance: VisualAppearance;
  variables: Record<string, string>;
}

/**
 * The app theme role each visual color resolves from, typed against the names the prompt teaches.
 * Theme roles hold RGB triplets, so these read the raw roles rather than Tailwind's `--color-*`
 * aliases, which are only emitted when a utility uses them.
 */
const COLOR_ROLES: Record<VisualColorVariable, [role: string, alphaRole?: string]> = {
  '--background': ['--surface-canvas'],
  '--foreground': ['--text-primary'],
  '--muted': ['--surface-tertiary'],
  '--muted-foreground': ['--text-secondary'],
  '--card': ['--surface-secondary'],
  '--card-foreground': ['--text-primary'],
  '--border': ['--border-light', '--border-light-alpha'],
  '--primary': ['--button-primary'],
  '--primary-foreground': ['--text-inverted'],
  '--accent': ['--surface-hover'],
  '--accent-foreground': ['--text-primary'],
  '--success': ['--status-success'],
  '--warning': ['--status-warning'],
  '--destructive': ['--status-error'],
  '--info': ['--status-info'],
  '--chart-1': ['--series-1'],
  '--chart-2': ['--series-2'],
  '--chart-3': ['--series-3'],
  '--chart-4': ['--series-4'],
  '--chart-5': ['--series-5'],
  '--chart-6': ['--series-6'],
  '--chart-7': ['--series-7'],
  '--chart-8': ['--series-8'],
};

/** Roles a theme may omit, with what the app itself falls back to for each. */
const ROLE_FALLBACKS: Record<string, string[]> = {
  '--button-primary': ['--surface-inverted'],
  '--surface-canvas': ['--surface-primary-alt', '--surface-primary'],
};

/** The app's web font is not loaded inside the frame, so system faces follow it. */
const SANS_FALLBACK = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MONO_FALLBACK = 'ui-monospace, Menlo, Consolas, "Liberation Mono", monospace';

function readColor(style: CSSStyleDeclaration, role: string, alphaRole?: string): string {
  const raw =
    [role, ...(ROLE_FALLBACKS[role] ?? [])]
      .map((name) => style.getPropertyValue(name).trim())
      .find(Boolean) ?? '';
  if (!isThemeRGB(raw)) {
    return raw;
  }
  const alpha = Number.parseFloat(alphaRole ? style.getPropertyValue(alphaRole) : '');
  const channels = raw.split(/\s+/).map(Number);
  if (Number.isFinite(alpha) && alpha < 1) {
    channels.push(alpha * 255);
  }
  return `#${channels.map(toHexByte).join('')}`;
}

/**
 * Hex, because the code models write derives translucent fills by appending two hex digits
 * (`color + '66'`), which turns an `rgb()` value into an invalid color that canvas paints black.
 */
function toHexByte(value: number): string {
  return Math.round(Math.min(255, Math.max(0, value)))
    .toString(16)
    .padStart(2, '0');
}

/** A theme's trailing generic family would win before the system faces, so it is dropped. */
const GENERIC_FAMILY = /,?\s*(?:sans-serif|serif|monospace)\s*$/i;

function withFallback(family: string, fallback: string): string {
  const named = family.replace(GENERIC_FAMILY, '').trim();
  return named ? `${named}, ${fallback}` : fallback;
}

export function readVisualTheme(root: HTMLElement = document.documentElement): VisualTheme {
  const style = getComputedStyle(root);
  const variables: Record<string, string> = {};
  for (const [name, [role, alphaRole]] of Object.entries(COLOR_ROLES)) {
    const value = readColor(style, role, alphaRole);
    if (value) {
      variables[name] = value;
    }
  }
  variables['--radius'] = style.getPropertyValue('--theme-radius-lg').trim() || '0.5rem';
  variables['--font-sans'] = withFallback(
    style.getPropertyValue('--theme-font-family').trim(),
    SANS_FALLBACK,
  );
  variables['--font-mono'] = withFallback(
    style.getPropertyValue('--theme-mono-font-family').trim(),
    MONO_FALLBACK,
  );
  return { appearance: root.classList.contains('dark') ? 'dark' : 'light', variables };
}

let snapshot: VisualTheme | null = null;
let snapshotKey = '';
const listeners = new Set<() => void>();
let teardown: (() => void) | null = null;

let refreshFrame: number | null = null;

/** Reads the theme into the cached snapshot, reporting whether it changed. */
function takeSnapshot(): boolean {
  const next = readVisualTheme();
  const key = JSON.stringify(next);
  if (key === snapshotKey) {
    return false;
  }
  snapshot = next;
  snapshotKey = key;
  return true;
}

/**
 * Coalesced to one read per frame: other code writes unrelated properties to the root's inline
 * style (the scrollbar gutter, on every resize), and each read forces a style recalculation.
 */
function refresh(): void {
  if (refreshFrame != null) {
    return;
  }
  refreshFrame = requestAnimationFrame(() => {
    refreshFrame = null;
    if (takeSnapshot()) {
      listeners.forEach((listener) => listener());
    }
  });
}

/**
 * One observer serves every mounted visual. Theme switches toggle the root's `dark` class and
 * custom themes write their roles to its inline style, so attribute changes on the root are the
 * signal; the media query covers the system appearance.
 */
export function subscribeVisualTheme(listener: () => void): () => void {
  listeners.add(listener);
  if (teardown == null) {
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme'],
    });
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    media?.addEventListener?.('change', refresh);
    teardown = () => {
      observer.disconnect();
      media?.removeEventListener?.('change', refresh);
      if (refreshFrame != null) {
        cancelAnimationFrame(refreshFrame);
        refreshFrame = null;
      }
    };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      teardown?.();
      teardown = null;
    }
  };
}

export function getVisualTheme(): VisualTheme {
  if (snapshot == null || listeners.size === 0) {
    takeSnapshot();
  }
  return snapshot as VisualTheme;
}

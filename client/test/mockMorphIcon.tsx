import React from 'react';

export type MockMorphIconProps = {
  icon?: unknown;
  className?: string;
  size?: number | string;
  'data-testid'?: string;
};

/**
 * Build a MorphIcon mock that maps lucide IconNode identity to a stable
 * `data-icon` attribute so tests can assert which icon was selected.
 *
 * Prefer this over a bare `<svg data-testid="morph-icon" />` stub that
 * swallows the `icon` prop and hides inverted ternaries.
 */
export function createMorphIconMock(iconNames: Map<unknown, string> | Array<[unknown, string]>) {
  const names = iconNames instanceof Map ? iconNames : new Map(iconNames);

  return function MockMorphIcon({ icon, className, size, ...rest }: MockMorphIconProps) {
    return (
      <svg
        data-testid="morph-icon"
        data-icon={names.get(icon) ?? 'unknown'}
        data-size={size != null ? String(size) : undefined}
        className={className}
        {...rest}
      />
    );
  };
}

/** Common lucide icon map for copy/check morph sites. */
export function createCopyCheckMorphIconMock() {
  const { Copy, Check } = jest.requireActual('lucide') as Record<string, unknown>;
  return createMorphIconMock([
    [Copy, 'copy'],
    [Check, 'check'],
  ]);
}

/** Mermaid header: exclusive code/preview view toggle. */
export function createMermaidViewMorphIconMock() {
  const { Eye, Code2 } = jest.requireActual('lucide') as Record<string, unknown>;
  return createMorphIconMock([
    [Eye, 'eye'],
    [Code2, 'code-2'],
  ]);
}

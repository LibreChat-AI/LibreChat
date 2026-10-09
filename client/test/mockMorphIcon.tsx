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

/** Pin favorite morph sites. */
export function createPinMorphIconMock() {
  const { Pin, PinOff } = jest.requireActual('lucide') as Record<string, unknown>;
  return createMorphIconMock([
    [Pin, 'pin'],
    [PinOff, 'pin-off'],
  ]);
}

/** In-flight steers: preempt Zap + expand chevrons. */
export function createSteerMorphIconMock() {
  const { Zap, ZapOff, ChevronUp, ChevronDown, Clock } = jest.requireActual('lucide') as Record<
    string,
    unknown
  >;
  return createMorphIconMock([
    [Zap, 'zap'],
    [ZapOff, 'zap-off'],
    [ChevronUp, 'chevron-up'],
    [ChevronDown, 'chevron-down'],
    [Clock, 'clock'],
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

/** Subagent expand/collapse. */
export function createSubagentMorphIconMock() {
  const { Minimize2, Maximize2 } = jest.requireActual('lucide') as Record<string, unknown>;
  return createMorphIconMock([
    [Minimize2, 'minimize-2'],
    [Maximize2, 'maximize-2'],
  ]);
}

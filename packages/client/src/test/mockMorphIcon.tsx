import React from 'react';

export type MockMorphIconProps = {
  icon?: unknown;
  className?: string;
  size?: number | string;
  'data-testid'?: string;
};

/**
 * Build a MorphIcon mock that maps lucide IconNode identity to a stable
 * `data-icon` / optional `data-testid` so tests can assert icon selection.
 */
export function createMorphIconMock(
  iconNames: Map<unknown, string> | Array<[unknown, string]>,
): React.FC<MockMorphIconProps> {
  const names = iconNames instanceof Map ? iconNames : new Map(iconNames);

  return function MockMorphIcon({ icon, className, size }: MockMorphIconProps) {
    const name = names.get(icon) ?? 'morph-icon';
    return (
      <svg
        data-testid={name}
        data-icon={name}
        data-size={size != null ? String(size) : undefined}
        className={className}
      />
    );
  };
}

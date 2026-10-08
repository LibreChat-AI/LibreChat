import { memo } from 'react';
import type { ProviderId } from 'librechat-data-provider';
import type { NamedExoticComponent } from 'react';
import type { JSX } from 'react/jsx-runtime';
import { getProviderIconDef } from './registry';
import { pxToRem } from '../../utils/theme';
import { cn } from '../../utils';

export interface ProviderIconProps {
  provider?: ProviderId | null;
  model?: string | null;
  size?: number;
  className?: string;
}

function ProviderIconComponent({
  provider,
  model,
  size = 20,
  className,
}: ProviderIconProps): JSX.Element {
  const def = getProviderIconDef(provider, model);
  const classes = cn(
    def.mono === true && className == null ? 'text-text-primary' : '',
    def.className,
    className,
  );

  if (def.art.kind === 'component') {
    const { Component } = def.art;
    return (
      <span
        role="img"
        aria-label={def.label}
        style={{ width: pxToRem(size), height: pxToRem(size) }}
        className={cn('inline-flex items-center justify-center', classes)}
      >
        <Component size={size} className={cn(classes, 'h-full w-full')} />
      </span>
    );
  }

  return (
    <img
      src={def.art.src}
      alt={def.label}
      width={size}
      height={size}
      style={{ width: pxToRem(size), height: pxToRem(size) }}
      className={cn('object-contain', classes)}
    />
  );
}

export const ProviderIcon: NamedExoticComponent<ProviderIconProps> = memo(ProviderIconComponent);

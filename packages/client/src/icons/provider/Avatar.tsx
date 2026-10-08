import { memo } from 'react';
import type { NamedExoticComponent, ReactNode } from 'react';
import type { ProviderId } from 'librechat-data-provider';
import type { JSX } from 'react/jsx-runtime';
import { getProviderIconDef } from './registry';
import { pxToRem } from '../../utils/theme';
import { ProviderIcon } from './Icon';
import { cn } from '../../utils';

export interface ProviderAvatarProps {
  provider?: ProviderId | null;
  model?: string | null;
  size?: number;
  className?: string;
  /** Overlay content positioned against the tile, such as an error badge. */
  children?: ReactNode;
}

const artScale = 5 / 9;

function ProviderAvatarComponent({
  provider,
  model,
  size = 30,
  className,
  children,
}: ProviderAvatarProps): JSX.Element {
  const def = getProviderIconDef(provider, model);
  const hasBrand = typeof def.brandColor === 'string' && def.brandColor.length > 0;

  return (
    <span
      title={def.label}
      style={{
        background: hasBrand ? def.brandColor : 'transparent',
        width: pxToRem(size),
        height: pxToRem(size),
        color: hasBrand ? 'var(--provider-foreground, #ffffff)' : undefined,
      }}
      className={cn(
        'relative flex items-center justify-center rounded-sm p-1',
        hasBrand ? undefined : 'text-text-primary',
        className,
      )}
    >
      <ProviderIcon
        provider={provider}
        model={model}
        size={size * artScale}
        className={hasBrand ? '[color:inherit]' : undefined}
      />
      {children}
    </span>
  );
}

export const ProviderAvatar: NamedExoticComponent<ProviderAvatarProps> =
  memo(ProviderAvatarComponent);

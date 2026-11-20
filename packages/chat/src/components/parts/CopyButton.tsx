import React from 'react';
import { Copy } from 'lucide';
import { useLocalize } from '@librechat/client';
import ActionButton from './ActionButton';

interface CopyButtonProps {
  isCopied: boolean;
  iconOnly?: boolean;
  compact?: boolean;
  onClick: () => void;
  tabIndex?: number;
  className?: string;
  label?: string;
  copiedLabel?: string;
  portalElement?: HTMLElement | null;
  disabled?: boolean;
}

const CopyButton: React.ForwardRefExoticComponent<
  CopyButtonProps & React.RefAttributes<HTMLButtonElement>
> = React.forwardRef<HTMLButtonElement, CopyButtonProps>(
  (
    {
      isCopied,
      iconOnly = false,
      compact,
      onClick,
      tabIndex,
      className,
      label,
      copiedLabel,
      portalElement,
      disabled,
    },
    ref,
  ) => {
    const localize = useLocalize();

    return (
      <ActionButton
        ref={ref}
        icon={Copy}
        isActive={isCopied}
        label={label ?? localize('com_ui_copy')}
        activeLabel={copiedLabel ?? localize('com_ui_copied')}
        iconOnly={iconOnly}
        compact={compact}
        onClick={onClick}
        tabIndex={tabIndex}
        className={className}
        portalElement={portalElement}
        disabled={disabled}
      />
    );
  },
);

CopyButton.displayName = 'CopyButton';

export default CopyButton;

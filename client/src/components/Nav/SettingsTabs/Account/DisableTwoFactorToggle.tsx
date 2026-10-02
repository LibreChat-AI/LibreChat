import React from 'react';
import { Button, TooltipAnchor } from '@librechat/client';
import { useLocalize } from '~/hooks';

interface DisableTwoFactorToggleProps {
  enabled: boolean;
  required?: boolean;
  onChange: () => void;
  disabled?: boolean;
  buttonRef?: React.RefObject<HTMLButtonElement>;
}

export const DisableTwoFactorToggle: React.FC<DisableTwoFactorToggleProps> = ({
  enabled,
  required,
  onChange,
  disabled,
  buttonRef,
}) => {
  const localize = useLocalize();
  const isDisableBlockedByPolicy = enabled && required === true;
  const buttonLabel = enabled ? localize('com_ui_2fa_disable') : localize('com_ui_2fa_enable');
  const actionButton = (
    <Button
      ref={buttonRef}
      variant={enabled ? 'destructive' : 'outline'}
      onClick={isDisableBlockedByPolicy ? undefined : onChange}
      disabled={disabled}
      aria-disabled={isDisableBlockedByPolicy || disabled || undefined}
      className={isDisableBlockedByPolicy ? 'cursor-not-allowed' : undefined}
      aria-haspopup="dialog"
      aria-controls="two-factor-authentication-dialog"
    >
      {buttonLabel}
    </Button>
  );

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center space-x-2">
        <span className="text-text-primary text-sm">{localize('com_nav_2fa')}</span>
      </div>
      <div className="flex items-center gap-3">
        {isDisableBlockedByPolicy ? (
          <TooltipAnchor
            description={localize('com_ui_2fa_required')}
            aria-label={`${buttonLabel}: ${localize('com_ui_2fa_required')}`}
            data-testid="required-2fa-disable-control"
            className="inline-flex cursor-not-allowed"
            render={actionButton}
          />
        ) : (
          actionButton
        )}
      </div>
    </div>
  );
};

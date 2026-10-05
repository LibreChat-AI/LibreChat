import React from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useLocalize } from '~/hooks';

type TPasswordToggleButtonProps = {
  // Whether the password is currently shown as plain text
  isVisible: boolean;
  // Called when the user toggles visibility
  onToggle: () => void;
};

// Renders an eye icon button that shows or hides a password input's value.
const PasswordToggleButton: React.FC<TPasswordToggleButtonProps> = ({ isVisible, onToggle }) => {
  const localize = useLocalize();
  const label = isVisible ? localize('com_ui_hide_password') : localize('com_ui_show_password');

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      aria-pressed={isVisible}
      title={label}
      className="absolute end-3 top-1/2 z-20 -translate-y-1/2 rounded-md p-1 text-text-secondary transition-colors duration-200 hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500"
    >
      {isVisible ? <EyeOff className="h-5 w-5" aria-hidden="true" /> : <Eye className="h-5 w-5" aria-hidden="true" />}
    </button>
  );
};

export default PasswordToggleButton;

import { ChevronDown } from 'lucide-react';
import * as Menu from '@ariakit/react/menu';
import { Input, Label, SecretInput, DropdownPopup } from '@librechat/client';
import type { UseFormRegister } from 'react-hook-form';
import type { SearchApiKeyFormData } from '~/hooks/Plugins/useAuthSearchTool';
import type { MenuItemProps } from '~/common';

interface InputConfig {
  placeholder: string;
  type?: 'text' | 'password';
  link?: {
    url: string;
    text: string;
  };
}

interface DropdownOption {
  key: string;
  label: string;
  inputs?: Record<string, InputConfig>;
}

interface InputSectionProps {
  title: string;
  selectedKey: string;
  onSelectionChange: (key: string) => void;
  dropdownOptions: DropdownOption[];
  showDropdown: boolean;
  register: UseFormRegister<SearchApiKeyFormData>;
  dropdownOpen: boolean;
  setDropdownOpen: (open: boolean) => void;
  dropdownKey: string;
}

export default function InputSection({
  title,
  selectedKey,
  onSelectionChange,
  dropdownOptions,
  showDropdown,
  register,
  dropdownOpen,
  setDropdownOpen,
  dropdownKey,
}: InputSectionProps) {
  const selectedOption = dropdownOptions.find((opt) => opt.key === selectedKey);
  const dropdownItems: MenuItemProps[] = dropdownOptions.map((option) => ({
    label: option.label,
    onClick: () => onSelectionChange(option.key),
  }));

  return (
    <div className="mb-6">
      <div className="mb-2 flex items-center justify-between">
        <Label className="w-fit text-base font-medium">{title}</Label>
        {showDropdown ? (
          <DropdownPopup
            menuId={`${dropdownKey}-dropdown`}
            items={dropdownItems}
            isOpen={dropdownOpen}
            setIsOpen={setDropdownOpen}
            trigger={
              <Menu.MenuButton
                onClick={() => setDropdownOpen(!dropdownOpen)}
                className="border-border-light text-text-secondary flex items-center rounded-md border px-3 py-1 text-sm"
              >
                {selectedOption?.label}
                <ChevronDown className="ms-1 h-4 w-4" />
              </Menu.MenuButton>
            }
          />
        ) : (
          <div className="text-text-secondary text-sm">{selectedOption?.label}</div>
        )}
      </div>
      {selectedOption?.inputs &&
        Object.entries(selectedOption.inputs).map(([name, config]) => (
          <div key={name}>
            <div className="relative">
              {config.type === 'password' ? (
                <SecretInput
                  placeholder={config.placeholder}
                  autoComplete="one-time-code"
                  data-lpignore="true"
                  data-1p-ignore="true"
                  controlsOnHover
                  className="mb-2"
                  {...register(name as keyof SearchApiKeyFormData)}
                />
              ) : (
                <Input
                  type="text"
                  placeholder={config.placeholder}
                  autoComplete="off"
                  className="mb-2"
                  {...register(name as keyof SearchApiKeyFormData)}
                />
              )}
            </div>
            {config.link && (
              <div className="text-text-secondary mt-1 text-xs">
                <a
                  href={config.link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-link hover:text-link-hover underline"
                >
                  {config.link.text}
                </a>
              </div>
            )}
          </div>
        ))}
    </div>
  );
}

export type { InputConfig, DropdownOption };

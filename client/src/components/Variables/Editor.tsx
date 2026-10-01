import { useId, useState } from 'react';
import * as Menu from '@ariakit/react/menu';
import { PlusCircle, Maximize2 } from 'lucide-react';
import { specialVariables } from 'librechat-data-provider';
import {
  Label,
  Button,
  OGDialog,
  Textarea,
  DropdownPopup,
  OGDialogClose,
  TooltipAnchor,
  OGDialogTitle,
  OGDialogHeader,
  OGDialogContent,
} from '@librechat/client';
import type { TSpecialVarLabel } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface VariableOption {
  label: TSpecialVarLabel;
  value: string;
}

const variableOptions: VariableOption[] = Object.keys(specialVariables).map((key) => ({
  label: `com_ui_special_var_${key}` as TSpecialVarLabel,
  value: `{{${key}}}`,
}));

interface VariableEditorProps {
  id: string;
  /** Already-localized heading rendered above the field. */
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  inputRef?: React.Ref<HTMLTextAreaElement>;
  placeholder?: string;
  rows?: number;
  required?: boolean;
  invalid?: boolean;
  describedBy?: string;
  className?: string;
  labelClassName?: string;
  containerClassName?: string;
  /** Whether to expose special-variable insertion controls. Defaults to true. */
  showVariables?: boolean;
  /**
   * Ariakit popovers portal to the body by default, which puts them outside a Radix
   * dialog's focus trap. Pass `false` from inside a dialog, and give that dialog
   * `overflow-visible` so the inline menu is not clipped.
   */
  portal?: boolean;
}

/**
 * A textarea for model-facing text with a menu that appends special variables
 * (`{{current_date}}` and friends) and an expand-to-fullscreen editor. Controlled so
 * each caller binds it to its own form field — insertions go through `onChange`, which
 * keeps them visible to react-hook-form's dirty tracking.
 */
export default function VariableEditor({
  id,
  label,
  value,
  onChange,
  onBlur,
  inputRef,
  placeholder,
  rows = 3,
  required,
  invalid,
  describedBy,
  className,
  labelClassName,
  containerClassName,
  showVariables = true,
  portal = true,
}: VariableEditorProps) {
  const menuId = useId();
  const dialogMenuId = useId();
  const localize = useLocalize();

  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isDialogMenuOpen, setIsDialogMenuOpen] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const handleAddVariable = (variableLabel: TSpecialVarLabel, variableValue: string) => {
    const spacer = value.length > 0 ? '\n' : '';
    onChange(value + spacer + localize(variableLabel) + ': ' + variableValue);
    setIsMenuOpen(false);
    setIsDialogMenuOpen(false);
  };

  const variableItems = variableOptions.map((option) => ({
    label: localize(option.label) || option.label,
    onClick: () => handleAddVariable(option.label, option.value),
  }));

  return (
    <div className={cn('flex flex-col', containerClassName)}>
      <div className="mb-1 flex items-center justify-between">
        <Label className={labelClassName} htmlFor={id}>
          {label}
        </Label>
        <div className="flex items-center gap-0.5">
          {showVariables && (
            <DropdownPopup
              portal={portal}
              mountByState={true}
              unmountOnHide={true}
              preserveTabOrder={true}
              isOpen={isMenuOpen}
              setIsOpen={setIsMenuOpen}
              trigger={
                <Menu.MenuButton
                  id={`${id}-variables-menu-button`}
                  aria-label={localize('com_ui_variables')}
                  title={localize('com_ui_variables')}
                  className="text-text-secondary hover:bg-surface-secondary hover:text-text-primary focus-visible:ring-ring-primary inline-flex h-7 w-7 items-center justify-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:outline-hidden"
                >
                  <PlusCircle className="h-4 w-4" strokeWidth={1.75} aria-hidden={true} />
                </Menu.MenuButton>
              }
              items={variableItems}
              menuId={menuId}
              className="pointer-events-auto z-30"
            />
          )}
          <TooltipAnchor
            description={localize('com_ui_expand_editor')}
            render={
              <Button
                type="button"
                variant="ghost"
                onClick={() => setIsDialogOpen(true)}
                aria-label={localize('com_ui_expand_editor')}
                className="text-text-secondary hover:bg-surface-secondary hover:text-text-primary h-7 w-7 p-0"
              >
                <Maximize2 className="h-4 w-4" strokeWidth={1.75} aria-hidden={true} />
              </Button>
            }
          />
        </div>
      </div>
      <Textarea
        id={id}
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        className={className}
        placeholder={placeholder}
        rows={rows}
        aria-label={label}
        aria-required={required}
        aria-invalid={invalid}
        aria-describedby={describedBy}
      />

      <OGDialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <OGDialogContent
          className="flex h-[85vh] max-h-[85vh] w-11/12 max-w-6xl flex-col gap-4 p-6"
          showCloseButton={false}
        >
          <OGDialogHeader className="mb-2 pr-14">
            <OGDialogTitle className="text-left text-2xl font-semibold">{label}</OGDialogTitle>
          </OGDialogHeader>
          <Textarea
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className="min-h-0 flex-1 resize-none text-base leading-relaxed"
            placeholder={placeholder}
            aria-label={label}
          />
          <div
            className={cn('flex items-center', showVariables ? 'justify-between' : 'justify-end')}
          >
            {showVariables && (
              <DropdownPopup
                portal={portal}
                mountByState={true}
                unmountOnHide={true}
                preserveTabOrder={true}
                isOpen={isDialogMenuOpen}
                setIsOpen={setIsDialogMenuOpen}
                trigger={
                  <Menu.MenuButton
                    id={`${id}-variables-menu-button-dialog`}
                    render={
                      <Button type="button" variant="outline" className="gap-1.5">
                        <PlusCircle className="h-4 w-4" strokeWidth={1.75} aria-hidden={true} />
                        {localize('com_ui_variables')}
                      </Button>
                    }
                  />
                }
                items={variableItems}
                menuId={dialogMenuId}
                className="pointer-events-auto z-[200]"
              />
            )}
            <OGDialogClose asChild>
              <Button type="button">{localize('com_ui_done')}</Button>
            </OGDialogClose>
          </div>
        </OGDialogContent>
      </OGDialog>
    </div>
  );
}

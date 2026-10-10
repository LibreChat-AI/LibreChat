import { useRef } from 'react';
import { Save } from 'lucide-react';
import { Portal, Content } from '@radix-ui/react-popover';
import { Button, CrossIcon, useOnClickOutside } from '@librechat/client';
import type { ReactNode } from 'react';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type TOptionsPopoverProps = {
  children: ReactNode;
  visible: boolean;
  saveAsPreset: () => void;
  closePopover: () => void;
  PopoverButtons: ReactNode;
  presetsDisabled: boolean;
};

export default function OptionsPopover({
  children,
  // endpoint,
  visible,
  saveAsPreset,
  closePopover,
  PopoverButtons,
  presetsDisabled,
}: TOptionsPopoverProps) {
  const popoverRef = useRef(null);
  useOnClickOutside(
    popoverRef,
    () => closePopover(),
    ['dialog-template-content', 'shadcn-button', 'advanced-settings'],
    (_target) => {
      const target = _target as Element;
      if (
        target.id === 'presets-button' ||
        (target.parentNode instanceof Element && target.parentNode.id === 'presets-button')
      ) {
        return false;
      }
      const tagName = target.tagName;
      return tagName === 'path' || tagName === 'svg' || tagName === 'circle';
    },
  );

  const localize = useLocalize();
  const cardStyle =
    'shadow-xl rounded-md min-w-[4.6875rem] font-normal bg-surface-secondary border-border-light border text-text-primary';

  if (!visible) {
    return null;
  }

  return (
    <Portal>
      <Content sideOffset={8} align="start" ref={popoverRef} asChild>
        <div className="z-[70] flex w-screen flex-col items-center md:w-full md:px-4">
          <div
            className={cn(
              cardStyle,
              'bg-surface-secondary flex w-full flex-col overflow-hidden rounded-none border-s-0 border-t px-0 pb-2.5 md:rounded-md md:border lg:w-[46rem] lg:max-w-[calc(100vw-2rem)]',
            )}
          >
            <div className="bg-surface-tertiary flex w-full items-center px-2 py-2">
              {presetsDisabled ? null : (
                <Button
                  variant="default"
                  type="button"
                  className="h-8 w-[9.375rem] justify-start rounded-md px-2 text-xs font-normal"
                  onClick={saveAsPreset}
                >
                  <Save className="mr-1 w-[0.875rem]" aria-hidden="true" />
                  {localize('com_endpoint_save_as_preset')}
                </Button>
              )}
              {PopoverButtons}
              <Button
                variant="ghost"
                size="icon"
                type="button"
                className="text-text-primary ml-auto size-8"
                onClick={closePopover}
                aria-label={localize('com_ui_close')}
              >
                <CrossIcon aria-hidden="true" />
              </Button>
            </div>
            <div>{children}</div>
          </div>
        </div>
      </Content>
    </Portal>
  );
}

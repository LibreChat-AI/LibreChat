import React from 'react';
import * as Ariakit from '@ariakit/react';
import type * as t from '~/common';
import { usePopoverZIndex } from './OriginalDialog';
import { cn, disabledInkClasses } from '~/utils';
import './Dropdown.css';

interface DropdownProps {
  keyPrefix?: string;
  trigger: React.ReactNode;
  items: t.MenuItemProps[];
  isOpen: boolean;
  setIsOpen: (isOpen: boolean) => void;
  className?: string;
  iconClassName?: string;
  itemClassName?: string;
  sameWidth?: boolean;
  anchor?: { x: string; y: string };
  gutter?: number;
  modal?: boolean;
  portal?: boolean;
  portalElement?: Ariakit.MenuProps['portalElement'];
  preserveTabOrder?: boolean;
  focusLoop?: boolean;
  menuId: string;
  mountByState?: boolean;
  unmountOnHide?: boolean;
  finalFocus?: React.RefObject<HTMLElement>;
}

type MenuProps = Omit<
  DropdownProps,
  'trigger' | 'isOpen' | 'setIsOpen' | 'focusLoop' | 'mountByState'
> &
  Ariakit.MenuProps;

const DropdownPopup: React.FC<DropdownProps> = ({
  trigger,
  isOpen,
  setIsOpen,
  focusLoop,
  mountByState,
  ...props
}) => {
  const menu = Ariakit.useMenuStore({ open: isOpen, setOpen: setIsOpen, focusLoop });
  if (mountByState) {
    return (
      <Ariakit.MenuProvider store={menu}>
        {trigger}
        {isOpen && <Menu {...props} />}
      </Ariakit.MenuProvider>
    );
  }
  return (
    <Ariakit.MenuProvider store={menu}>
      {trigger}
      <Menu {...props} />
    </Ariakit.MenuProvider>
  );
};

const Menu: React.FC<MenuProps> = ({
  items,
  menuId,
  keyPrefix,
  className,
  iconClassName,
  itemClassName,
  modal,
  portal,
  sameWidth,
  gutter = 8,
  finalFocus,
  unmountOnHide,
  preserveTabOrder,
  style,
  ...props
}) => {
  const menuStore = Ariakit.useMenuStore();
  const menu = Ariakit.useMenuContext();
  const zIndex = usePopoverZIndex();
  return (
    <Ariakit.Menu
      id={menuId}
      modal={modal}
      gutter={gutter}
      portal={portal}
      sameWidth={sameWidth}
      finalFocus={finalFocus}
      unmountOnHide={unmountOnHide}
      preserveTabOrder={preserveTabOrder}
      /* Portaled menus land beside modal OGDialog layers, which set
         `pointer-events: none` on body and re-enable it only on their own
         content. Without this the menu inherits `none` and its items become
         hit-transparent (danny-avila/LibreChat#14487). */
      style={{ zIndex, pointerEvents: 'auto', ...style }}
      className={cn('popover-ui', className)}
      {...props}
    >
      {items
        .filter((item) => item.show !== false)
        .map((item, index) => {
          const { subItems } = item;
          if (item.separate === true) {
            return <Ariakit.MenuSeparator key={index} className="border-border-medium my-1 h-px" />;
          }
          if (subItems && subItems.length > 0) {
            return (
              <Ariakit.MenuProvider
                store={menuStore}
                key={`${keyPrefix ?? ''}${index}-${item.id ?? ''}-provider`}
              >
                <Ariakit.MenuButton
                  className={cn(
                    'group text-text-primary hover:bg-surface-hover focus:bg-surface-hover flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-3.5 text-sm outline-hidden md:px-2.5 md:py-2',
                    disabledInkClasses,
                    itemClassName,
                  )}
                  disabled={item.disabled}
                  id={item.id}
                  render={item.render}
                  ref={item.ref}
                  // hideOnClick={item.hideOnClick}
                >
                  <span className="flex items-center gap-2">
                    {item.icon != null && (
                      <span
                        className={cn('size-theme-icon mr-2', iconClassName)}
                        aria-hidden="true"
                      >
                        {item.icon}
                      </span>
                    )}
                    {item.label}
                  </span>
                  <Ariakit.MenuButtonArrow className="stroke-1 text-base opacity-75" />
                </Ariakit.MenuButton>
                <Menu
                  items={subItems}
                  menuId={`${menuId}-${index}`}
                  key={`${keyPrefix ?? ''}${index}-${item.id ?? ''}`}
                  gutter={12}
                  portal={true}
                />
              </Ariakit.MenuProvider>
            );
          }

          return (
            <Ariakit.MenuItem
              key={`${keyPrefix ?? ''}${index}-${item.id ?? ''}`}
              id={item.id}
              className={cn(
                'group text-text-primary hover:bg-surface-hover focus:bg-surface-hover flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-3.5 text-sm outline-hidden md:px-2.5 md:py-2',
                disabledInkClasses,
                itemClassName,
                item.className,
              )}
              disabled={item.disabled}
              render={item.render}
              ref={item.ref}
              hideOnClick={item.hideOnClick}
              aria-haspopup={item.ariaHasPopup}
              aria-controls={item.ariaControls}
              aria-label={item.ariaLabel}
              aria-checked={item.ariaChecked}
              {...(item.ariaChecked !== undefined ? { role: 'menuitemcheckbox' } : {})}
              onClick={(event) => {
                event.preventDefault();
                if (item.onClick) {
                  item.onClick(event);
                }
                if (item.hideOnClick === false) {
                  return;
                }
                menu?.hide();
              }}
            >
              {item.icon != null && (
                <span className={cn('size-theme-icon mr-2', iconClassName)} aria-hidden="true">
                  {item.icon}
                </span>
              )}
              {item.label}
              {item.kbd != null && (
                <kbd className="text-text-tertiary ml-auto hidden font-sans text-xs group-hover:inline group-focus:inline">
                  ⌘{item.kbd}
                </kbd>
              )}
            </Ariakit.MenuItem>
          );
        })}
    </Ariakit.Menu>
  );
};

export default DropdownPopup;

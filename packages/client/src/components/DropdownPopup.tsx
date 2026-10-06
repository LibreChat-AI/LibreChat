import React, { useEffect } from 'react';
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
  /** Preferred CSS minimum width, capped to the space available to the menu. */
  minWidth?: string;
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
  autoFocusOnShow?: Ariakit.MenuProps['autoFocusOnShow'];
  getAnchorRect?: Ariakit.MenuProps['getAnchorRect'];
}

type MenuProps = Omit<
  DropdownProps,
  'trigger' | 'isOpen' | 'setIsOpen' | 'focusLoop' | 'mountByState'
> &
  Ariakit.MenuProps & {
    /** Closes the outermost menu, so a pick made inside a submenu does not leave its parent open. */
    hideAll?: () => void;
  };

const DropdownPopup: React.FC<DropdownProps> = ({
  trigger,
  isOpen,
  setIsOpen,
  focusLoop,
  mountByState,
  autoFocusOnShow,
  ...props
}) => {
  const menu = Ariakit.useMenuStore({ open: isOpen, setOpen: setIsOpen, focusLoop });
  useEffect(() => {
    if (isOpen && autoFocusOnShow === true) {
      menu.setAutoFocusOnShow(true);
    }
  }, [isOpen, autoFocusOnShow, menu]);
  const hideAll = () => menu.hide();
  if (mountByState) {
    return (
      <Ariakit.MenuProvider store={menu}>
        {trigger}
        {isOpen && <Menu {...props} hideAll={hideAll} autoFocusOnShow={autoFocusOnShow} />}
      </Ariakit.MenuProvider>
    );
  }
  return (
    <Ariakit.MenuProvider store={menu}>
      {trigger}
      <Menu {...props} hideAll={hideAll} autoFocusOnShow={autoFocusOnShow} />
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
  minWidth,
  gutter = 8,
  finalFocus,
  unmountOnHide,
  preserveTabOrder,
  hideAll,
  style,
  ...props
}) => {
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
      style={{
        zIndex,
        minWidth:
          minWidth == null
            ? undefined
            : `min(${minWidth}, calc(100vw - 1rem), var(--popover-available-width, 100vw))`,
        ...style,
      }}
      /* Portaled menus land beside modal OGDialog layers, which set
         `pointer-events: none` on body and re-enable it only on their own
         content. Without `pointer-events-auto` the menu inherits `none` and its
         items become hit-transparent (danny-avila/LibreChat#14487). */
      className={cn('popover-ui pointer-events-auto', className)}
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
              <SubMenuItem
                key={`${keyPrefix ?? ''}${index}-${item.id ?? ''}`}
                item={item}
                subItems={subItems}
                menuId={`${menuId}-${index}`}
                hideAll={hideAll ?? (() => menu?.hide())}
                iconClassName={iconClassName}
                itemClassName={itemClassName}
              />
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
              {...(item.ariaChecked !== undefined
                ? { role: item.ariaRole ?? 'menuitemcheckbox' }
                : {})}
              onClick={(event) => {
                event.preventDefault();
                if (item.onClick) {
                  item.onClick(event);
                }
                if (item.hideOnClick === false) {
                  return;
                }
                if (hideAll) {
                  hideAll();
                  return;
                }
                menu?.hide();
              }}
            >
              {item.icon != null && (
                <span
                  className={cn('size-theme-icon mr-2 [&>svg]:size-full', iconClassName)}
                  aria-hidden="true"
                >
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

/** Owns its store: sharing one across siblings would open every submenu of a menu together. */
const SubMenuItem: React.FC<{
  item: t.MenuItemProps;
  subItems: t.MenuItemProps[];
  menuId: string;
  hideAll: () => void;
  iconClassName?: string;
  itemClassName?: string;
}> = ({ item, subItems, menuId, hideAll, iconClassName, itemClassName }) => {
  const store = Ariakit.useMenuStore();
  /** The parent's `hideAll` closes only its own store: a submenu that stays mounted would be left
   *  open in its portal, so this store is closed with it. */
  const hideSubmenuAndParents = () => {
    store.hide();
    hideAll();
  };
  return (
    <Ariakit.MenuProvider store={store}>
      {/* A submenu trigger is a MenuItem and a MenuButton in one element: as a bare
          MenuButton it is not part of the parent menu's arrow-key order. */}
      <Ariakit.MenuItem
        className={cn(
          'group text-text-primary hover:bg-surface-hover focus:bg-surface-hover flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-3.5 text-sm outline-hidden md:px-2.5 md:py-2',
          disabledInkClasses,
          itemClassName,
        )}
        disabled={item.disabled}
        id={item.id}
        ref={item.ref}
        render={<Ariakit.MenuButton render={item.render} />}
      >
        <span className="flex items-center gap-2">
          {item.icon != null && (
            <span
              className={cn('size-theme-icon mr-2 [&>svg]:size-full', iconClassName)}
              aria-hidden="true"
            >
              {item.icon}
            </span>
          )}
          {item.label}
        </span>
        <Ariakit.MenuButtonArrow className="stroke-1 text-base opacity-75" />
      </Ariakit.MenuItem>
      <Menu
        items={subItems}
        menuId={menuId}
        gutter={20}
        portal={true}
        hideAll={hideSubmenuAndParents}
        style={{ maxHeight: 'min(24rem, var(--popover-available-height, 24rem))' }}
      />
    </Ariakit.MenuProvider>
  );
};

export default DropdownPopup;

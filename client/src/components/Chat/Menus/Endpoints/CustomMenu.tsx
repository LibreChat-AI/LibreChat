import * as React from 'react';
import * as Ariakit from '@ariakit/react';
import { cn } from '~/utils';

export interface CustomMenuProps extends Ariakit.MenuButtonProps<'div'> {
  label?: React.ReactNode;
  values?: Record<string, any>;
  onValuesChange?: (values: Record<string, any>) => void;
  searchValue?: string;
  onSearch?: (value: string) => void;
  combobox?: Ariakit.ComboboxProps['render'];
  comboboxLabel?: string;
  trigger?: Ariakit.MenuButtonProps['render'];
  defaultOpen?: boolean;
}

export const CustomMenu = React.forwardRef<HTMLDivElement, CustomMenuProps>(function CustomMenu(
  {
    label,
    children,
    values,
    onValuesChange,
    searchValue,
    onSearch,
    combobox,
    comboboxLabel,
    trigger,
    defaultOpen,
    ...props
  },
  ref,
) {
  const parent = Ariakit.useMenuContext();
  const searchable = searchValue != null || !!onSearch || !!combobox;

  const menuStore = Ariakit.useMenuStore({
    showTimeout: 100,
    placement: parent ? 'right' : 'left',
    defaultOpen: defaultOpen,
  });
  const isOpen = menuStore.useState('open');
  const rootMenuStateClass = isOpen
    ? 'bg-surface-active-alt hover:bg-surface-active-alt'
    : 'bg-presentation hover:bg-surface-active-alt';
  /** Nested triggers sit on the popover, whose bg-presentation resolves to the
   *  same value as surface-secondary in dark and within 3/255 of it in light,
   *  so highlighting with it leaves keyboard focus invisible. */
  const nestedMenuStateClass = isOpen
    ? 'bg-surface-hover'
    : 'hover:bg-surface-hover data-[active-item]:bg-surface-hover';

  const element = (
    <Ariakit.MenuProvider store={menuStore} values={values} setValues={onValuesChange}>
      <Ariakit.MenuButton
        ref={ref}
        {...props}
        className={cn(
          !parent &&
            'border-border-light text-text-primary rounded-theme-control flex h-10 w-full items-center justify-center gap-2 border px-3 py-2 text-sm',
          parent ? nestedMenuStateClass : rootMenuStateClass,
          props.className,
        )}
        render={parent ? <CustomMenuItem render={trigger} /> : trigger}
      >
        <span className="flex-1">{label}</span>
        <Ariakit.MenuButtonArrow className="stroke-1 text-base opacity-75" />
      </Ariakit.MenuButton>
      <Ariakit.Menu
        open={isOpen}
        portal
        overlap
        unmountOnHide
        gutter={parent ? -4 : 4}
        className={cn(
          parent ? 'animate-popover-left ml-3' : 'animate-popover',
          'z-40 flex max-h-[min(450px,var(--popover-available-height))] w-full outline-hidden!',
          'border-border-light w-[var(--menu-width,auto)] min-w-[300px] flex-col overflow-auto rounded-xl border',
          'bg-presentation text-text-primary text-sm shadow-lg',
          parent ? 'px-0.5 py-0.5' : 'px-3 py-2',
          'max-w-[calc(100vw-4rem)] sm:max-h-[calc(65vh)] sm:max-w-[400px]',
          searchable && 'p-0',
        )}
      >
        <SearchableContext.Provider value={searchable}>
          {searchable ? (
            <>
              <div className="sticky top-0 z-10 bg-inherit p-1">
                <div className="relative">
                  <Ariakit.Combobox
                    autoSelect
                    render={combobox}
                    className={cn(
                      'peer flex h-10 w-full items-center justify-center rounded-lg border-none bg-transparent px-2 text-base',
                      'sm:h-8 sm:text-sm',
                      'focus-visible:ring-text-primary focus:ring-0 focus:outline-hidden focus-visible:ring-2',
                    )}
                  />
                  {comboboxLabel && (
                    <label className="text-text-secondary peer-[:not(:placeholder-shown)]:bg-presentation pointer-events-none absolute top-2.5 left-2.5 text-sm transition-all duration-200 peer-[:not(:placeholder-shown)]:-top-1.5 peer-[:not(:placeholder-shown)]:left-1.5 peer-[:not(:placeholder-shown)]:text-xs sm:top-1.5">
                      {comboboxLabel}
                    </label>
                  )}
                </div>
              </div>
              <Ariakit.ComboboxList className="p-0.5 pt-0">{children}</Ariakit.ComboboxList>
            </>
          ) : (
            children
          )}
        </SearchableContext.Provider>
      </Ariakit.Menu>
    </Ariakit.MenuProvider>
  );

  if (searchable) {
    return (
      <Ariakit.ComboboxProvider
        resetValueOnHide
        includesBaseElement={false}
        value={searchValue}
        setValue={onSearch}
      >
        {element}
      </Ariakit.ComboboxProvider>
    );
  }

  return element;
});

export const CustomMenuSeparator = React.forwardRef<HTMLHRElement, Ariakit.MenuSeparatorProps>(
  function CustomMenuSeparator(props, ref) {
    return (
      <Ariakit.MenuSeparator
        ref={ref}
        {...props}
        className={cn('border-border-light my-0.5 h-0 w-full border-t', props.className)}
      />
    );
  },
);

export interface CustomMenuGroupProps extends Ariakit.MenuGroupProps {
  label?: React.ReactNode;
}

export const CustomMenuGroup = React.forwardRef<HTMLDivElement, CustomMenuGroupProps>(
  function CustomMenuGroup({ label, ...props }, ref) {
    return (
      <Ariakit.MenuGroup ref={ref} {...props} className={cn('', props.className)}>
        {label && (
          <Ariakit.MenuGroupLabel className="cursor-default p-2 text-sm font-medium opacity-60 sm:py-1 sm:text-xs">
            {label}
          </Ariakit.MenuGroupLabel>
        )}
        {props.children}
      </Ariakit.MenuGroup>
    );
  },
);

const SearchableContext = React.createContext(false);

export interface CustomMenuItemProps extends Omit<Ariakit.ComboboxItemProps, 'store'> {
  name?: string;
}

export const CustomMenuItem = React.forwardRef<HTMLDivElement, CustomMenuItemProps>(
  function CustomMenuItem({ name, value, ...props }, ref) {
    const menu = Ariakit.useMenuContext();
    const searchable = React.useContext(SearchableContext);
    const defaultProps: CustomMenuItemProps = {
      ref,
      focusOnHover: true,
      blurOnHoverEnd: false,
      ...props,
      className: cn(
        /** Keyboard focus uses the hover surface: the menu sits on
         *  bg-presentation, which resolves to the same value as
         *  surface-secondary in dark and within 3/255 of it in light, so an
         *  active item styled that way cannot render against its own popover. */
        'relative flex w-full min-w-0 cursor-default scroll-m-1 scroll-mt-[calc(var(--combobox-height,0px)+var(--label-height,4px))] items-center gap-2 rounded-lg px-2 py-1 outline-hidden! hover:bg-surface-hover aria-disabled:opacity-25 aria-selected:bg-surface-hover data-[active-item]:bg-surface-hover data-[active-item]:text-text-primary sm:text-sm before:absolute before:bottom-1 before:left-0 before:top-1 before:w-0.5 before:rounded-full before:bg-transparent data-[active-item]:before:bg-text-primary',
        props.className,
      ),
    };

    const checkable = Ariakit.useStoreState(menu, (state) => {
      if (!name) {
        return false;
      }
      if (value == null) {
        return false;
      }
      return state?.values[name] != null;
    });

    const checked = Ariakit.useStoreState(menu, (state) => {
      if (!name) {
        return false;
      }
      return state?.values[name] === value;
    });

    // If the item is checkable, we render a checkmark icon next to the label.
    if (checkable) {
      defaultProps.children = (
        <React.Fragment>
          <span className="flex-1">{defaultProps.children}</span>
          <Ariakit.MenuItemCheck checked={checked} />
          {searchable && (
            // When an item is displayed in a search menu as a role=option
            // element instead of a role=menuitemradio, we can't depend on the
            // aria-checked attribute. Although NVDA and JAWS announce it
            // accurately, VoiceOver doesn't. TalkBack does announce the checked
            // state, but misleadingly implies that a double tap will change the
            // state, which isn't the case. Therefore, we use a visually hidden
            // element to indicate whether the item is checked or not, ensuring
            // cross-browser/AT compatibility.
            <Ariakit.VisuallyHidden>{checked ? 'checked' : 'not checked'}</Ariakit.VisuallyHidden>
          )}
        </React.Fragment>
      );
    }

    // If the item is not rendered in a search menu (listbox), we can render it
    // as a MenuItem/MenuItemRadio.
    if (!searchable) {
      if (name != null && value != null) {
        const radioProps = { ...defaultProps, name, value, hideOnClick: true };
        return <Ariakit.MenuItemRadio {...radioProps} />;
      }
      return <Ariakit.MenuItem {...defaultProps} />;
    }

    return (
      <Ariakit.ComboboxItem
        {...defaultProps}
        setValueOnClick={false}
        value={checkable ? value : undefined}
        selectValueOnClick={() => {
          if (name == null || value == null) {
            return false;
          }
          // By default, clicking on a ComboboxItem will update the
          // selectedValue state of the combobox. However, since we're sharing
          // state between combobox and menu, we also need to update the menu's
          // values state.
          menu?.setValue(name, value);
          return true;
        }}
        hideOnClick={(event) => {
          // Make sure that clicking on a combobox item that opens a nested
          // menu/dialog does not close the menu.
          const expandable = event.currentTarget.hasAttribute('aria-expanded');
          if (expandable) {
            return false;
          }
          // By default, clicking on a ComboboxItem only closes its own popover.
          // However, since we're in a menu context, we also close all parent
          // menus.
          menu?.hideAll();
          return true;
        }}
      />
    );
  },
);

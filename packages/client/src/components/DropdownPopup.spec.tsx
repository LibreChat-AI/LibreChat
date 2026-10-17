import React, { useRef, useState } from 'react';
import * as Ariakit from '@ariakit/react';
import userEvent from '@testing-library/user-event';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import DropdownPopup from './DropdownPopup';

/** `user-event` resolves its own copy of `@testing-library/dom`, so the wrapper React Testing
 *  Library installs around events never reaches it: Ariakit's animation-frame updates then land
 *  outside `act`. Wrapping each interaction here keeps them inside it. */
const press = (user: ReturnType<typeof userEvent.setup>, keys: string) =>
  act(async () => {
    await user.keyboard(keys);
  });
const click = (user: ReturnType<typeof userEvent.setup>, element: HTMLElement) =>
  act(async () => {
    await user.click(element);
  });

describe('DropdownPopup', () => {
  it('restores pointer events on portaled menus so they stay clickable inside modal dialogs', () => {
    // A modal Radix dialog (OGDialog) sets `pointer-events: none` on body and only
    // re-enables it on its own content. A portaled menu is a body-level sibling and
    // would inherit `none`, making every item hit-transparent (#14487).
    document.body.style.pointerEvents = 'none';

    const { unmount } = render(
      <DropdownPopup
        menuId="portal-click-test-menu"
        isOpen={true}
        setIsOpen={jest.fn()}
        modal={true}
        unmountOnHide={true}
        trigger={
          <Ariakit.MenuButton>
            <span>trigger</span>
          </Ariakit.MenuButton>
        }
        items={[{ label: 'From Local Computer', onClick: jest.fn() }]}
      />,
    );

    const menu = document.getElementById('portal-click-test-menu');
    expect(menu).not.toBeNull();
    expect(menu).toHaveClass('pointer-events-auto');

    unmount();
    document.body.style.pointerEvents = '';
  });
  describe('submenu', () => {
    /** Keyboard, not pointer: jsdom has no layout, so Ariakit's hover tracking between a trigger
     *  and its submenu is meaningless here, while Enter takes the same click path as a pointer pick. */
    const openSubmenu = async (onPick: jest.Mock, hideOnClick?: boolean) => {
      const user = userEvent.setup();
      const onOpenChange = jest.fn();
      function Example() {
        const [open, setOpen] = useState(false);
        return (
          <DropdownPopup
            menuId="submenu-test"
            isOpen={open}
            setIsOpen={(next) => {
              onOpenChange(next);
              setOpen(next);
            }}
            unmountOnHide={true}
            trigger={<Ariakit.MenuButton>Options</Ariakit.MenuButton>}
            items={[
              { label: 'Rename', onClick: jest.fn() },
              {
                label: 'Change project',
                subItems: [{ label: 'Alpha', onClick: onPick, hideOnClick }],
              },
            ]}
          />
        );
      }
      render(<Example />);
      await click(user, screen.getByRole('button', { name: 'Options' }));
      await press(user, '{ArrowDown}{ArrowDown}');
      expect(await screen.findByRole('menuitem', { name: /Change project/ })).toHaveFocus();
      await press(user, '{ArrowRight}');
      const item = await screen.findByRole('menuitem', { name: 'Alpha' });
      await waitFor(() => expect(item).toHaveFocus());
      return { user, item, onOpenChange };
    };

    it('closes the whole menu when a submenu item is picked', async () => {
      const onPick = jest.fn();
      const { user, onOpenChange } = await openSubmenu(onPick);

      await press(user, '{Enter}');

      expect(onPick).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(false));
      await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    });

    it('reaches the submenu trigger with the arrow keys and opens it with ArrowRight', async () => {
      const user = userEvent.setup();
      function Example() {
        const [open, setOpen] = useState(false);
        return (
          <DropdownPopup
            menuId="submenu-keys"
            isOpen={open}
            setIsOpen={setOpen}
            unmountOnHide={true}
            trigger={<Ariakit.MenuButton>Options</Ariakit.MenuButton>}
            items={[
              { label: 'Rename', onClick: jest.fn() },
              { label: 'Change project', subItems: [{ label: 'Alpha', onClick: jest.fn() }] },
              { label: 'Delete', onClick: jest.fn() },
            ]}
          />
        );
      }
      render(<Example />);

      await click(user, screen.getByRole('button', { name: 'Options' }));
      await press(user, '{ArrowDown}');
      expect(await screen.findByRole('menuitem', { name: 'Rename' })).toHaveFocus();
      await press(user, '{ArrowDown}');
      expect(screen.getByRole('menuitem', { name: /Change project/ })).toHaveFocus();

      await press(user, '{ArrowRight}');
      expect(await screen.findByRole('menuitem', { name: 'Alpha' })).toBeInTheDocument();
    });

    it('opens only the submenu whose trigger was activated when a menu has several', async () => {
      const user = userEvent.setup();
      function Example() {
        const [open, setOpen] = useState(false);
        return (
          <DropdownPopup
            menuId="two-submenus"
            isOpen={open}
            setIsOpen={setOpen}
            unmountOnHide={true}
            trigger={<Ariakit.MenuButton>Options</Ariakit.MenuButton>}
            items={[
              { label: 'Bookmarks', subItems: [{ label: 'Work', onClick: jest.fn() }] },
              { label: 'Change project', subItems: [{ label: 'Alpha', onClick: jest.fn() }] },
            ]}
          />
        );
      }
      render(<Example />);

      await click(user, screen.getByRole('button', { name: 'Options' }));
      await press(user, '{ArrowDown}{ArrowDown}');
      expect(await screen.findByRole('menuitem', { name: /Change project/ })).toHaveFocus();
      await press(user, '{ArrowRight}');

      expect(await screen.findByRole('menuitem', { name: 'Alpha' })).toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: 'Work' })).not.toBeInTheDocument();
    });

    it('keeps a custom render on the submenu trigger able to open its submenu', async () => {
      const user = userEvent.setup();
      function Example() {
        const [open, setOpen] = useState(false);
        return (
          <DropdownPopup
            menuId="custom-trigger"
            isOpen={open}
            setIsOpen={setOpen}
            unmountOnHide={true}
            trigger={<Ariakit.MenuButton>Options</Ariakit.MenuButton>}
            items={[
              { label: 'Rename', onClick: jest.fn() },
              {
                label: 'Change project',
                render: (props) => <button {...props} />,
                subItems: [{ label: 'Alpha', onClick: jest.fn() }],
              },
            ]}
          />
        );
      }
      render(<Example />);

      await click(user, screen.getByRole('button', { name: 'Options' }));
      await press(user, '{ArrowDown}{ArrowDown}');
      const trigger = await screen.findByRole('menuitem', { name: /Change project/ });
      expect(trigger.tagName).toBe('BUTTON');
      expect(trigger).toHaveFocus();

      await press(user, '{ArrowRight}');
      expect(await screen.findByRole('menuitem', { name: 'Alpha' })).toBeInTheDocument();
    });

    it('hides the submenu too when a pick closes a menu that stays mounted', async () => {
      const user = userEvent.setup();
      function Example() {
        const [open, setOpen] = useState(false);
        return (
          <DropdownPopup
            menuId="stays-mounted"
            isOpen={open}
            setIsOpen={setOpen}
            trigger={<Ariakit.MenuButton>Options</Ariakit.MenuButton>}
            items={[
              { label: 'Rename', onClick: jest.fn() },
              { label: 'Change project', subItems: [{ label: 'Alpha', onClick: jest.fn() }] },
            ]}
          />
        );
      }
      render(<Example />);

      await click(user, screen.getByRole('button', { name: 'Options' }));
      await press(user, '{ArrowDown}{ArrowDown}');
      expect(await screen.findByRole('menuitem', { name: /Change project/ })).toHaveFocus();
      await press(user, '{ArrowRight}');
      const alpha = await screen.findByRole('menuitem', { name: 'Alpha' });
      await waitFor(() => expect(alpha).toHaveFocus());

      await press(user, '{Enter}');

      await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'Rename' })).toBeNull());
      expect(screen.queryByRole('menuitem', { name: 'Alpha' })).toBeNull();
    });

    it('exposes an item as a radio when it asks for one', async () => {
      const user = userEvent.setup();
      function Example() {
        const [open, setOpen] = useState(false);
        return (
          <DropdownPopup
            menuId="radio-items"
            isOpen={open}
            setIsOpen={setOpen}
            unmountOnHide={true}
            trigger={<Ariakit.MenuButton>Options</Ariakit.MenuButton>}
            items={[
              { label: 'Alpha', ariaChecked: true, ariaRole: 'menuitemradio' },
              { label: 'Beta', ariaChecked: false, ariaRole: 'menuitemradio' },
              { label: 'Pin', ariaChecked: false },
            ]}
          />
        );
      }
      render(<Example />);

      await click(user, screen.getByRole('button', { name: 'Options' }));

      expect(await screen.findByRole('menuitemradio', { name: 'Alpha' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      expect(screen.getByRole('menuitemradio', { name: 'Beta' })).toHaveAttribute(
        'aria-checked',
        'false',
      );
      expect(screen.getByRole('menuitemcheckbox', { name: 'Pin' })).toBeInTheDocument();
    });

    it('keeps the same element for an item with an id when items are added before it', async () => {
      const user = userEvent.setup();
      function Example() {
        const [open, setOpen] = useState(false);
        const [count, setCount] = useState(1);
        const projects = Array.from({ length: count }, (_, i) => ({
          id: `project-${i}`,
          label: `Project ${i}`,
          onClick: jest.fn(),
        }));
        return (
          <DropdownPopup
            menuId="stable-focus"
            isOpen={open}
            setIsOpen={setOpen}
            unmountOnHide={true}
            trigger={<Ariakit.MenuButton>Options</Ariakit.MenuButton>}
            items={[
              ...projects,
              {
                id: 'paging',
                label: 'Load more',
                hideOnClick: false,
                onClick: () => setCount((n) => n + 2),
              },
            ]}
          />
        );
      }
      render(<Example />);

      await click(user, screen.getByRole('button', { name: 'Options' }));
      await press(user, '{ArrowDown}{ArrowDown}');
      const loadMore = await screen.findByRole('menuitem', { name: 'Load more' });
      expect(loadMore).toHaveFocus();

      await press(user, '{Enter}');

      expect(await screen.findByRole('menuitem', { name: 'Project 2' })).toBeInTheDocument();
      /** Keyed by position, the appended project took over this element and the user's next Enter
       *  would have picked it. The element the user activated has to still be the paging control. */
      expect(screen.getByRole('menuitem', { name: 'Load more' })).toBe(loadMore);
      expect(loadMore.isConnected).toBe(true);
    });

    it('keeps the menu open when a submenu item opts out of hiding', async () => {
      const onPick = jest.fn();
      const { user, onOpenChange } = await openSubmenu(onPick, false);

      await press(user, '{Enter}');

      expect(onPick).toHaveBeenCalledTimes(1);
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
      expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
    });
  });

  it('focuses an externally opened menu', async () => {
    function Example() {
      const [open, setOpen] = useState(false);
      const trigger = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open externally</button>
          <DropdownPopup
            menuId="external-menu"
            isOpen={open}
            setIsOpen={setOpen}
            autoFocusOnShow={true}
            unmountOnHide={true}
            finalFocus={trigger}
            trigger={<Ariakit.MenuButton ref={trigger}>Options</Ariakit.MenuButton>}
            items={[{ label: 'Rename', onClick: jest.fn() }]}
          />
        </>
      );
    }
    render(<Example />);
    fireEvent.click(screen.getByRole('button', { name: 'Open externally' }));
    const menu = await screen.findByRole('menu');
    await waitFor(() => expect(menu).toHaveFocus());
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });
});

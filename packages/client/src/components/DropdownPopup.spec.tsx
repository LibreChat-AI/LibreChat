import React, { useRef, useState } from 'react';
import * as Ariakit from '@ariakit/react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DropdownPopup from './DropdownPopup';

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

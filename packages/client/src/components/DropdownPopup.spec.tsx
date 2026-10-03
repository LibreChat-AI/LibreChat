import React from 'react';
import * as Ariakit from '@ariakit/react';
import { render } from '@testing-library/react';
import DropdownPopup from './DropdownPopup';

describe('DropdownPopup', () => {
  it('restores pointer events on portaled menus so they stay clickable inside modal dialogs', () => {
    // A modal Radix dialog (OGDialog) sets `pointer-events: none` on body and only
    // re-enables it on its own content. A portaled menu is a body-level sibling and
    // would inherit `none`, making every item hit-transparent (#14487).
    document.body.style.pointerEvents = 'none';

    render(
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

    document.body.style.pointerEvents = '';
  });
});

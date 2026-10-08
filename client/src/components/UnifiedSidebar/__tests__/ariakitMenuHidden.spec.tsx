import * as Ariakit from '@ariakit/react';
import { render, screen, fireEvent } from '@testing-library/react';

/**
 * The drawer's Escape guard stands down only for menus that are actually open,
 * which relies on Ariakit marking a closed menu `hidden` rather than unmounting
 * it. That is the behaviour of the account menu, which has no `unmountOnHide`
 * and would otherwise suppress Escape for the drawer permanently.
 */
function Fixture() {
  return (
    <Ariakit.MenuProvider>
      <Ariakit.MenuButton data-testid="trigger" aria-label="open" />
      <Ariakit.Menu data-testid="menu">
        <Ariakit.MenuItem aria-label="item" />
      </Ariakit.Menu>
    </Ariakit.MenuProvider>
  );
}

const openMenu = () => document.querySelector('[role="menu"]:not([hidden])');

describe('Ariakit menu visibility contract', () => {
  it('keeps a closed menu mounted but hidden', () => {
    render(<Fixture />);

    expect(screen.getByTestId('menu')).toBeInTheDocument();
    expect(screen.getByTestId('menu')).toHaveAttribute('hidden');
    expect(openMenu()).toBeNull();
  });

  it('drops the hidden attribute once opened', () => {
    render(<Fixture />);

    fireEvent.click(screen.getByTestId('trigger'));

    expect(screen.getByTestId('menu')).not.toHaveAttribute('hidden');
    expect(openMenu()).not.toBeNull();
  });
});

import React from 'react';
import * as Ariakit from '@ariakit/react';
import userEvent from '@testing-library/user-event';
import { act, render, screen } from '@testing-library/react';
import DropdownPopup from './DropdownPopup';

let mockRemScale = 1;
jest.mock('~/hooks/useRemScale', () => ({
  __esModule: true,
  default: () => mockRemScale,
}));

/** jsdom has no layout, so the offset Ariakit computes cannot be measured: the gutter each menu
 *  receives is recorded instead. */
const mockGutters = new Map<string, number | undefined>();
jest.mock('@ariakit/react', () => {
  const actual = jest.requireActual('@ariakit/react');
  const ReactActual = jest.requireActual('react');
  const Menu = ReactActual.forwardRef(
    (props: { id?: string; gutter?: number }, ref: React.Ref<HTMLDivElement>) => {
      if (props.id != null) {
        mockGutters.set(props.id, props.gutter);
      }
      return ReactActual.createElement(actual.Menu, { ...props, ref });
    },
  );
  return { ...actual, Menu };
});

beforeEach(() => {
  mockRemScale = 1;
  mockGutters.clear();
});

const renderWithSubmenu = async () => {
  const user = userEvent.setup();
  render(
    <DropdownPopup
      menuId="gutter-test"
      isOpen={true}
      setIsOpen={jest.fn()}
      trigger={<Ariakit.MenuButton>trigger</Ariakit.MenuButton>}
      items={[{ label: 'Move', subItems: [{ label: 'Alpha', onClick: jest.fn() }] }]}
    />,
  );
  await act(async () => {
    await user.click(screen.getByRole('menuitem', { name: 'Move' }));
  });
};

describe('DropdownPopup submenu gutter', () => {
  it('keeps the submenu gutter at 14px at the default UI scale', async () => {
    await renderWithSubmenu();
    expect(mockGutters.get('gutter-test-0')).toBe(14);
  });

  it('scales the submenu gutter with the UI scale so the parent padding cannot outgrow it', async () => {
    mockRemScale = 1.5;
    await renderWithSubmenu();
    expect(mockGutters.get('gutter-test-0')).toBe(21);
  });
});

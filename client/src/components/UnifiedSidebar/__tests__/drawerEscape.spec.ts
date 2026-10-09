/**
 * The drawer collapses on Escape, but menus opened from inside it portal out,
 * so their Escape reaches the same document listener. This pins which menus
 * count as "open" — the account menu stays mounted and merely `hidden` when
 * closed, so matching on presence alone would suppress Escape permanently.
 */
const OPEN_MENU = '[role="menu"]:not([hidden])';

const addMenu = ({ hidden }: { hidden: boolean }) => {
  const menu = document.createElement('div');
  menu.setAttribute('role', 'menu');
  if (hidden) {
    menu.setAttribute('hidden', '');
  }
  document.body.appendChild(menu);
  return menu;
};

describe('drawer Escape guard', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('stands down while a menu is open', () => {
    addMenu({ hidden: false });

    expect(document.querySelector(OPEN_MENU)).not.toBeNull();
  });

  it('still collapses the drawer when a closed menu lingers in the DOM', () => {
    addMenu({ hidden: true });

    expect(document.querySelector(OPEN_MENU)).toBeNull();
  });

  it('collapses the drawer when no menu exists at all', () => {
    expect(document.querySelector(OPEN_MENU)).toBeNull();
  });

  it('stands down when an open menu sits alongside a closed one', () => {
    addMenu({ hidden: true });
    addMenu({ hidden: false });

    expect(document.querySelector(OPEN_MENU)).not.toBeNull();
  });
});

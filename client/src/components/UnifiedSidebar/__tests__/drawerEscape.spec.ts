import { MOBILE_DRAWER_ID } from '../constants';
import { shouldCloseSidebar } from '../escape';

const addMenu = ({ hidden, role = 'menu' }: { hidden: boolean; role?: string }) => {
  const menu = document.createElement('div');
  menu.setAttribute('role', role);
  if (hidden) {
    menu.setAttribute('hidden', '');
  }
  document.body.appendChild(menu);
  return menu;
};
const escape = () =>
  new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });

describe('drawer Escape guard', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it.each(['menu', 'listbox', 'dialog'])('stands down while a %s is open', (role) => {
    addMenu({ hidden: false, role });

    expect(shouldCloseSidebar(escape(), document)).toBe(false);
  });

  it('still collapses the drawer when a closed menu lingers in the DOM', () => {
    addMenu({ hidden: true });

    expect(shouldCloseSidebar(escape(), document)).toBe(true);
  });

  it('collapses the drawer when no menu exists at all', () => {
    expect(shouldCloseSidebar(escape(), document)).toBe(true);
  });

  it('closes the drawer dialog itself while preserving nested dialog ownership', () => {
    const drawer = addMenu({ hidden: false, role: 'dialog' });
    drawer.id = MOBILE_DRAWER_ID;
    const button = document.createElement('button');
    drawer.appendChild(button);
    const decisions: boolean[] = [];
    const listener = (event: KeyboardEvent) => decisions.push(shouldCloseSidebar(event, document));
    document.addEventListener('keydown', listener);
    try {
      button.dispatchEvent(escape());
      drawer.appendChild(addMenu({ hidden: false, role: 'dialog' }));
      button.dispatchEvent(escape());
      expect(decisions).toEqual([true, false]);
    } finally {
      document.removeEventListener('keydown', listener);
    }
  });

  it('stands down when an open menu sits alongside a closed one', () => {
    addMenu({ hidden: true });
    addMenu({ hidden: false });

    expect(shouldCloseSidebar(escape(), document)).toBe(false);
  });

  it('ignores a listbox inside a hidden popover', () => {
    const popover = addMenu({ hidden: true, role: 'dialog' });
    const listbox = addMenu({ hidden: false, role: 'listbox' });
    popover.appendChild(listbox);
    expect(shouldCloseSidebar(escape(), document)).toBe(true);
  });

  it('does not consume a prevented Escape or a different key', () => {
    const event = escape();
    event.preventDefault();
    expect(shouldCloseSidebar(event, document)).toBe(false);
    expect(shouldCloseSidebar(new KeyboardEvent('keydown', { key: 'Enter' }), document)).toBe(
      false,
    );
  });

  it('lets an unmounting overlay consume the first Escape and closes on the next', () => {
    const popover = addMenu({ hidden: false, role: 'dialog' });
    const input = document.createElement('input');
    popover.appendChild(input);
    input.addEventListener('keydown', () => popover.remove());
    const decisions: boolean[] = [];
    const listener = (event: KeyboardEvent) => decisions.push(shouldCloseSidebar(event, document));
    document.addEventListener('keydown', listener);
    try {
      input.dispatchEvent(escape());
      document.body.dispatchEvent(escape());
      expect(decisions).toEqual([false, true]);
    } finally {
      document.removeEventListener('keydown', listener);
    }
  });
});

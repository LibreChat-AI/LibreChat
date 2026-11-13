import {
  GREETING_SETTLED,
  announceGreetingSettled,
  canClaimWelcomeFocus,
  onGreetingSettled,
} from '../welcome';

describe('welcome greeting cue', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('delivers the announced coordinates to a listener', () => {
    const seen: Array<{ clientX: number; clientY: number }> = [];
    const stop = onGreetingSettled((settled) => seen.push(settled));

    announceGreetingSettled(1299.5, 309);

    expect(seen).toEqual([{ clientX: 1299.5, clientY: 309 }]);
    stop();
  });

  it('stops delivering once unsubscribed', () => {
    const listener = jest.fn();
    onGreetingSettled(listener)();

    announceGreetingSettled(10, 20);

    expect(listener).not.toHaveBeenCalled();
  });

  it('ignores an event carrying no detail', () => {
    const listener = jest.fn();
    const stop = onGreetingSettled(listener);

    window.dispatchEvent(new Event(GREETING_SETTLED));

    expect(listener).not.toHaveBeenCalled();
    stop();
  });
});

describe('canClaimWelcomeFocus', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('claims the caret while nothing holds focus', () => {
    expect(canClaimWelcomeFocus()).toBe(true);
  });

  /** The cue lands seconds after the screen mounts, so someone may already be
   * typing by then. */
  it('declines when another element already has focus', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    expect(document.activeElement).toBe(input);
    expect(canClaimWelcomeFocus()).toBe(false);
  });

  /** #15624: refocusing the composer behind an open menu made the textarea the
   * menu's disclosure, and the menu could never close. */
  it('declines while a rendered popup is open', () => {
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.getBoundingClientRect = () => ({ width: 180, height: 220 }) as DOMRect;
    document.body.appendChild(menu);

    expect(canClaimWelcomeFocus()).toBe(false);
  });

  /** The composer keeps dialog-role nodes mounted and zero-sized, so presence
   * alone must not be read as an open popup, or the composer would never claim focus. */
  it('ignores a popup node that renders nothing', () => {
    const dormant = document.createElement('div');
    dormant.setAttribute('role', 'dialog');
    dormant.getBoundingClientRect = () => ({ width: 0, height: 0 }) as DOMRect;
    document.body.appendChild(dormant);

    expect(canClaimWelcomeFocus()).toBe(true);
  });

  it('ignores a popup hidden by style', () => {
    const hidden = document.createElement('div');
    hidden.setAttribute('role', 'listbox');
    hidden.style.display = 'none';
    hidden.getBoundingClientRect = () => ({ width: 120, height: 90 }) as DOMRect;
    document.body.appendChild(hidden);

    expect(canClaimWelcomeFocus()).toBe(true);
  });
});

import { act, fireEvent } from '@testing-library/react';

/**
 * Ariakit's select popover registers and positions itself an effect after the
 * event that triggered it, so a bare `render` or `fireEvent.click` leaves that
 * update to land after the test body returns — which React reports as an
 * unacted update. These helpers settle it inside `act` instead.
 */
export const flushDropdownEffects = (): Promise<void> => act(async () => {});

export const clickDropdown = async (element: HTMLElement): Promise<void> => {
  await act(async () => {
    fireEvent.click(element);
  });
};

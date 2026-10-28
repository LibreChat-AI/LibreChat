import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import { ChipModes } from '../Bar';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

describe('ChipModes', () => {
  it('keeps a portaled menu choice from reaching the composer', async () => {
    const user = userEvent.setup();
    const onComposerClick = jest.fn();
    const onSelect = jest.fn();
    render(
      <div onClick={onComposerClick}>
        <ChipModes modes={[{ id: 'high', label: 'High', active: false, onSelect }]} />
      </div>,
    );

    await user.click(screen.getByRole('button', { name: 'com_ui_mode' }));
    onComposerClick.mockClear();
    await user.click(screen.getByRole('menuitemradio', { name: 'High' }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onComposerClick).not.toHaveBeenCalled();
  });
});

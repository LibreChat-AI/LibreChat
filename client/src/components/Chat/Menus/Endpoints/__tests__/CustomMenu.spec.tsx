import React from 'react';
import userEvent from '@testing-library/user-event';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CustomMenu, CustomMenuItem } from '../CustomMenu';

jest.mock('~/utils', () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }));

const labels = { trigger: 'Choices', model: 'Model' };

it.each(['pointer', 'keyboard'])('reports menu opening by %s and closing', async (interaction) => {
  const onOpenChange = jest.fn();
  render(
    <CustomMenu trigger={<button>{labels.trigger}</button>} onOpenChange={onOpenChange}>
      <CustomMenuItem>{labels.model}</CustomMenuItem>
    </CustomMenu>,
  );
  expect(onOpenChange).not.toHaveBeenCalled();
  const trigger = screen.getByRole('button', { name: 'Choices' });
  if (interaction === 'keyboard') {
    trigger.focus();
    await userEvent.keyboard('{Enter}');
  } else {
    await userEvent.click(trigger);
  }
  const menu = await screen.findByRole('menu');
  expect(onOpenChange).toHaveBeenLastCalledWith(true);
  fireEvent.keyDown(menu, { key: 'Escape', code: 'Escape' });
  await waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(false));
});

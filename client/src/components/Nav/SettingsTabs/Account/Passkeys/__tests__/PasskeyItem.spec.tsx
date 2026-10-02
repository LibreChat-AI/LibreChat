import React from 'react';
import userEvent from '@testing-library/user-event';
import type { TPasskey } from 'librechat-data-provider';
import type { PasskeyRemovalResult } from '../PasskeyItem';
import { fireEvent, render, screen, waitFor } from 'test/layout-test-utils';
import PasskeyItem from '../PasskeyItem';

const passkey: TPasskey = {
  id: 'p1',
  name: 'Work laptop',
  deviceType: 'multiDevice',
  backedUp: false,
  transports: ['internal'],
  createdAt: '2026-01-01T00:00:00.000Z',
  lastUsedAt: null,
};

type Overrides = {
  requiresPassword?: boolean;
  onDelete?: jest.Mock<Promise<PasskeyRemovalResult>>;
  isRenaming?: boolean;
};

function setup({ requiresPassword = true, onDelete, isRenaming = false }: Overrides = {}) {
  const deleteMock = onDelete ?? jest.fn().mockResolvedValue('removed');
  render(
    <PasskeyItem
      passkey={passkey}
      isRenaming={isRenaming}
      isBusy={false}
      requiresPassword={requiresPassword}
      onStartRename={jest.fn()}
      onRename={jest.fn()}
      onDelete={deleteMock}
    />,
  );
  return { deleteMock, user: userEvent.setup() };
}

const openConfirmation = async (user: ReturnType<typeof userEvent.setup>) => {
  const removeButton = screen.getByRole('button', { name: 'Remove passkey' });
  expect(removeButton).toHaveClass('hover:bg-surface-hover');
  expect(removeButton).not.toHaveClass('bg-surface-destructive');
  await user.click(removeButton);
  expect(await screen.findByRole('alertdialog', { name: /Remove/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass('bg-surface-destructive');
};

describe('PasskeyItem rename controls', () => {
  it('matches the input height with square save and cancel buttons', () => {
    setup({ isRenaming: true });
    const input = screen.getByRole('textbox', { name: 'Passkey name' });
    const saveButton = screen.getByRole('button', { name: 'Save' });
    const cancelButton = screen.getByRole('button', { name: 'Cancel' });

    expect(input).toHaveClass('h-10');
    expect(input.parentElement?.parentElement).toHaveClass('py-2');
    expect(saveButton).toHaveClass('size-10');
    expect(cancelButton).toHaveClass('size-10');
    expect(cancelButton).toHaveClass('bg-surface-secondary');
  });

  it.each(['Save', 'Cancel'])('labels the %s control with a tooltip', async (label) => {
    setup({ isRenaming: true });
    const button = screen.getByRole('button', { name: label });

    fireEvent.mouseEnter(button);
    fireEvent.mouseMove(button, { screenX: 1 });

    expect(await screen.findByRole('tooltip', {}, { timeout: 3000 })).toHaveTextContent(label);
  });
});

describe('PasskeyItem removal step-up', () => {
  it('asks for the password before removing the credential', async () => {
    const { deleteMock, user } = setup();
    await openConfirmation(user);

    const field = screen.getByLabelText('Confirm your password');
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Show secret' })).toBeInTheDocument();
    expect(
      screen.queryByText(
        'Removing a passkey takes away a way to sign in, so we need your password first.',
      ),
    ).not.toBeInTheDocument();

    await user.type(field, 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('p1', 'correct horse'));
  });

  it('keeps the delete action unavailable until a password is typed', async () => {
    const { deleteMock, user } = setup();
    await openConfirmation(user);

    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
    await user.type(screen.getByLabelText('Confirm your password'), 'x');
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('reports a rejected password inline and returns focus to the field', async () => {
    const onDelete = jest.fn().mockResolvedValue('incorrect-password');
    const { user } = setup({ onDelete });
    await openConfirmation(user);

    const field = screen.getByLabelText('Confirm your password');
    expect(field).toHaveAttribute('aria-invalid', 'false');

    await user.type(field, 'wrong');
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Incorrect password. Please try again.');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAttribute('aria-describedby', alert.id);
    await waitFor(() => expect(field).toHaveFocus());
  });

  it('does not ask an account without a local password for one', async () => {
    const { deleteMock, user } = setup({ requiresPassword: false });
    await openConfirmation(user);

    expect(screen.queryByLabelText('Confirm your password')).not.toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Delete' });
    expect(confirm).toBeEnabled();

    await user.click(confirm);
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('p1', ''));
  });

  /**
   * The waiver is keyed on the password hash server-side, which the client cannot see,
   * so an SSO account that kept its old hash is only discovered by being refused.
   */
  it('reveals the password field when the server refuses a passwordless removal', async () => {
    const deleteMock = jest
      .fn<Promise<PasskeyRemovalResult>, [string, string]>()
      .mockResolvedValueOnce('incorrect-password')
      .mockResolvedValueOnce('removed');
    const { user } = setup({ requiresPassword: false, onDelete: deleteMock });
    await openConfirmation(user);

    expect(screen.queryByLabelText('Confirm your password')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    const field = await screen.findByLabelText('Confirm your password');
    await user.type(field, 'hunter2');
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteMock).toHaveBeenLastCalledWith('p1', 'hunter2'));
  });

  it('cancels back to the row and returns focus to the remove control', async () => {
    const { deleteMock, user } = setup();
    await openConfirmation(user);

    await user.type(screen.getByLabelText('Confirm your password'), 'typed');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(deleteMock).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Remove passkey' })).toHaveFocus(),
    );
  });

  it('clears a typed password when the confirmation is reopened', async () => {
    const { user } = setup();
    await openConfirmation(user);
    await user.type(screen.getByLabelText('Confirm your password'), 'typed');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await openConfirmation(user);

    expect(screen.getByLabelText('Confirm your password')).toHaveValue('');
  });
});

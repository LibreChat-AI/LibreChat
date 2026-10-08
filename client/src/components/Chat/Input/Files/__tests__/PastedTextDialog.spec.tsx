import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { PastedTextEdit } from '~/hooks/Files/usePastedTextEdit';
import type { ExtendedFile } from '~/common';
import PastedTextDialog from '../PastedTextDialog';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const pastedFile = (file_id: string): ExtendedFile => ({
  file_id,
  filename: 'pasted-text.txt',
  type: 'text/plain',
  progress: 1,
  size: 4000,
});

const edit = (file_id: string, text: string): PastedTextEdit => ({
  file: pastedFile(file_id),
  text,
  conversationId: 'conversation-a',
  draftToken: Symbol('new-conversation-draft'),
});

describe('PastedTextDialog', () => {
  const renderDialog = (over: Partial<React.ComponentProps<typeof PastedTextDialog>> = {}) => {
    const props = {
      edit: edit('pasted-file', 'the original paste'),
      onClose: jest.fn(),
      onSave: jest.fn(),
      ...over,
    };
    return { ...props, ...render(<PastedTextDialog {...props} />) };
  };

  it('stays closed with nothing being edited', () => {
    renderDialog({ edit: null });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens with the resolved paste already in the field', () => {
    renderDialog();

    expect(screen.getByRole('textbox')).toHaveValue('the original paste');
  });

  it('saves what the user typed, not what was pasted', async () => {
    const { onSave } = renderDialog();

    const field = screen.getByRole('textbox');
    await userEvent.clear(field);
    await userEvent.type(field, 'corrected');
    await userEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));

    expect(onSave).toHaveBeenCalledWith('corrected');
  });

  it('refuses to write an empty attachment', async () => {
    renderDialog();

    await userEvent.clear(screen.getByRole('textbox'));

    expect(screen.getByRole('button', { name: 'com_ui_save' })).toBeDisabled();
  });

  it('leaves returning the paste to the composer to the chip', () => {
    renderDialog();

    expect(
      screen.queryByRole('button', { name: 'com_ui_pasted_text_move_inline' }),
    ).not.toBeInTheDocument();
  });

  it('discards an abandoned edit when a different chip is opened', async () => {
    const { rerender, onSave } = renderDialog();

    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.type(screen.getByRole('textbox'), 'abandoned');
    rerender(
      <PastedTextDialog
        edit={edit('second-file', 'the second paste')}
        onClose={jest.fn()}
        onSave={onSave}
      />,
    );

    expect(screen.getByRole('textbox')).toHaveValue('the second paste');
  });

  it('reopening the same chip starts from its stored text again', async () => {
    const { rerender } = renderDialog();

    await userEvent.type(screen.getByRole('textbox'), ' plus more');
    rerender(<PastedTextDialog edit={null} onClose={jest.fn()} onSave={jest.fn()} />);
    rerender(
      <PastedTextDialog
        edit={edit('pasted-file', 'the original paste')}
        onClose={jest.fn()}
        onSave={jest.fn()}
      />,
    );

    expect(screen.getByRole('textbox')).toHaveValue('the original paste');
  });
});

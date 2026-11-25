import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { OGDialog, OGDialogContent } from '../OriginalDialog';
import Dropdown from '../Dropdown';

/**
 * A dialog traps focus inside its own DOM and hides every other body child from
 * assistive technology. A select list portaled out of it could be neither reached
 * by keyboard nor read, so inside a dialog `Dropdown` renders the list in place:
 * the list is exposed, and the keyboard can move through it and pick an option.
 */
it('lets the keyboard pick a select option inside a dialog', async () => {
  const onChange = jest.fn();
  render(
    <OGDialog open>
      <OGDialogContent>
        <Dropdown
          value="ask"
          onChange={onChange}
          ariaLabel="Execution environment"
          options={[
            { value: 'ask', label: 'Ask before changes' },
            { value: 'accept', label: 'Accept edits' },
          ]}
        />
      </OGDialogContent>
    </OGDialog>,
  );

  const trigger = screen.getByRole('combobox', { name: 'Execution environment' });
  await act(async () => {
    trigger.focus();
    fireEvent.click(trigger);
  });
  const listbox = await screen.findByRole('listbox');
  expect(screen.getByRole('dialog')).toContainElement(listbox);
  expect(document.activeElement).toBe(listbox);

  await act(async () => {
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
  });
  const active = listbox.getAttribute('aria-activedescendant');
  expect(active).toBe(screen.getByRole('option', { name: 'Accept edits' }).id);

  await act(async () => {
    fireEvent.keyDown(listbox, { key: 'Enter' });
  });
  expect(onChange).toHaveBeenCalledWith('accept');
});

import '@testing-library/jest-dom';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { DialogLayer } from '../OriginalDialog';
import Dropdown from '../Dropdown';

/**
 * Escape in an open Dropdown list belongs to the list. Containers that close on Escape, such as
 * a Headless UI dialog, skip an Escape something already handled, so the list closing must mark
 * the keystroke handled or one press closes the list and its dialog together.
 */
function SettingsLikeDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onClose={onClose}>
      <DialogPanel>
        <DialogTitle>Settings</DialogTitle>
        <DialogLayer>
          <Dropdown
            value="system"
            onChange={() => undefined}
            ariaLabel="Clock format"
            options={[
              { value: 'system', label: 'System' },
              { value: '12h', label: '12-hour' },
            ]}
          />
        </DialogLayer>
      </DialogPanel>
    </Dialog>
  );
}

it('closes only the list on Escape, leaving the dialog it sits in open', async () => {
  const onClose = jest.fn();
  render(<SettingsLikeDialog onClose={onClose} />);

  await act(async () => {
    fireEvent.click(screen.getByRole('combobox', { name: /Clock format/ }));
  });
  const listbox = await screen.findByRole('listbox');

  await act(async () => {
    fireEvent.keyDown(listbox, { key: 'Escape' });
  });

  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();
});

it('still lets Escape close the dialog once the list is closed', async () => {
  const onClose = jest.fn();
  render(<SettingsLikeDialog onClose={onClose} />);

  await act(async () => {
    fireEvent.keyDown(screen.getByRole('combobox', { name: /Clock format/ }), { key: 'Escape' });
  });

  expect(onClose).toHaveBeenCalledTimes(1);
});

it('lets Escape close the dialog right after an option is picked', async () => {
  const onClose = jest.fn();
  render(<SettingsLikeDialog onClose={onClose} />);

  await act(async () => {
    fireEvent.click(screen.getByRole('combobox', { name: /Clock format/ }));
  });
  await act(async () => {
    fireEvent.click(await screen.findByRole('option', { name: '12-hour' }));
  });
  /** The list is closing, not open: the Escape is the dialog's. */
  await act(async () => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
  });

  expect(onClose).toHaveBeenCalledTimes(1);
});

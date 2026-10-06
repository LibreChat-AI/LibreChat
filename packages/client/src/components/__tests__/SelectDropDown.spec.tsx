import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { FormEvent } from 'react';
import SelectDropDown from '../SelectDropDown';

const OPTIONS = [
  { label: 'Loading...', value: '' },
  { label: 'Second', value: 'second' },
];

async function openList() {
  await userEvent.setup().click(screen.getByTestId('select-dropdown-button'));
}

describe('SelectDropDown', () => {
  it.each(['{Enter}', ' '])(
    'reopens an empty picker with %s after clearing its value',
    async (key) => {
      function Picker() {
        const [value, setValue] = useState<(typeof OPTIONS)[number] | null>(OPTIONS[1]);
        return (
          <SelectDropDown
            value={value}
            setValue={(next) => setValue(next as typeof value)}
            availableValues={OPTIONS}
            placeholder="Create Assistant"
            renderOption={() => <span>Create Assistant</span>}
            showLabel={false}
            emptyTitle={true}
          />
        );
      }
      const user = userEvent.setup();
      const onSubmit = jest.fn((event: FormEvent<HTMLFormElement>) => event.preventDefault());
      render(
        <form onSubmit={onSubmit}>
          <Picker />
        </form>,
      );
      const button = screen.getByTestId('select-dropdown-button');
      await act(async () => {
        await user.click(button);
      });
      await act(async () => {
        await user.click(await screen.findByRole('option', { name: 'Create Assistant' }));
      });
      expect(button).toHaveTextContent('Create Assistant');

      await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
      act(() => button.focus());
      await act(async () => {
        await user.keyboard(key);
      });
      await waitFor(() => expect(screen.getByRole('listbox')).toBeVisible());
      expect(onSubmit).not.toHaveBeenCalled();
      expect(screen.getByRole('option', { name: 'Second' }).querySelector('svg')).toBeNull();
      await act(async () => {
        await user.keyboard('{Escape}');
      });
      await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    },
  );
  it('renders the placeholder in the muted tone when no value is chosen', () => {
    render(
      <SelectDropDown
        value={null}
        setValue={jest.fn()}
        availableValues={OPTIONS}
        placeholder="Create Assistant"
        showLabel={false}
        emptyTitle={true}
      />,
    );

    expect(screen.getByText('Create Assistant')).toHaveClass('text-text-secondary');
  });

  it('does not mark an empty-valued option as selected when no value is chosen', async () => {
    render(
      <SelectDropDown
        value={null}
        setValue={jest.fn()}
        availableValues={OPTIONS}
        placeholder="Create Assistant"
      />,
    );
    await openList();

    const empty = await screen.findByRole('option', { name: 'Loading...' });
    expect(empty.querySelector('svg')).toBeNull();
  });

  it('marks the chosen option as selected', async () => {
    render(<SelectDropDown value={OPTIONS[1]} setValue={jest.fn()} availableValues={OPTIONS} />);
    await openList();

    const chosen = await screen.findByRole('option', { name: 'Second' });
    expect(chosen.querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('option', { name: 'Loading...' }).querySelector('svg')).toBeNull();
  });
});

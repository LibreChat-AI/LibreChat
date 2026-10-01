import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import SelectDropDown from '../SelectDropDown';

const OPTIONS = [
  { label: 'Loading...', value: '' },
  { label: 'Second', value: 'second' },
];

async function openList() {
  await userEvent.setup().click(screen.getByTestId('select-dropdown-button'));
}

describe('SelectDropDown', () => {
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

import '@testing-library/jest-dom';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { act, render, screen, waitFor } from '@testing-library/react';
import MultiSelect from './MultiSelect';

function Picker({ surface }: { surface?: 'default' | 'widget' }) {
  return (
    <MultiSelect
      label="Agents"
      items={['alpha', 'beta']}
      selectedValues={[]}
      setSelectedValues={() => undefined}
      surface={surface}
    />
  );
}

async function openPopover() {
  await act(() => userEvent.click(screen.getByRole('combobox')));
  return screen.findByRole('dialog', { name: 'Agents' });
}

describe('MultiSelect surface', () => {
  it('paints the popover with the shared menu surface by default', async () => {
    render(<Picker />);
    const popover = await openPopover();
    expect(popover).toHaveClass('bg-surface-secondary');
    expect(popover).not.toHaveClass('bg-chart-widget-surface');
  });

  it('paints the popover with the dashboard widget surface when asked', async () => {
    render(<Picker surface="widget" />);
    const popover = await openPopover();
    expect(popover).toHaveClass('bg-chart-widget-surface');
    expect(popover).not.toHaveClass('bg-surface-secondary');
  });
});

const largeItems = Array.from({ length: 2000 }, (_, index) => ({
  value: `agent-${index}`,
  label: `Agent ${index}`,
}));

function LargePicker({ selected = [] }: { selected?: string[] }) {
  const [values, setValues] = useState(selected);
  return (
    <MultiSelect
      label="Agents"
      items={largeItems}
      selectedValues={values}
      setSelectedValues={setValues}
      searchPlaceholder="Search agents"
      showItemCheckboxes
      virtualized
    />
  );
}

describe('MultiSelect large lists', () => {
  it('mounts a bounded window and can search and select an option at the end of the full list', async () => {
    const user = userEvent.setup();
    render(<LargePicker />);
    await openPopover();
    expect(screen.getAllByRole('option').length).toBeLessThan(50);
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-setsize', '2000');
    await act(() =>
      user.type(screen.getByRole('textbox', { name: 'Search agents' }), 'Agent 1999'),
    );
    const last = await screen.findByRole('option', { name: 'Agent 1999' });
    await act(() => user.click(last));
    await waitFor(() => expect(last).toHaveAttribute('aria-selected', 'true'));
    await act(() => user.keyboard('{Escape}'));
    await openPopover();
    expect(screen.getByRole('textbox', { name: 'Search agents' })).toHaveValue('');
    expect(screen.getByRole('option', { name: 'Agent 1999' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getAllByRole('option').length).toBeLessThan(50);
  });

  it('does not mount every checked row when all 2000 values are selected', async () => {
    const user = userEvent.setup();
    render(<LargePicker selected={largeItems.map((item) => item.value)} />);
    await openPopover();
    expect(screen.getAllByRole('option').length).toBeLessThan(50);
    const first = screen.getByRole('option', { name: 'Agent 0' });
    expect(first).toHaveAttribute('aria-selected', 'true');
    await act(() => user.click(first));
    await waitFor(() => expect(first).toHaveAttribute('aria-selected', 'false'));
    expect(screen.getAllByRole('option').length).toBeLessThan(50);
  });

  it('can reach and select an unmounted last option using the keyboard', async () => {
    const user = userEvent.setup();
    render(<LargePicker />);
    await openPopover();
    await act(() => user.keyboard('{End}'));
    const last = await screen.findByRole('option', { name: 'Agent 1999' });
    await act(() => user.keyboard('{Enter}'));
    await waitFor(() => expect(last).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getAllByRole('option').length).toBeLessThan(50);
  });
});

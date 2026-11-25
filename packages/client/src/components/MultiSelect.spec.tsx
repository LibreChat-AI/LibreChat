import '@testing-library/jest-dom';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
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
  await userEvent.click(screen.getByRole('combobox'));
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

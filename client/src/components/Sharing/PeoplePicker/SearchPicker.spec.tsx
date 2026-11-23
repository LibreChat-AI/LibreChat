import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@testing-library/react';
import { OGDialog, OGDialogContent, OGDialogTitle } from '@librechat/client';
import { SearchPicker } from './SearchPicker';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
const alice = { key: 'alice', value: 'alice', name: 'Alice' };

function page({ options = [alice], query = 'al', loading = false } = {}) {
  const pick = jest.fn();
  function Harness() {
    const [open, setOpen] = React.useState(true);
    const [value, setValue] = React.useState(query);
    return (
      <OGDialog open={open} onOpenChange={setOpen}>
        <OGDialogContent aria-describedby={undefined}>
          <OGDialogTitle>{'People'}</OGDialogTitle>
          <div data-testid="clipping-container" style={{ overflow: 'hidden', maxHeight: 80 }}>
            <SearchPicker
              label="Search people"
              options={options}
              renderOptions={(option) => <div>{option.name}</div>}
              query={value}
              onQueryChange={setValue}
              onPick={pick}
              isLoading={loading}
            />
          </div>
          <button type="button">{'Other field'}</button>
        </OGDialogContent>
      </OGDialog>
    );
  }
  render(<Harness />);
  return { pick, user: userEvent.setup() };
}

test('portals outside the clipping container and selects with the mouse without closing the modal', async () => {
  const { user, pick } = page();
  const input = screen.getByRole('combobox');
  await user.click(input);
  const option = await screen.findByRole('option', { name: 'Alice' });
  const list = screen.getByRole('listbox');
  expect(screen.getByTestId('clipping-container')).not.toContainElement(list);
  expect(list).toHaveClass('popover-ui');
  expect(list).toHaveAttribute('data-variant', 'field');
  expect(list).toHaveStyle({ pointerEvents: 'auto' });
  await user.hover(option);
  expect(input).toHaveFocus();
  await user.click(option);
  expect(pick).toHaveBeenCalledWith(alice);
  expect(input).toHaveFocus();
  await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

test('selects a portaled option with the keyboard while keeping virtual focus in the input', async () => {
  const { user, pick } = page();
  const input = screen.getByRole('combobox');
  await user.click(input);
  await screen.findByRole('option', { name: 'Alice' });
  await user.keyboard('{ArrowDown}');
  expect(input).toHaveFocus();
  expect(input).toHaveAttribute('aria-activedescendant');
  await user.keyboard('{Enter}');
  expect(pick).toHaveBeenCalledWith(alice);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

test('Escape dismisses the list first and the modal on the next press', async () => {
  const { user } = page();
  const input = screen.getByRole('combobox');
  await user.click(input);
  await screen.findByRole('listbox');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
  expect(input).toHaveFocus();
  expect(input).toHaveAttribute('aria-expanded', 'false');
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

test.each([
  { query: 'zz', loading: false, text: 'com_ui_no_results_found' },
  { query: '', loading: true, text: null },
])(
  'keeps loading and empty results in the same bounded portaled list: %j',
  async ({ query, loading, text }) => {
    const { user } = page({ options: [], query, loading });
    await user.click(screen.getByRole('combobox'));
    const list = await screen.findByRole('listbox');
    expect(screen.getByTestId('clipping-container')).not.toContainElement(list);
    expect(list).toHaveClass('popover-ui');
    expect(list).toHaveAttribute('data-variant', 'field');
    if (text) expect(screen.getByText(text)).toBeInTheDocument();
  },
);

test('clicking another field dismisses only the list', async () => {
  const { user, pick } = page();
  const input = screen.getByRole('combobox');
  await user.click(input);
  await screen.findByRole('listbox');
  await user.click(screen.getByRole('button', { name: 'Other field' }));
  await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(pick).not.toHaveBeenCalled();
});

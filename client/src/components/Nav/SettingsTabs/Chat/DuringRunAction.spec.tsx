import { Provider, createStore } from 'jotai';
import { render, waitFor } from '@testing-library/react';
import { clickDropdown, flushDropdownEffects } from 'test/dropdown';
import { duringRunActionAtom } from '~/store/duringRun';
import DuringRunAction from './DuringRunAction';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

it('offers three defaults and persists Interrupt', async () => {
  const store = createStore();
  store.set(duringRunActionAtom, 'steer');
  const { getByText, getByTestId, queryByRole } = render(
    <Provider store={store}>
      <DuringRunAction />
    </Provider>,
  );
  const selector = getByTestId('duringRunAction');
  expect(selector).toHaveTextContent('com_ui_steer');
  await clickDropdown(selector);
  expect(getByText('com_ui_queue')).toBeInTheDocument();
  expect(queryByRole('switch')).not.toBeInTheDocument();
  await clickDropdown(getByText('com_ui_interrupt_steer'));
  await waitFor(() => expect(selector).toHaveTextContent('com_ui_interrupt_steer'));
  expect(store.get(duringRunActionAtom)).toBe('interrupt');
  expect(JSON.parse(localStorage.getItem('duringRunAction') ?? 'null')).toBe('interrupt');
  await flushDropdownEffects();
  localStorage.clear();
});

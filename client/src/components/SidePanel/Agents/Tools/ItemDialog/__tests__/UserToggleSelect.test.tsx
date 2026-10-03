import '@testing-library/jest-dom/extend-expect';
import { useForm, FormProvider, useWatch } from 'react-hook-form';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { AgentForm } from '~/common';
import UserToggleSelect from '../UserToggleSelect';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

function OptionsProbe() {
  const value = useWatch<AgentForm>({ name: 'tool_options' });
  return <span data-testid="options">{JSON.stringify(value)}</span>;
}

function renderSelect(toolOptions: AgentForm['tool_options']) {
  function Wrapper({ children }: { children: ReactNode }) {
    const methods = useForm<AgentForm>({
      defaultValues: { tool_options: toolOptions } as AgentForm,
    });
    return (
      <FormProvider {...methods}>
        {children}
        <OptionsProbe />
      </FormProvider>
    );
  }
  return render(<UserToggleSelect toolOptionKey="web_search" labelId="label" />, {
    wrapper: Wrapper,
  });
}

const stored = () => JSON.parse(screen.getByTestId('options').textContent ?? 'null');
const option = (name: string) => screen.getByRole('radio', { name });

describe('UserToggleSelect', () => {
  it('reflects a stored value', () => {
    renderSelect({ web_search: { user_toggle: 'off' } });
    expect(option('com_ui_tool_toggle_off')).toHaveAttribute('aria-checked', 'true');
  });

  it('is locked when nothing is stored', () => {
    renderSelect(undefined);
    expect(option('com_ui_tool_toggle_locked')).toHaveAttribute('aria-checked', 'true');
  });

  it('writes user_toggle beside other options for the tool', () => {
    renderSelect({ web_search: { defer_loading: true } });
    fireEvent.click(option('com_ui_tool_toggle_on'));
    expect(stored()).toEqual({ web_search: { defer_loading: true, user_toggle: 'on' } });
  });

  it('locking removes the key and drops the emptied entry', () => {
    renderSelect({ web_search: { user_toggle: 'on' }, other: { defer_loading: true } });
    fireEvent.click(option('com_ui_tool_toggle_locked'));
    expect(stored()).toEqual({ other: { defer_loading: true } });
  });

  it('locking keeps sibling options on the entry', () => {
    renderSelect({ web_search: { user_toggle: 'off', defer_loading: true } });
    fireEvent.click(option('com_ui_tool_toggle_locked'));
    expect(stored()).toEqual({ web_search: { defer_loading: true } });
  });
});

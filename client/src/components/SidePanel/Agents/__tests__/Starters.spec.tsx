import userEvent from '@testing-library/user-event';
import { Constants } from 'librechat-data-provider';
import { render, screen } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import type { AgentForm } from '~/common';
import Starters from '../Starters';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

let latest: string[] | undefined;
const onSubmit = jest.fn();

function StartersHarness({ initial = [] }: { initial?: string[] }) {
  const methods = useForm<AgentForm>({ defaultValues: { conversation_starters: initial } });
  latest = methods.watch('conversation_starters');
  return (
    <FormProvider {...methods}>
      <form onSubmit={methods.handleSubmit(onSubmit)}>
        <Starters />
      </form>
    </FormProvider>
  );
}

const draftInput = () =>
  screen.getByPlaceholderText('com_assistants_conversation_starters_placeholder');

describe('Agent conversation starters', () => {
  beforeEach(() => {
    latest = undefined;
    onSubmit.mockClear();
  });

  it('adds a trimmed starter on Enter without submitting the agent form', async () => {
    const user = userEvent.setup();
    render(<StartersHarness />);

    await user.type(draftInput(), '  Plan my week {Enter}');

    expect(latest).toEqual(['Plan my week']);
    expect(draftInput()).toHaveValue('');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('ignores blank drafts', async () => {
    const user = userEvent.setup();
    render(<StartersHarness />);

    await user.type(draftInput(), '   {Enter}');

    expect(latest).toEqual([]);
    expect(screen.getByRole('button', { name: 'com_ui_add' })).toBeDisabled();
  });

  it('edits and deletes an existing starter', async () => {
    const user = userEvent.setup();
    render(<StartersHarness initial={['First', 'Second']} />);

    const second = screen.getByRole('textbox', { name: 'com_assistants_conversation_starters 2' });
    await user.type(second, '!');
    expect(latest).toEqual(['First', 'Second!']);

    await user.click(screen.getByRole('button', { name: 'com_ui_delete: First' }));
    expect(latest).toEqual(['Second!']);
  });

  it('locks the draft input at the maximum', () => {
    const full = Array.from({ length: Number(Constants.MAX_CONVO_STARTERS) }, (_, i) => `S${i}`);
    render(<StartersHarness initial={full} />);

    expect(screen.getByPlaceholderText('com_assistants_max_starters_reached')).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'com_assistants_max_starters_reached' }),
    ).toBeDisabled();
  });
});

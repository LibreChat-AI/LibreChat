import userEvent from '@testing-library/user-event';
import { Constants } from 'librechat-data-provider';
import { FormProvider, useForm } from 'react-hook-form';
import { act, render, screen, fireEvent } from '@testing-library/react';
import type { AgentForm } from '~/common';
import Starters from '../Starters';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

let latest: string[] | undefined;
const onSubmit = jest.fn();

let formMethods: ReturnType<typeof useForm<AgentForm>> | undefined;

function StartersHarness({ initial = [] }: { initial?: string[] }) {
  const methods = useForm<AgentForm>({
    defaultValues: { id: 'agent_a', conversation_starters: initial },
  });
  formMethods = methods;
  latest = methods.watch('conversation_starters');
  return (
    <FormProvider {...methods}>
      <form onSubmit={methods.handleSubmit(onSubmit)}>
        <Starters />
      </form>
    </FormProvider>
  );
}

/** Mirrors AgentPanel: the form outlives the builder section, which unmounts for other panels. */
function PanelHarness({ showBuilder }: { showBuilder: boolean }) {
  const methods = useForm<AgentForm>({
    defaultValues: { id: 'agent_a', conversation_starters: [] },
  });
  return <FormProvider {...methods}>{showBuilder ? <Starters /> : <div />}</FormProvider>;
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

  it('drops an unsent draft when the form switches to another agent', async () => {
    const user = userEvent.setup();
    render(<StartersHarness initial={['Kept']} />);

    await user.type(draftInput(), 'Half-typed for agent A');
    act(() => {
      formMethods?.reset({ id: '', conversation_starters: [] });
    });

    expect(draftInput()).toHaveValue('');
    expect(latest).toEqual([]);
  });

  it('keeps each delete control on the same row as its starter', () => {
    render(<StartersHarness initial={['First']} />);

    const input = screen.getByRole('textbox', { name: 'com_assistants_conversation_starters 1' });
    const remove = screen.getByRole('button', { name: 'com_ui_delete: First' });
    expect(remove.parentElement).toBe(input.parentElement);
    expect(input.parentElement).toHaveClass('flex', 'items-center');
  });

  it('does not add a starter when Enter commits an IME composition', () => {
    render(<StartersHarness />);

    const input = draftInput();
    fireEvent.change(input, { target: { value: '会話' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });

    expect(latest).toEqual([]);
    expect(input).toHaveValue('会話');
  });

  it('keeps the draft when the section unmounts for another builder panel', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<PanelHarness showBuilder />);

    await user.type(draftInput(), 'Keep me');
    rerender(<PanelHarness showBuilder={false} />);
    expect(
      screen.queryByPlaceholderText('com_assistants_conversation_starters_placeholder'),
    ).toBeNull();
    rerender(<PanelHarness showBuilder />);

    expect(draftInput()).toHaveValue('Keep me');
  });

  it('accepts starters longer than 64 characters in the draft and existing rows', async () => {
    const user = userEvent.setup();
    const long = 'Summarize the attached quarterly report and list the three largest risks';
    render(<StartersHarness initial={['Short']} />);

    await user.type(draftInput(), `${long}{Enter}`);
    const row = screen.getByLabelText('com_assistants_conversation_starters 1');
    await user.type(row, ` ${long}`);

    expect(latest).toEqual([`Short ${long}`, long]);
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

import React from 'react';
import { useForm, FormProvider } from 'react-hook-form';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { TPromptGroup, TPrompt } from 'librechat-data-provider';
import type { UseFormReturn } from 'react-hook-form';
import type { AgentForm } from '~/common';
import InstructionsPromptFields from '../InstructionsPromptFields';

let mockGroupsQuery: {
  data?: unknown;
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
  refetch: jest.Mock;
};
let mockPromptsQuery: {
  data?: unknown;
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
  refetch: jest.Mock;
};

jest.mock('~/data-provider', () => ({
  useGetAllPromptGroups: () => mockGroupsQuery,
  useGetPrompts: () => mockPromptsQuery,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

jest.mock('@librechat/client', () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: React.ComponentProps<'button'> & { variant?: string; size?: string }) => (
    <button {...props}>{children}</button>
  ),
  Label: ({ children, ...props }: React.ComponentProps<'label'>) => (
    <label {...props}>{children}</label>
  ),
  ControlCombobox: ({
    ariaLabel,
    selectId,
    items,
    selectedValue,
    displayValue,
    setValue,
  }: {
    ariaLabel: string;
    selectId?: string;
    items: Array<{ value: string; label: string }>;
    selectedValue: string;
    displayValue?: string;
    setValue: (value: string) => void;
  }) => (
    <div>
      {/* Mirrors the real combobox's current-value text for the Prompt dropdown only,
       *  which `displayValue` drives independently of `selectedValue`/`items` (the stub
       *  shows a label with no matching option). Scoped to this one dropdown so it
       *  doesn't duplicate the Version dropdown's option text in other assertions. */}
      {selectId === 'instructions-prompt-group' && (
        <span data-testid={`${selectId}-display-value`}>{displayValue}</span>
      )}
      <select
        aria-label={ariaLabel}
        id={selectId}
        value={selectedValue}
        onChange={(event) => setValue(event.target.value)}
      >
        {items.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
    </div>
  ),
}));

const group = (overrides: Partial<TPromptGroup> = {}): TPromptGroup => ({
  name: 'Support triage',
  author: 'user1',
  authorName: 'User One',
  _id: 'group1',
  ...overrides,
});

const prompt = (overrides: Partial<TPrompt> = {}): TPrompt => ({
  groupId: 'group1',
  author: 'user1',
  prompt: 'text',
  type: 'text',
  createdAt: '',
  updatedAt: '',
  ...overrides,
});

function Harness({
  defaultInstructionsPrompt = null,
  defaultInstructionsSource = 'prompt',
  onMethods,
}: {
  defaultInstructionsPrompt?: unknown;
  defaultInstructionsSource?: AgentForm['instructionsSource'];
  onMethods?: (methods: UseFormReturn<AgentForm>) => void;
}) {
  const methods = useForm<AgentForm>({
    defaultValues: {
      instructionsSource: defaultInstructionsSource,
      instructionsPrompt: defaultInstructionsPrompt,
    } as Partial<AgentForm>,
  });
  onMethods?.(methods);
  return (
    <FormProvider {...methods}>
      <InstructionsPromptFields />
    </FormProvider>
  );
}

beforeEach(() => {
  mockGroupsQuery = {
    data: [],
    isLoading: false,
    isError: false,
    error: undefined,
    refetch: jest.fn(),
  };
  mockPromptsQuery = {
    data: [],
    isLoading: false,
    isError: false,
    error: undefined,
    refetch: jest.fn(),
  };
});

describe('InstructionsPromptFields', () => {
  it('shows a loading state for the Prompt dropdown', () => {
    mockGroupsQuery.isLoading = true;
    render(<Harness />);

    expect(screen.getByText('com_ui_loading')).toBeInTheDocument();
  });

  it('shows an empty state when there are no prompt groups', () => {
    mockGroupsQuery.data = [];
    render(<Harness />);

    expect(screen.getByText('com_agents_instructions_prompt_empty')).toBeInTheDocument();
  });

  it('shows an error with Retry, and retries on click', () => {
    mockGroupsQuery.isError = true;
    mockGroupsQuery.error = new Error('network down');
    render(<Harness />);

    expect(screen.getByText('com_agents_instructions_prompt_load_error')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(mockGroupsQuery.refetch).toHaveBeenCalledTimes(1);
  });

  it('shows a distinct message for a 403 and offers no retry', () => {
    mockGroupsQuery.isError = true;
    mockGroupsQuery.error = { isAxiosError: true, response: { status: 403, data: {} } };
    render(<Harness />);

    expect(screen.getByText('com_agents_instructions_prompt_forbidden')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'com_ui_retry' })).not.toBeInTheDocument();
  });

  it('selecting a prompt group defaults the selection to Production', () => {
    mockGroupsQuery.data = [group()];
    let methods: UseFormReturn<AgentForm> | undefined;
    render(<Harness onMethods={(m) => (methods = m)} />);

    fireEvent.change(screen.getByRole('combobox', { name: 'com_ui_prompt' }), {
      target: { value: 'group1' },
    });

    expect(methods?.getValues('instructionsPrompt')).toEqual({
      source: 'native',
      groupId: 'group1',
      selection: { type: 'production' },
    });
  });

  it('lists Production first, then versions newest to oldest', () => {
    mockGroupsQuery.data = [group({ productionId: 'p2' })];
    mockPromptsQuery.data = [prompt({ _id: 'p3' }), prompt({ _id: 'p2' }), prompt({ _id: 'p1' })];
    render(
      <Harness
        defaultInstructionsPrompt={{
          source: 'native',
          groupId: 'group1',
          selection: { type: 'production' },
        }}
      />,
    );

    const versionSelect = screen.getByRole('combobox', {
      name: 'com_agents_instructions_prompt_version_label',
    });
    const optionValues = Array.from(versionSelect.querySelectorAll('option')).map(
      (option) => (option as HTMLOptionElement).value,
    );
    expect(optionValues).toEqual(['production', 'p3', 'p2', 'p1']);
    expect(
      screen.getByText('com_agents_instructions_prompt_production_version:{"0":"2"}'),
    ).toBeInTheDocument();
  });

  it('selecting a version produces an exact selection', () => {
    mockGroupsQuery.data = [group()];
    mockPromptsQuery.data = [prompt({ _id: 'p2' }), prompt({ _id: 'p1' })];
    let methods: UseFormReturn<AgentForm> | undefined;
    render(
      <Harness
        defaultInstructionsPrompt={{
          source: 'native',
          groupId: 'group1',
          selection: { type: 'production' },
        }}
        onMethods={(m) => (methods = m)}
      />,
    );

    fireEvent.change(
      screen.getByRole('combobox', { name: 'com_agents_instructions_prompt_version_label' }),
      { target: { value: 'p1' } },
    );

    expect(methods?.getValues('instructionsPrompt')).toEqual({
      source: 'native',
      groupId: 'group1',
      selection: { type: 'exact', promptId: 'p1' },
    });
  });

  it('disables the Version dropdown until a prompt group is selected', () => {
    mockGroupsQuery.data = [group()];
    render(<Harness />);

    expect(
      screen.getByText('com_agents_instructions_prompt_version_placeholder'),
    ).toBeInTheDocument();
  });

  it('surfaces a 403 for the Version dropdown separately from the Prompt dropdown', () => {
    mockGroupsQuery.data = [group()];
    mockPromptsQuery.isError = true;
    mockPromptsQuery.error = { isAxiosError: true, response: { status: 403, data: {} } };
    render(
      <Harness
        defaultInstructionsPrompt={{
          source: 'native',
          groupId: 'group1',
          selection: { type: 'production' },
        }}
      />,
    );

    expect(screen.getByText('com_agents_instructions_prompt_forbidden')).toBeInTheDocument();
  });

  it('guards a 200 {message} version response as a load failure, not a crash', () => {
    mockGroupsQuery.data = [group()];
    mockPromptsQuery.data = { message: 'not allowed' };
    render(
      <Harness
        defaultInstructionsPrompt={{
          source: 'native',
          groupId: 'group1',
          selection: { type: 'production' },
        }}
      />,
    );

    expect(screen.getByText('com_agents_instructions_prompt_load_error')).toBeInTheDocument();
  });

  it('guards a 200 {message} group response as a load failure, not an empty library', () => {
    mockGroupsQuery.data = { message: 'not allowed' };
    render(<Harness />);

    expect(screen.getByText('com_agents_instructions_prompt_load_error')).toBeInTheDocument();
    expect(screen.queryByText('com_agents_instructions_prompt_empty')).not.toBeInTheDocument();
  });

  describe('required validation', () => {
    it('blocks the save with a localized error when Prompt mode has no group selected', async () => {
      let methods: UseFormReturn<AgentForm> | undefined;
      mockGroupsQuery.data = [group()];
      render(
        <Harness
          defaultInstructionsSource="prompt"
          defaultInstructionsPrompt={null}
          onMethods={(m) => (methods = m)}
        />,
      );

      let isValid = true;
      await act(async () => {
        isValid = await methods!.trigger('instructionsPrompt');
      });

      expect(isValid).toBe(false);
      expect(screen.getByText('com_agents_instructions_prompt_required')).toBeInTheDocument();
    });

    it('passes validation once a group is selected', async () => {
      let methods: UseFormReturn<AgentForm> | undefined;
      mockGroupsQuery.data = [group()];
      render(
        <Harness
          defaultInstructionsSource="prompt"
          defaultInstructionsPrompt={{
            source: 'native',
            groupId: 'group1',
            selection: { type: 'production' },
          }}
          onMethods={(m) => (methods = m)}
        />,
      );

      let isValid = false;
      await act(async () => {
        isValid = await methods!.trigger('instructionsPrompt');
      });

      expect(isValid).toBe(true);
    });

    it('never blocks the save on a restricted stub', async () => {
      let methods: UseFormReturn<AgentForm> | undefined;
      render(
        <Harness
          defaultInstructionsSource="prompt"
          defaultInstructionsPrompt={{ source: 'native', restricted: true }}
          onMethods={(m) => (methods = m)}
        />,
      );

      let isValid = false;
      await act(async () => {
        isValid = await methods!.trigger('instructionsPrompt');
      });

      expect(isValid).toBe(true);
    });

    it('does not validate the link while Inline mode is selected', async () => {
      let methods: UseFormReturn<AgentForm> | undefined;
      render(
        <Harness
          defaultInstructionsSource="inline"
          defaultInstructionsPrompt={null}
          onMethods={(m) => (methods = m)}
        />,
      );

      let isValid = false;
      await act(async () => {
        isValid = await methods!.trigger('instructionsPrompt');
      });

      expect(isValid).toBe(true);
    });
  });

  describe('a restricted stub the editor cannot VIEW', () => {
    const stub = { source: 'native' as const, restricted: true as const };

    it('shows the localized "Restricted prompt" label as the current value, never a group name', () => {
      mockGroupsQuery.data = [group()];
      render(<Harness defaultInstructionsPrompt={stub} />);

      /** The listed group ("Support triage") is still a selectable option below, so this
       *  checks the dropdown's current-value text specifically, not the whole document. */
      expect(screen.getByTestId('instructions-prompt-group-display-value')).toHaveTextContent(
        'com_agents_instructions_prompt_restricted_title',
      );
    });

    it('leaves the Prompt dropdown enabled so a replacement can be picked', () => {
      mockGroupsQuery.data = [group()];
      render(<Harness defaultInstructionsPrompt={stub} />);

      expect(screen.getByRole('combobox', { name: 'com_ui_prompt' })).toBeInTheDocument();
    });

    it('disables the Version dropdown until a real group is picked', () => {
      mockGroupsQuery.data = [group()];
      render(<Harness defaultInstructionsPrompt={stub} />);

      expect(
        screen.getByText('com_agents_instructions_prompt_version_placeholder'),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('combobox', { name: 'com_agents_instructions_prompt_version_label' }),
      ).not.toBeInTheDocument();
    });

    it('replaces the stub with a picked group through the existing handleGroupChange', () => {
      mockGroupsQuery.data = [group()];
      let methods: UseFormReturn<AgentForm> | undefined;
      render(<Harness defaultInstructionsPrompt={stub} onMethods={(m) => (methods = m)} />);

      fireEvent.change(screen.getByRole('combobox', { name: 'com_ui_prompt' }), {
        target: { value: 'group1' },
      });

      expect(methods?.getValues('instructionsPrompt')).toEqual({
        source: 'native',
        groupId: 'group1',
        selection: { type: 'production' },
      });
    });

    it('does not show the "Prompt not found" hint for a stub, which carries no groupId', () => {
      mockGroupsQuery.data = [group()];
      render(<Harness defaultInstructionsPrompt={stub} />);

      expect(
        screen.queryByText('com_agents_instructions_prompt_not_found'),
      ).not.toBeInTheDocument();
    });
  });

  describe('a linked group missing from the listing', () => {
    it('shows a "Prompt not found" hint instead of a blank Prompt display', () => {
      mockGroupsQuery.data = [group({ _id: 'group_other', name: 'Other prompt' })];
      render(
        <Harness
          defaultInstructionsPrompt={{
            source: 'native',
            groupId: 'group_missing',
            selection: { type: 'production' },
          }}
        />,
      );

      expect(screen.getByText('com_agents_instructions_prompt_not_found')).toBeInTheDocument();
    });

    it('keeps the Version dropdown usable for switching away from the missing group', () => {
      mockGroupsQuery.data = [group({ _id: 'group_other', name: 'Other prompt' })];
      mockPromptsQuery.data = [prompt({ _id: 'p2' }), prompt({ _id: 'p1' })];
      render(
        <Harness
          defaultInstructionsPrompt={{
            source: 'native',
            groupId: 'group_missing',
            selection: { type: 'production' },
          }}
        />,
      );

      expect(
        screen.getByRole('combobox', { name: 'com_agents_instructions_prompt_version_label' }),
      ).toBeInTheDocument();
    });

    it('still renders the Prompt combobox so the user can pick a replacement group', () => {
      /** The backend allows removing or replacing a link to a deleted group, so the hint
       *  must not replace the combobox — the user needs a control to act on it. */
      mockGroupsQuery.data = [group({ _id: 'group_other', name: 'Other prompt' })];
      render(
        <Harness
          defaultInstructionsPrompt={{
            source: 'native',
            groupId: 'group_missing',
            selection: { type: 'production' },
          }}
        />,
      );

      expect(screen.getByText('com_agents_instructions_prompt_not_found')).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: 'com_ui_prompt' })).toBeInTheDocument();
    });

    it('lets the user pick a listed group to replace the missing one', () => {
      mockGroupsQuery.data = [group({ _id: 'group_other', name: 'Other prompt' })];
      let methods: UseFormReturn<AgentForm> | undefined;
      render(
        <Harness
          defaultInstructionsPrompt={{
            source: 'native',
            groupId: 'group_missing',
            selection: { type: 'production' },
          }}
          onMethods={(m) => (methods = m)}
        />,
      );

      fireEvent.change(screen.getByRole('combobox', { name: 'com_ui_prompt' }), {
        target: { value: 'group_other' },
      });

      expect(methods?.getValues('instructionsPrompt')).toEqual({
        source: 'native',
        groupId: 'group_other',
        selection: { type: 'production' },
      });
    });
  });

  describe('accessible names across every render state', () => {
    const versionLabel = 'com_agents_instructions_prompt_version_label';

    it('names the Prompt field while loading', () => {
      mockGroupsQuery.isLoading = true;
      render(<Harness />);

      expect(screen.getByRole('group', { name: 'com_ui_prompt' })).toBeInTheDocument();
    });

    it('names the Prompt field on a load error', () => {
      mockGroupsQuery.isError = true;
      render(<Harness />);

      expect(screen.getByRole('group', { name: 'com_ui_prompt' })).toBeInTheDocument();
    });

    it('names the Prompt field when the library is empty', () => {
      mockGroupsQuery.data = [];
      render(<Harness />);

      expect(screen.getByRole('group', { name: 'com_ui_prompt' })).toBeInTheDocument();
    });

    it('names the Prompt field once prompts load', () => {
      mockGroupsQuery.data = [group()];
      render(<Harness />);

      expect(screen.getByRole('group', { name: 'com_ui_prompt' })).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: 'com_ui_prompt' })).toBeInTheDocument();
    });

    it('names the Prompt field when the linked group is missing', () => {
      mockGroupsQuery.data = [group({ _id: 'group_other' })];
      render(
        <Harness
          defaultInstructionsPrompt={{
            source: 'native',
            groupId: 'group_missing',
            selection: { type: 'production' },
          }}
        />,
      );

      expect(screen.getByRole('group', { name: 'com_ui_prompt' })).toBeInTheDocument();
    });

    it('names the Version field before and after a group is selected', async () => {
      mockGroupsQuery.data = [group()];
      mockPromptsQuery.data = [prompt()];
      let methods: UseFormReturn<AgentForm> | undefined;
      render(<Harness onMethods={(m) => (methods = m)} />);

      expect(screen.getByRole('group', { name: versionLabel })).toBeInTheDocument();

      await act(async () => {
        methods!.setValue('instructionsPrompt', {
          source: 'native',
          groupId: 'group1',
          selection: { type: 'production' },
        });
      });

      expect(screen.getByRole('group', { name: versionLabel })).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: versionLabel })).toBeInTheDocument();
    });
  });
});

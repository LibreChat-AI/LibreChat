import React from 'react';
import { useForm, FormProvider } from 'react-hook-form';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { TPromptGroup, TPromptRevisionChoicesResponse } from 'librechat-data-provider';
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
let mockRevisionsQuery: {
  data?: unknown;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  error?: unknown;
  refetch: jest.Mock;
};
let mockLangfuseEnabled: boolean;

// Lets a test read the `enabled` option passed to the mocked hook.
const mockUseGetPromptGroupRevisions = jest.fn(
  (_id: string, _options: { enabled?: boolean }) => mockRevisionsQuery,
);

jest.mock('~/data-provider', () => ({
  useGetAllPromptGroups: () => mockGroupsQuery,
  useGetPromptGroupRevisions: (id: string, options: { enabled?: boolean }) =>
    mockUseGetPromptGroupRevisions(id, options),
}));

jest.mock('~/Providers/AgentPanelContext', () => ({
  useAgentPanelContext: () => ({
    agentsConfig: { linkedInstructions: { langfuse: { enabled: mockLangfuseEnabled } } },
  }),
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
  TooltipAnchor: ({ render: content }: { render: React.ReactNode }) => content,
  ControlCombobox: ({
    ariaLabel,
    selectId,
    items,
    selectedValue,
    displayValue,
    setValue,
    SelectIcon,
    iconSide = 'left',
  }: {
    ariaLabel: string;
    selectId?: string;
    items: Array<{ value: string; label: string; icon?: React.ReactNode }>;
    selectedValue: string;
    displayValue?: string;
    setValue: (value: string) => void;
    SelectIcon?: React.ReactNode;
    iconSide?: 'left' | 'right';
  }) => (
    <div>
      {/* Mirrors the real combobox's current-value text for the Prompt dropdown only,
       *  which `displayValue` drives independently of `selectedValue`/`items` (the stub
       *  shows a label with no matching option). Scoped to this one dropdown so it
       *  doesn't duplicate the Version dropdown's option text in other assertions. */}
      {selectId === 'instructions-prompt-group' && (
        <span data-testid={`${selectId}-display-value`}>{displayValue}</span>
      )}
      {selectId === 'instructions-prompt-group' && SelectIcon != null && (
        <span data-testid={`${selectId}-select-icon`}>{SelectIcon}</span>
      )}
      <select
        aria-label={ariaLabel}
        id={selectId}
        value={selectedValue}
        onChange={(event) => setValue(event.target.value)}
      >
        {items.map((item) => {
          // Mirrors the real option's label/badge DOM order, which `iconSide` controls,
          // so a test can read the accessible name to confirm which side the badge is on.
          const badgeMarker =
            selectId === 'instructions-prompt-group' && item.icon != null ? '○langfuse' : '';
          const optionLabel =
            iconSide === 'right' ? `${item.label}${badgeMarker}` : `${badgeMarker}${item.label}`;
          return (
            <option key={item.value} value={item.value}>
              {optionLabel}
            </option>
          );
        })}
      </select>
      {selectId === 'instructions-prompt-group' &&
        items.map((item) => (
          <span key={`icon-${item.value}`} data-testid={`item-icon-${item.value}`}>
            {item.icon}
          </span>
        ))}
    </div>
  ),
}));

const group = (overrides: Partial<TPromptGroup> = {}): TPromptGroup => ({
  name: 'Support triage',
  author: 'user1',
  authorName: 'User One',
  _id: 'group1',
  source: 'native',
  ...overrides,
});

const nativeRevisions = (
  revisions: Array<{ promptId: string; version: number; isProduction?: boolean }>,
): TPromptRevisionChoicesResponse => ({
  source: 'native',
  groupId: 'group1',
  revisions: revisions.map((revision) => ({
    source: 'native' as const,
    promptId: revision.promptId,
    version: revision.version,
    isProduction: revision.isProduction ?? false,
  })),
});

const langfuseRevisions = (versions: number[]): TPromptRevisionChoicesResponse => ({
  source: 'langfuse',
  groupId: 'group2',
  revisions: versions.map((version) => ({ source: 'langfuse' as const, version })),
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
  mockLangfuseEnabled = false;
  mockGroupsQuery = {
    data: [],
    isLoading: false,
    isError: false,
    error: undefined,
    refetch: jest.fn(),
  };
  mockRevisionsQuery = {
    data: undefined,
    isLoading: false,
    isError: false,
    isFetching: false,
    error: undefined,
    refetch: jest.fn(),
  };
  mockUseGetPromptGroupRevisions.mockClear();
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

  it('selecting a native prompt group defaults the selection to Production and writes source "native"', () => {
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

  it('selecting a Langfuse prompt group defaults the selection to Production and writes source "langfuse"', () => {
    mockLangfuseEnabled = true;
    mockGroupsQuery.data = [group({ _id: 'group2', source: 'langfuse', name: 'Langfuse group' })];
    let methods: UseFormReturn<AgentForm> | undefined;
    render(<Harness onMethods={(m) => (methods = m)} />);

    fireEvent.change(screen.getByRole('combobox', { name: 'com_ui_prompt' }), {
      target: { value: 'group2' },
    });

    expect(methods?.getValues('instructionsPrompt')).toEqual({
      source: 'langfuse',
      groupId: 'group2',
      selection: { type: 'production' },
    });
  });

  it('resets a native exact selection to Production when switching to a Langfuse group', () => {
    mockLangfuseEnabled = true;
    mockGroupsQuery.data = [
      group(),
      group({ _id: 'group2', source: 'langfuse', name: 'Langfuse group' }),
    ];
    let methods: UseFormReturn<AgentForm> | undefined;
    render(
      <Harness
        defaultInstructionsPrompt={{
          source: 'native',
          groupId: 'group1',
          selection: { type: 'exact', promptId: 'p1' },
        }}
        onMethods={(m) => (methods = m)}
      />,
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'com_ui_prompt' }), {
      target: { value: 'group2' },
    });

    expect(methods?.getValues('instructionsPrompt')).toEqual({
      source: 'langfuse',
      groupId: 'group2',
      selection: { type: 'production' },
    });
  });

  it('resets a Langfuse exact selection to Production when switching to a native group', () => {
    mockLangfuseEnabled = true;
    mockGroupsQuery.data = [
      group(),
      group({ _id: 'group2', source: 'langfuse', name: 'Langfuse group' }),
    ];
    let methods: UseFormReturn<AgentForm> | undefined;
    render(
      <Harness
        defaultInstructionsPrompt={{
          source: 'langfuse',
          groupId: 'group2',
          selection: { type: 'exact', version: 3 },
        }}
        onMethods={(m) => (methods = m)}
      />,
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'com_ui_prompt' }), {
      target: { value: 'group1' },
    });

    expect(methods?.getValues('instructionsPrompt')).toEqual({
      source: 'native',
      groupId: 'group1',
      selection: { type: 'production' },
    });
  });

  it('shows a cloud badge icon for a Langfuse group and none for a native group', () => {
    mockLangfuseEnabled = true;
    mockGroupsQuery.data = [group(), group({ _id: 'group2', source: 'langfuse' })];
    render(<Harness />);

    expect(screen.getByTestId('item-icon-group1')).toBeEmptyDOMElement();
    expect(
      screen.getByTestId('item-icon-group2').querySelector('[role="img"]'),
    ).toBeInTheDocument();
  });

  it('renders the combobox option badge with no tabindex, since it sits inside an already-interactive option', () => {
    mockLangfuseEnabled = true;
    mockGroupsQuery.data = [group({ _id: 'group2', source: 'langfuse' })];
    render(<Harness />);

    const badge = screen.getByTestId('item-icon-group2').querySelector('[role="img"]');
    expect(badge).not.toHaveAttribute('tabindex');
  });

  it('passes a SelectIcon for a selected Langfuse group', () => {
    mockLangfuseEnabled = true;
    mockGroupsQuery.data = [group({ _id: 'group2', source: 'langfuse' })];
    render(
      <Harness
        defaultInstructionsPrompt={{
          source: 'langfuse',
          groupId: 'group2',
          selection: { type: 'production' },
        }}
      />,
    );

    const selectIconBadge = screen
      .getByTestId('instructions-prompt-group-select-icon')
      .querySelector('[role="img"]');
    expect(selectIconBadge).toBeInTheDocument();
    expect(selectIconBadge).not.toHaveAttribute('tabindex');
  });

  it("puts the Langfuse badge after the group name, so the option's accessible name starts with the group name", () => {
    mockLangfuseEnabled = true;
    mockGroupsQuery.data = [
      group(),
      group({ _id: 'group2', source: 'langfuse', name: 'Langfuse group' }),
    ];
    render(<Harness />);

    const option = screen.getByRole('option', { name: /^Langfuse group/ });
    expect(option).toHaveValue('group2');
  });

  describe('the rollout switch', () => {
    it('hides a Langfuse group from the picker while the switch is off', () => {
      mockGroupsQuery.data = [group(), group({ _id: 'group2', source: 'langfuse' })];
      render(<Harness />);

      const options = Array.from(
        screen.getByRole('combobox', { name: 'com_ui_prompt' }).querySelectorAll('option'),
      ).map((option) => (option as HTMLOptionElement).value);
      expect(options).toEqual(['group1']);
    });

    it('shows the empty-state copy, not an enabled empty combobox, when every group is Langfuse and none is linked', () => {
      mockGroupsQuery.data = [group({ _id: 'group2', source: 'langfuse' })];
      render(<Harness />);

      expect(screen.getByText('com_agents_instructions_prompt_empty')).toBeInTheDocument();
      expect(screen.queryByRole('combobox', { name: 'com_ui_prompt' })).not.toBeInTheDocument();
    });

    it('still lists the currently saved Langfuse group while the switch is off', () => {
      mockGroupsQuery.data = [group(), group({ _id: 'group2', source: 'langfuse' })];
      render(
        <Harness
          defaultInstructionsPrompt={{
            source: 'langfuse',
            groupId: 'group2',
            selection: { type: 'production' },
          }}
        />,
      );

      const options = Array.from(
        screen.getByRole('combobox', { name: 'com_ui_prompt' }).querySelectorAll('option'),
      ).map((option) => (option as HTMLOptionElement).value);
      expect(options).toEqual(['group1', 'group2']);
    });

    it('shows a disabled note next to the saved Langfuse link, keeping it and the picker usable', () => {
      mockGroupsQuery.data = [group({ _id: 'group2', source: 'langfuse', name: 'Langfuse group' })];
      render(
        <Harness
          defaultInstructionsPrompt={{
            source: 'langfuse',
            groupId: 'group2',
            selection: { type: 'exact', version: 4 },
          }}
        />,
      );

      expect(screen.getByRole('note')).toHaveTextContent(
        'com_agents_instructions_prompt_source_disabled',
      );
      expect(screen.getByRole('combobox', { name: 'com_ui_prompt' })).toBeInTheDocument();
      expect(screen.getByTestId('instructions-prompt-group-display-value')).toHaveTextContent(
        'Langfuse group',
      );
    });

    it('still shows the disabled note and read-only version when the saved group is missing from the listing', () => {
      // No matching group, so the disabled state must read off the link's own `source`.
      mockGroupsQuery.data = [];
      render(
        <Harness
          defaultInstructionsPrompt={{
            source: 'langfuse',
            groupId: 'group2',
            selection: { type: 'exact', version: 4 },
          }}
        />,
      );

      const notes = screen.getAllByRole('note');
      expect(
        notes.some((note) => note.textContent === 'com_agents_instructions_prompt_source_disabled'),
      ).toBe(true);
      expect(screen.getByText('com_ui_version_var:{"0":"4"}')).toBeInTheDocument();
      expect(mockUseGetPromptGroupRevisions).toHaveBeenLastCalledWith(
        'group2',
        expect.objectContaining({ enabled: false }),
      );
    });

    it('shows the saved version as plain text with no revisions request while disabled', () => {
      mockGroupsQuery.data = [group({ _id: 'group2', source: 'langfuse' })];
      render(
        <Harness
          defaultInstructionsPrompt={{
            source: 'langfuse',
            groupId: 'group2',
            selection: { type: 'exact', version: 4 },
          }}
        />,
      );

      expect(screen.getByText('com_ui_version_var:{"0":"4"}')).toBeInTheDocument();
      expect(
        screen.queryByRole('combobox', { name: 'com_agents_instructions_prompt_version_label' }),
      ).not.toBeInTheDocument();
      expect(mockUseGetPromptGroupRevisions).toHaveBeenLastCalledWith(
        'group2',
        expect.objectContaining({ enabled: false }),
      );
    });

    it('shows no disabled note and no restriction once the switch is on', () => {
      mockLangfuseEnabled = true;
      mockGroupsQuery.data = [group({ _id: 'group2', source: 'langfuse' })];
      mockRevisionsQuery.data = langfuseRevisions([4, 3]);
      render(
        <Harness
          defaultInstructionsPrompt={{
            source: 'langfuse',
            groupId: 'group2',
            selection: { type: 'exact', version: 4 },
          }}
        />,
      );

      expect(
        screen.queryByText('com_agents_instructions_prompt_source_disabled'),
      ).not.toBeInTheDocument();
      expect(mockUseGetPromptGroupRevisions).toHaveBeenLastCalledWith(
        'group2',
        expect.objectContaining({ enabled: true }),
      );
      expect(
        screen.getByRole('combobox', { name: 'com_agents_instructions_prompt_version_label' }),
      ).toBeInTheDocument();
    });

    it('still allows switching a disabled Langfuse link to a native group', () => {
      mockGroupsQuery.data = [
        group(),
        group({ _id: 'group2', source: 'langfuse', name: 'Langfuse group' }),
      ];
      let methods: UseFormReturn<AgentForm> | undefined;
      render(
        <Harness
          defaultInstructionsPrompt={{
            source: 'langfuse',
            groupId: 'group2',
            selection: { type: 'production' },
          }}
          onMethods={(m) => (methods = m)}
        />,
      );

      fireEvent.change(screen.getByRole('combobox', { name: 'com_ui_prompt' }), {
        target: { value: 'group1' },
      });

      expect(methods?.getValues('instructionsPrompt')).toEqual({
        source: 'native',
        groupId: 'group1',
        selection: { type: 'production' },
      });
      // The saved Langfuse link stays listed even once it's no longer the current
      // selection: the "keep visible" check is keyed off the saved link, not the live value.
      const options = Array.from(
        screen.getByRole('combobox', { name: 'com_ui_prompt' }).querySelectorAll('option'),
      ).map((option) => (option as HTMLOptionElement).value);
      expect(options).toEqual(['group1', 'group2']);
    });

    it('still allows removing a disabled Langfuse link', () => {
      mockGroupsQuery.data = [group({ _id: 'group2', source: 'langfuse' })];
      let methods: UseFormReturn<AgentForm> | undefined;
      render(
        <Harness
          defaultInstructionsPrompt={{
            source: 'langfuse',
            groupId: 'group2',
            selection: { type: 'production' },
          }}
          onMethods={(m) => (methods = m)}
        />,
      );

      fireEvent.change(screen.getByRole('combobox', { name: 'com_ui_prompt' }), {
        target: { value: '' },
      });

      expect(methods?.getValues('instructionsPrompt')).toBeNull();
    });

    it('keeps the saved selection when the same disabled Langfuse group is re-picked', () => {
      mockGroupsQuery.data = [group({ _id: 'group2', source: 'langfuse' })];
      let methods: UseFormReturn<AgentForm> | undefined;
      render(
        <Harness
          defaultInstructionsPrompt={{
            source: 'langfuse',
            groupId: 'group2',
            selection: { type: 'exact', version: 4 },
          }}
          onMethods={(m) => (methods = m)}
        />,
      );

      fireEvent.change(screen.getByRole('combobox', { name: 'com_ui_prompt' }), {
        target: { value: 'group2' },
      });

      expect(methods?.getValues('instructionsPrompt')).toEqual({
        source: 'langfuse',
        groupId: 'group2',
        selection: { type: 'exact', version: 4 },
      });
    });
  });

  describe('native version options', () => {
    it('lists Production first, then versions newest to oldest', () => {
      mockGroupsQuery.data = [group()];
      mockRevisionsQuery.data = nativeRevisions([
        { promptId: 'p3', version: 3 },
        { promptId: 'p2', version: 2, isProduction: true },
        { promptId: 'p1', version: 1 },
      ]);
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
      mockRevisionsQuery.data = nativeRevisions([
        { promptId: 'p2', version: 2 },
        { promptId: 'p1', version: 1 },
      ]);
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

    it('appends the saved version, labelled as missing, when it matches no listed revision', () => {
      mockGroupsQuery.data = [group()];
      mockRevisionsQuery.data = nativeRevisions([{ promptId: 'p1', version: 1 }]);
      render(
        <Harness
          defaultInstructionsPrompt={{
            source: 'native',
            groupId: 'group1',
            selection: { type: 'exact', promptId: 'deleted' },
          }}
        />,
      );

      expect(
        screen.getByText('com_agents_instructions_prompt_version_missing'),
      ).toBeInTheDocument();
    });
  });

  describe('Langfuse version options', () => {
    it('lists Production first with a plain label, then pinned versions newest to oldest', () => {
      mockLangfuseEnabled = true;
      mockGroupsQuery.data = [group({ _id: 'group2', source: 'langfuse' })];
      mockRevisionsQuery.data = langfuseRevisions([3, 2, 1]);
      render(
        <Harness
          defaultInstructionsPrompt={{
            source: 'langfuse',
            groupId: 'group2',
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
      expect(optionValues).toEqual(['production', 'v3', 'v2', 'v1']);
      expect(screen.getByText('com_ui_production')).toBeInTheDocument();
    });

    it('selecting a pinned version produces a Langfuse version selection', () => {
      mockLangfuseEnabled = true;
      mockGroupsQuery.data = [group({ _id: 'group2', source: 'langfuse' })];
      mockRevisionsQuery.data = langfuseRevisions([3, 2, 1]);
      let methods: UseFormReturn<AgentForm> | undefined;
      render(
        <Harness
          defaultInstructionsPrompt={{
            source: 'langfuse',
            groupId: 'group2',
            selection: { type: 'production' },
          }}
          onMethods={(m) => (methods = m)}
        />,
      );

      fireEvent.change(
        screen.getByRole('combobox', { name: 'com_agents_instructions_prompt_version_label' }),
        { target: { value: 'v2' } },
      );

      expect(methods?.getValues('instructionsPrompt')).toEqual({
        source: 'langfuse',
        groupId: 'group2',
        selection: { type: 'exact', version: 2 },
      });
    });
  });

  it('shows a loading state for the Version dropdown while revisions are loading', () => {
    mockGroupsQuery.data = [group()];
    mockRevisionsQuery.isLoading = true;
    render(
      <Harness
        defaultInstructionsPrompt={{
          source: 'native',
          groupId: 'group1',
          selection: { type: 'production' },
        }}
      />,
    );

    expect(
      screen.getByRole('group', { name: 'com_agents_instructions_prompt_version_label' }),
    ).toHaveTextContent('com_ui_loading');
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
    mockRevisionsQuery.isError = true;
    mockRevisionsQuery.error = { isAxiosError: true, response: { status: 403, data: {} } };
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
    expect(screen.queryByRole('button', { name: 'com_ui_retry' })).not.toBeInTheDocument();
  });

  it('keeps the saved selection and shows Retry on a revisions load error', () => {
    mockGroupsQuery.data = [group()];
    mockRevisionsQuery.isError = true;
    mockRevisionsQuery.error = new Error('network down');
    let methods: UseFormReturn<AgentForm> | undefined;
    render(
      <Harness
        defaultInstructionsPrompt={{
          source: 'native',
          groupId: 'group1',
          selection: { type: 'exact', promptId: 'p1' },
        }}
        onMethods={(m) => (methods = m)}
      />,
    );

    expect(screen.getByText('com_agents_instructions_prompt_load_error')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(mockRevisionsQuery.refetch).toHaveBeenCalledTimes(1);
    expect(methods?.getValues('instructionsPrompt')).toEqual({
      source: 'native',
      groupId: 'group1',
      selection: { type: 'exact', promptId: 'p1' },
    });
  });

  it('marks Retry aria-disabled while a revisions retry is already in flight, so a repeated click does nothing', () => {
    mockGroupsQuery.data = [group()];
    mockRevisionsQuery.isError = true;
    mockRevisionsQuery.error = new Error('network down');
    mockRevisionsQuery.isFetching = true;
    render(
      <Harness
        defaultInstructionsPrompt={{
          source: 'native',
          groupId: 'group1',
          selection: { type: 'exact', promptId: 'p1' },
        }}
      />,
    );

    const retryButton = screen.getByRole('button', { name: 'com_ui_retry' });
    expect(retryButton).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(retryButton);
    expect(mockRevisionsQuery.refetch).not.toHaveBeenCalled();
  });

  it('shows the source-unavailable copy for a Langfuse chat-prompt rejection (422)', () => {
    mockLangfuseEnabled = true;
    mockGroupsQuery.data = [group({ _id: 'group2', source: 'langfuse' })];
    mockRevisionsQuery.isError = true;
    mockRevisionsQuery.error = {
      isAxiosError: true,
      response: { status: 422, data: { code: 'unsupported_type' } },
    };
    render(
      <Harness
        defaultInstructionsPrompt={{
          source: 'langfuse',
          groupId: 'group2',
          selection: { type: 'production' },
        }}
      />,
    );

    expect(
      screen.getByText('com_agents_instructions_prompt_source_unavailable'),
    ).toBeInTheDocument();
  });

  it('guards a malformed 200 revisions response as a load failure, not a crash', () => {
    mockGroupsQuery.data = [group()];
    mockRevisionsQuery.data = { message: 'not allowed' };
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
      mockRevisionsQuery.data = nativeRevisions([
        { promptId: 'p2', version: 2 },
        { promptId: 'p1', version: 1 },
      ]);
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
      mockRevisionsQuery.data = nativeRevisions([{ promptId: 'p1', version: 1 }]);
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

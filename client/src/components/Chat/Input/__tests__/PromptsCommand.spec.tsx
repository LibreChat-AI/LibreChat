/**
 * Locks in the `/` prompts popover keyboard contract, specifically the
 * empty-result edge case that mirrors the `$` skills command and the `@`
 * mention popover: when filtering yields zero matches the arrow keys must
 * be no-ops (never `% 0` into a `NaN` active index) and Enter/Tab must
 * close the popover and return focus to the textarea. Deleting back to a
 * non-empty list has to leave keyboard navigation working.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { PromptOption } from '~/common';

const PLACEHOLDER = 'com_ui_command_usage_placeholder';

const mockSetShowPromptsPopover = jest.fn();
const mockShowPromptsPopover = { current: true };
const mockRequestAllPromptGroups = jest.fn();

jest.mock('recoil', () => {
  const actual = jest.requireActual('recoil');
  return {
    ...actual,
    useRecoilValue: jest.fn((atom: unknown) =>
      atom === 'show-prompts-popover' ? mockShowPromptsPopover.current : undefined,
    ),
    useSetRecoilState: jest.fn((atom: unknown) =>
      atom === 'show-prompts-popover' ? mockSetShowPromptsPopover : jest.fn(),
    ),
  };
});

jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    showPromptsPopoverFamily: () => 'show-prompts-popover',
  },
}));

const mockRecordUsage = jest.fn();
jest.mock('~/data-provider', () => ({
  useRecordPromptUsage: () => ({ mutate: mockRecordUsage }),
}));

const mockPromptGroupsContext = jest.fn();
jest.mock('~/Providers', () => ({
  usePromptGroupsContext: () => mockPromptGroupsContext(),
}));

jest.mock('~/components/Prompts', () => ({
  VariableDialog: () => null,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  activateCatalog: jest.fn(),
}));

/* react-virtualized renders nothing in jsdom without a measured size; replace
   AutoSizer + List with a flat ul so every row's MentionItem button renders. */
jest.mock('react-virtualized', () => ({
  ...jest.requireActual('react-virtualized'),
  AutoSizer: ({ children }: { children: (size: { width: number }) => React.ReactNode }) =>
    children({ width: 320 }),
  List: ({
    rowCount,
    rowRenderer,
  }: {
    rowCount: number;
    rowRenderer: (args: {
      index: number;
      key: string;
      style: React.CSSProperties;
    }) => React.ReactNode;
  }) => {
    const rows: React.ReactNode[] = [];
    for (let i = 0; i < rowCount; i++) {
      rows.push(rowRenderer({ index: i, key: `row-${i}`, style: {} }));
    }
    return <ul data-testid="prompts-list">{rows}</ul>;
  },
}));

import PromptsCommand from '../PromptsCommand';

const makeTextarea = (initial = '/') => {
  const textarea = document.createElement('textarea');
  textarea.value = initial;
  document.body.appendChild(textarea);
  return { current: textarea } as React.MutableRefObject<HTMLTextAreaElement | null>;
};

const makePrompt = (overrides: Partial<PromptOption>): PromptOption => ({
  id: '1',
  type: 'prompt',
  label: 'Alpha',
  value: 'Alpha',
  description: '',
  ...overrides,
});

const promptGroups: PromptOption[] = [
  makePrompt({ id: '1', label: 'Alpha', value: 'Alpha' }),
  makePrompt({ id: '2', label: 'Beta', value: 'Beta' }),
];

const promptsMap = {
  '1': { _id: '1', productionPrompt: { prompt: 'Alpha body' } },
  '2': { _id: '2', productionPrompt: { prompt: 'Beta body' } },
};

const activeItemId = () =>
  document.querySelector('.bg-surface-active')?.closest('button')?.id ?? null;

const getInput = () => screen.getByPlaceholderText(PLACEHOLDER);

beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
});

beforeEach(() => {
  jest.clearAllMocks();
  document.body.innerHTML = '';
  mockShowPromptsPopover.current = true;
  mockPromptGroupsContext.mockReturnValue({
    hasAccess: true,
    allPromptGroups: {
      data: { promptGroups, promptsMap },
      isLoading: false,
    },
    requestAllPromptGroups: mockRequestAllPromptGroups,
  });
});

const renderCommand = () => {
  const textAreaRef = makeTextarea('/');
  const utils = render(
    <PromptsCommand index={0} textAreaRef={textAreaRef} submitPrompt={jest.fn()} />,
  );
  return { textAreaRef, ...utils };
};

describe('PromptsCommand keyboard navigation', () => {
  it('renders nothing when the popover atom is false', () => {
    mockShowPromptsPopover.current = false;
    const { container } = renderCommand();
    expect(container).toBeEmptyDOMElement();
  });
  it('moves the active highlight with ArrowDown/ArrowUp and wraps around', () => {
    renderCommand();
    const input = getInput();

    expect(activeItemId()).toBe('prompt-item-0');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeItemId()).toBe('prompt-item-1');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeItemId()).toBe('prompt-item-0');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(activeItemId()).toBe('prompt-item-1');
  });

  it('keeps navigation working after filtering to zero matches and back', () => {
    renderCommand();
    const input = getInput();

    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(screen.queryByRole('button')).toBeNull();

    /* Arrow keys on an empty list must be no-ops, not `% 0` -> NaN. */
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });

    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getAllByRole('button')).toHaveLength(2);

    /* Without the guard the active index would still be NaN here and no
       item would highlight; with it, navigation resumes from a valid index. */
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeItemId()).toBe('prompt-item-1');
  });

  it('closes the popover and refocuses the textarea when Enter is pressed with no matches', () => {
    const { textAreaRef } = renderCommand();
    const input = getInput();

    fireEvent.change(input, { target: { value: 'zzz' } });
    const notPrevented = fireEvent.keyDown(input, { key: 'Enter' });

    expect(notPrevented).toBe(false);
    expect(mockSetShowPromptsPopover).toHaveBeenCalledWith(false);
    expect(document.activeElement).toBe(textAreaRef.current);
  });

  it('prevents the default Tab action when closing on no matches so the refocus sticks', () => {
    const { textAreaRef } = renderCommand();
    const input = getInput();

    fireEvent.change(input, { target: { value: 'zzz' } });
    const notPrevented = fireEvent.keyDown(input, { key: 'Tab' });

    /* Without preventDefault the browser's default Tab would move focus off
       the textarea right after we refocus it. */
    expect(notPrevented).toBe(false);
    expect(mockSetShowPromptsPopover).toHaveBeenCalledWith(false);
    expect(document.activeElement).toBe(textAreaRef.current);
  });

  it('clears the stale search filter when the popover closes', () => {
    renderCommand();
    const input = getInput();

    fireEvent.change(input, { target: { value: 'zzz' } });
    expect((input as HTMLInputElement).value).toBe('zzz');

    /* PromptsCommand stays mounted across close (unlike Mention), so a leftover
       no-match query has to be cleared or the popover reopens still filtered. */
    fireEvent.keyDown(input, { key: 'Enter' });
    expect((getInput() as HTMLInputElement).value).toBe('');
  });
});

describe('PromptsCommand lazy prompt loading', () => {
  it('requests the full prompt list when the popover is shown', () => {
    mockShowPromptsPopover.current = true;
    renderCommand();
    expect(mockRequestAllPromptGroups).toHaveBeenCalledTimes(1);
  });

  it('does not request the full prompt list while the popover is hidden', () => {
    mockShowPromptsPopover.current = false;
    renderCommand();
    expect(mockRequestAllPromptGroups).not.toHaveBeenCalled();
  });
});

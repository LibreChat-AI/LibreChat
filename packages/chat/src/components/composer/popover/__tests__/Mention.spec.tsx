/**
 * @jest-environment jsdom
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { CommandListProps, ComposerHost } from '../../../../react/input';
import type { MentionPopoverProps } from '../Mention';
import type { CommandOption } from '../Command';
import { ComposerHostProvider } from '../../../../react/input';
import { NO_HOST_BINDINGS } from '../../../../core/shortcuts';
import MentionPopover from '../Mention';

/**
 * The `@` popover's keyboard contract, exercised through the plain list a host without a windowed
 * list gets: the input is a combobox pointing at the active option, arrows wrap and are no-ops on
 * an empty list (issue #13929), Enter and Tab on no matches close and refocus the textarea, and
 * endpoints drill into their models instead of selecting.
 */

const PLACEHOLDER = 'Mention a model';

const makeTextarea = (initial = '@') => {
  const textarea = document.createElement('textarea');
  textarea.value = initial;
  document.body.appendChild(textarea);
  return { current: textarea } as React.MutableRefObject<HTMLTextAreaElement | null>;
};

const option = (overrides: Partial<CommandOption>): CommandOption => ({
  type: 'preset',
  label: 'Alpha',
  value: 'alpha',
  description: '',
  ...overrides,
});

const options: CommandOption[] = [
  option({ label: 'Alpha', value: 'alpha' }),
  option({ label: 'Beta', value: 'beta' }),
];

const scrollIntoView = jest.fn();
const lastScrolled = () => scrollIntoView.mock.contexts[scrollIntoView.mock.contexts.length - 1];

beforeAll(() => {
  Element.prototype.scrollIntoView = scrollIntoView;
});

beforeEach(() => {
  document.body.innerHTML = '';
  scrollIntoView.mockClear();
});

const renderMention = (props: Partial<MentionPopoverProps> = {}, host?: ComposerHost) => {
  const textAreaRef = makeTextarea('@');
  const onClose = jest.fn();
  const onSelectMention = jest.fn();
  const ui = (
    <MentionPopover
      textAreaRef={textAreaRef}
      placeholder={PLACEHOLDER}
      options={options}
      isLoading={false}
      assistantListMap={{}}
      onClose={onClose}
      onSelectMention={onSelectMention}
      {...props}
    />
  );
  const utils = render(host ? <ComposerHostProvider host={host}>{ui}</ComposerHostProvider> : ui);
  return { textAreaRef, onClose, onSelectMention, ...utils };
};

const input = () => screen.getByRole('combobox');
const activeId = () => input().getAttribute('aria-activedescendant');

describe('MentionPopover through the plain list', () => {
  it('keeps an empty picker open while keyboard focus moves to a retry action', () => {
    jest.useFakeTimers();
    try {
      const { onClose, onSelectMention } = renderMention({
        options: [],
        notice: <button type="button">Retry</button>,
      });
      expect(fireEvent.keyDown(input(), { key: 'Tab' })).toBe(true);
      act(() => screen.getByRole('button', { name: 'Retry' }).focus());
      act(() => jest.advanceTimersByTime(200));
      expect(onClose).not.toHaveBeenCalled();
      expect(onSelectMention).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not remove unrelated text if the draft changes while the picker is open', () => {
    const textAreaRef = makeTextarea('Find @ later');
    renderMention({ textAreaRef, commandRange: { start: 5, end: 6 } });
    if (textAreaRef.current) {
      textAreaRef.current.value = 'A different draft';
    }
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(textAreaRef.current).toHaveValue('A different draft');
  });

  it('adds results arriving after the picker opens', () => {
    const { rerender } = renderMention({ options: [] });
    expect(screen.queryByRole('option')).toBeNull();
    rerender(
      <MentionPopover
        textAreaRef={makeTextarea()}
        placeholder={PLACEHOLDER}
        options={options}
        isLoading={false}
        assistantListMap={{}}
        onClose={jest.fn()}
        onSelectMention={jest.fn()}
      />,
    );
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });

  it.each(['Enter', 'Tab', 'click'])(
    'preserves the surrounding draft on an inline %s pick',
    (key) => {
      const textAreaRef = makeTextarea('Find @git later');
      textAreaRef.current?.setSelectionRange(9, 9);
      const onInput = jest.fn();
      textAreaRef.current?.addEventListener('input', onInput);
      const { onSelectMention } = renderMention({
        textAreaRef,
        commandRange: { start: 5, end: 9 },
        options: [option({ type: 'mcp', label: 'GitHub', value: 'github' })],
      });
      expect(input()).toHaveValue('git');
      expect(textAreaRef.current).toHaveValue('Find @git later');
      if (key === 'click') {
        fireEvent.click(screen.getByRole('option'));
      } else {
        fireEvent.keyDown(input(), { key });
      }
      expect(onSelectMention).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'mcp', value: 'github' }),
      );
      expect(textAreaRef.current).toHaveValue('Find  later');
      expect(textAreaRef.current?.selectionStart).toBe(5);
      expect(textAreaRef.current).toHaveFocus();
      expect(onInput).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['Escape', 'Backspace', 'Enter'])('keeps the original draft on %s dismissal', (key) => {
    const textAreaRef = makeTextarea('Find @ later');
    textAreaRef.current?.setSelectionRange(6, 6);
    const { onSelectMention } = renderMention({
      textAreaRef,
      commandRange: { start: 5, end: 6 },
      options: [],
    });
    fireEvent.keyDown(input(), { key });
    expect(textAreaRef.current).toHaveValue('Find @ later');
    expect(onSelectMention).not.toHaveBeenCalled();
  });

  it('does not steal focus from a configuration dialog opened by selection', () => {
    const dialogInput = document.createElement('input');
    document.body.appendChild(dialogInput);
    renderMention({ onSelectMention: () => dialogInput.focus() });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(dialogInput).toHaveFocus();
  });

  it('exposes the input as a combobox controlling a listbox of options', () => {
    renderMention();

    const listbox = screen.getByRole('listbox', { name: PLACEHOLDER });
    expect(input()).toHaveAttribute('aria-controls', listbox.id);
    expect(input()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(activeId()).toBe('mention-item-0');
    expect(document.getElementById('mention-item-0')).toHaveAttribute('aria-selected', 'true');
    expect(document.getElementById('mention-item-1')).toHaveAttribute('aria-selected', 'false');
  });

  it('moves the active option with ArrowDown/ArrowUp, wraps, and scrolls it into view', () => {
    renderMention();

    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(activeId()).toBe('mention-item-1');
    expect(document.getElementById('mention-item-1')).toHaveAttribute('aria-selected', 'true');
    expect(lastScrolled()).toBe(document.getElementById('mention-item-1'));

    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(activeId()).toBe('mention-item-0');

    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(activeId()).toBe('mention-item-1');
    expect(lastScrolled()).toBe(document.getElementById('mention-item-1'));
  });

  it('keeps navigation working after filtering to zero matches and back', () => {
    renderMention();

    fireEvent.change(input(), { target: { value: 'zzz' } });
    expect(screen.queryByRole('option')).toBeNull();
    expect(input()).toHaveAttribute('aria-expanded', 'false');
    expect(input()).not.toHaveAttribute('aria-activedescendant');

    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'ArrowUp' });

    fireEvent.change(input(), { target: { value: '' } });
    expect(screen.getAllByRole('option')).toHaveLength(2);

    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(activeId()).toBe('mention-item-1');
  });

  it.each(['Enter', 'Tab'])(
    'closes and refocuses the textarea when %s is pressed with no matches',
    (key) => {
      const { textAreaRef, onClose } = renderMention();

      fireEvent.change(input(), { target: { value: 'zzz' } });
      const notPrevented = fireEvent.keyDown(input(), { key });

      expect(notPrevented).toBe(false);
      expect(onClose).toHaveBeenCalled();
      expect(document.activeElement).toBe(textAreaRef.current);
    },
  );

  it('closes on Escape and returns focus to the textarea', () => {
    const { textAreaRef, onClose } = renderMention();

    fireEvent.keyDown(input(), { key: 'Escape' });

    expect(onClose).toHaveBeenCalled();
    expect(document.activeElement).toBe(textAreaRef.current);
  });

  it('selects the active option on Enter', () => {
    const { onClose, onSelectMention } = renderMention();

    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    const notPrevented = fireEvent.keyDown(input(), { key: 'Enter' });

    expect(notPrevented).toBe(false);
    expect(onSelectMention).toHaveBeenCalledWith(options[1]);
    expect(onClose).toHaveBeenCalled();
  });

  it('drills an endpoint into its models instead of selecting it', () => {
    const { onSelectMention, onClose } = renderMention({
      options: [option({ type: 'endpoint', label: 'OpenAI', value: 'openAI' })],
      modelsConfig: { openAI: ['gpt-a', 'gpt-b'] },
    });

    fireEvent.keyDown(input(), { key: 'Tab' });

    expect(onSelectMention).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getAllByRole('option').map((el) => el.textContent)).toEqual(['gpt-a', 'gpt-b']);
    expect(activeId()).toBe('mention-item-0');

    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onSelectMention).toHaveBeenCalledWith({
      type: 'model',
      value: 'openAI',
      label: 'gpt-a',
    });
  });

  it('closes once focus leaves the input, without pulling focus back', () => {
    jest.useFakeTimers();
    try {
      const { onClose, textAreaRef } = renderMention();

      fireEvent.blur(input());
      expect(onClose).not.toHaveBeenCalled();
      act(() => {
        jest.advanceTimersByTime(150);
      });

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(document.activeElement).not.toBe(textAreaRef.current);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the popover open when a click on an option follows the blur', () => {
    jest.useFakeTimers();
    try {
      const { onClose } = renderMention({
        options: [option({ type: 'endpoint', label: 'OpenAI', value: 'openAI' })],
        modelsConfig: { openAI: ['gpt-a'] },
      });

      fireEvent.blur(input());
      fireEvent.click(document.getElementById('mention-item-0') as HTMLElement);
      act(() => {
        jest.runAllTimers();
      });

      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole('option')).toHaveTextContent('gpt-a');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('MentionPopover through a host list', () => {
  it('skips group headings and maps active options to their windowed rows', () => {
    const renderCommandList = jest.fn(({ count, renderRow }: CommandListProps) => (
      <>
        {Array.from({ length: count }, (_, index) =>
          renderRow({ index, key: `${index}`, style: {} }),
        )}
      </>
    ));
    const { onSelectMention } = renderMention(
      {
        options: [
          option({}),
          option({
            type: 'mcp',
            label: 'GitHub',
            value: 'github',
            group: 'MCP Servers',
            selected: true,
          }),
          option({
            type: 'mcp',
            label: 'GitLab',
            value: 'gitlab',
            group: 'MCP Servers',
            selected: false,
          }),
        ],
      },
      {
        useComposerBindings: () => NO_HOST_BINDINGS,
        useShortcutDisplay: () => '',
        useShortcutAriaKey: () => undefined,
        renderCommandList,
      },
    );
    expect(screen.getByText('MCP Servers')).toBeVisible();
    expect(screen.getAllByRole('option')).toHaveLength(3);
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(activeId()).toBe('mention-item-1');
    expect(renderCommandList).toHaveBeenLastCalledWith(
      expect.objectContaining({ count: 4, activeIndex: 2 }),
    );
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onSelectMention).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mcp', value: 'github' }),
    );
  });
  it('renders its rows through the host windowed list', () => {
    const renderCommandList = jest.fn(({ count, renderRow }: CommandListProps) => (
      <div data-testid="host-list">
        {Array.from({ length: count }, (_, index) =>
          renderRow({ index, key: `${index}`, style: { height: 44 } }),
        )}
      </div>
    ));
    const host: ComposerHost = {
      useComposerBindings: () => NO_HOST_BINDINGS,
      useShortcutDisplay: () => '',
      useShortcutAriaKey: () => undefined,
      renderCommandList,
    };
    renderMention({}, host);

    expect(renderCommandList).toHaveBeenLastCalledWith(
      expect.objectContaining({ count: 2, activeIndex: 0 }),
    );
    expect(screen.getByTestId('host-list')).toBeInTheDocument();
    expect(screen.getByRole('listbox')).toContainElement(screen.getByTestId('host-list'));

    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(renderCommandList).toHaveBeenLastCalledWith(
      expect.objectContaining({ count: 2, activeIndex: 1 }),
    );
    expect(activeId()).toBe('mention-item-1');
  });
});

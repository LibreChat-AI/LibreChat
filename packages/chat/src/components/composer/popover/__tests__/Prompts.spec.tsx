/**
 * @jest-environment jsdom
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { PromptsPopoverProps } from '../Prompts';
import type { CommandOption } from '../Command';
import PromptsPopover from '../Prompts';

/**
 * The `/` popover's contract with its host: a pick closes the popover, drops the `/` from the
 * draft and hands the prompt over; Enter never submits the form behind it, while Tab's default is
 * left to the host, which keeps focus only when a dialog follows.
 */

type Prompt = CommandOption & { id: string };

const prompts: Prompt[] = [
  { id: 'g1', type: 'prompt', value: 'summarize', label: 'summarize' },
  { id: 'g2', type: 'prompt', value: 'translate', label: 'translate' },
];

beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
});

beforeEach(() => {
  document.body.innerHTML = '';
});

const renderPrompts = (props: Partial<PromptsPopoverProps<Prompt>> = {}) => {
  const textarea = document.createElement('textarea');
  textarea.value = '/';
  document.body.appendChild(textarea);
  const textAreaRef = { current: textarea };
  const onClose = jest.fn();
  const onSelectPrompt = jest.fn();
  const onOpenChange = jest.fn();
  render(
    <PromptsPopover
      textAreaRef={textAreaRef}
      placeholder="Prompts"
      prompts={prompts}
      isLoading={false}
      onClose={onClose}
      onSelectPrompt={onSelectPrompt}
      onOpenChange={onOpenChange}
      {...props}
    />,
  );
  return { textarea, onClose, onSelectPrompt, onOpenChange };
};

const input = () => screen.getByRole('combobox');

describe('PromptsPopover', () => {
  it('reports opening to the host and lists the prompts as options', () => {
    const { onOpenChange } = renderPrompts();

    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole('listbox', { name: 'Prompts' })).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(input()).toHaveAttribute('aria-activedescendant', 'prompt-item-0');
  });

  it('keeps the text typed after the slash as the search when it opens', () => {
    const textarea = document.createElement('textarea');
    textarea.value = '/tra';
    document.body.appendChild(textarea);
    render(
      <PromptsPopover
        textAreaRef={{ current: textarea }}
        placeholder="Prompts"
        prompts={prompts}
        isLoading={false}
        onClose={jest.fn()}
        onSelectPrompt={jest.fn()}
      />,
    );

    expect(input()).toHaveValue('tra');
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'translate',
    ]);
    expect(textarea.value).toBe('');
  });

  it('hands an Enter pick to the host after closing, without submitting the form', () => {
    const { onClose, onSelectPrompt, textarea } = renderPrompts();
    textarea.value = 'draft /';

    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    const notPrevented = fireEvent.keyDown(input(), { key: 'Enter' });

    expect(notPrevented).toBe(false);
    expect(onClose).toHaveBeenCalled();
    expect(onSelectPrompt).toHaveBeenCalledWith(
      prompts[1],
      expect.objectContaining({ key: 'Enter' }),
    );
    expect(textarea.value).toBe('draft ');
  });

  it("leaves Tab's default to the host", () => {
    const keepsFocus = jest.fn((_prompt: Prompt, event?: React.KeyboardEvent) =>
      event?.preventDefault(),
    );
    renderPrompts({ onSelectPrompt: keepsFocus });
    const { onSelectPrompt: movesOn } = renderPrompts();

    const [first, second] = screen.getAllByRole('combobox');
    expect(fireEvent.keyDown(first, { key: 'Tab' })).toBe(false);
    expect(keepsFocus).toHaveBeenCalledWith(prompts[0], expect.anything());
    expect(fireEvent.keyDown(second, { key: 'Tab' })).toBe(true);
    expect(movesOn).toHaveBeenCalledWith(prompts[0], expect.anything());
  });

  it('closes and refocuses the draft on Enter with no matches', () => {
    const { onClose, onSelectPrompt, textarea } = renderPrompts();

    fireEvent.change(input(), { target: { value: 'zzz' } });
    expect(fireEvent.keyDown(input(), { key: 'Enter' })).toBe(false);

    expect(onClose).toHaveBeenCalled();
    expect(onSelectPrompt).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(textarea);
  });
});

import React from 'react';
import { render, screen } from '@testing-library/react';
import { ReasoningCompact } from '../Reasoning';
import { ROW_GLYPH_SLOT } from '../../rows';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useExpandCollapse: (isExpanded: boolean) => ({
    style: { display: 'grid', gridTemplateRows: isExpanded ? '1fr' : '0fr' },
    ref: { current: null },
  }),
  useLazyCollapseBody: (isExpanded: boolean) => ({
    shouldRenderBody: isExpanded,
    mountBody: jest.fn(),
    handleTransitionEnd: jest.fn(),
  }),
}));

jest.mock('../Thinking', () => ({
  ThinkingContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  ThinkingButton: () => <button type="button">{'thinking'}</button>,
  FloatingThinkingBar: () => null,
  useInViewport: () => ({ ref: { current: null }, inViewport: true }),
}));

jest.mock('~/components/Messages/Content/CopyButton', () => ({
  __esModule: true,
  default: () => <button type="button">{'copy'}</button>,
}));

jest.mock('lucide-react', () => ({
  Lightbulb: () => <span data-testid="thoughts-icon" />,
  ChevronDown: ({ className }: { className?: string }) => (
    <span data-testid="thoughts-chevron" className={className} />
  ),
}));

describe('ReasoningCompact', () => {
  it('reveals its own Thoughts chevron instantly on row hover or focus', () => {
    render(<ReasoningCompact reasoning="A useful thought" label="Thoughts" showThinking={false} />);

    const button = screen.getByRole('button', { name: 'Thoughts' });
    const chevron = screen.getByTestId('thoughts-chevron');
    const row = button.closest('.group\\/reasoning-compact');

    expect(row).toHaveClass('mb-1', 'mt-1');
    expect(button.parentElement).not.toHaveClass('my-1.5');
    expect(button).toHaveClass('group/disclosure');
    expect(chevron).toHaveClass(
      'opacity-0',
      'group-hover/disclosure:opacity-100',
      'group-focus-within/disclosure:opacity-100',
    );
    expect(chevron).toHaveClass('transition-transform');
    expect(chevron.className).not.toContain('transition-opacity');
  });

  it('takes the shared glyph slot so it lands on the row rail', () => {
    /** Every other row under a message header centers its glyph in the 24px
     *  slot, including the `ThinkingLabel` marker that stands in for this
     *  exact row when a projection has no text. Bare, the bulb sat on the
     *  pre-rail axis and the label 8px left of its neighbours. */
    render(<ReasoningCompact reasoning="A useful thought" label="Thoughts" showThinking={false} />);

    const slot = screen.getByTestId('thoughts-icon').parentElement;
    for (const token of ROW_GLYPH_SLOT.split(' ')) {
      expect(slot).toHaveClass(token);
    }
    /** 24px slot plus the row's 8px gap is what puts the label where the
     *  header's name starts. */
    expect(screen.getByRole('button', { name: 'Thoughts' })).toHaveClass('gap-2');
  });

  it('removes the extra top margin when Thoughts follows a tool', () => {
    render(
      <ReasoningCompact
        reasoning="A useful thought"
        label="Thoughts"
        isAfterTool
        showThinking={false}
      />,
    );

    const row = screen
      .getByRole('button', { name: 'Thoughts' })
      .closest('.group\\/reasoning-compact');

    expect(row).toHaveClass('mb-1', 'mt-0');
    expect(row).not.toHaveClass('mt-1');
  });

  it('leaves the full reasoning text unmounted while collapsed', () => {
    /** Collapsed is the default whenever thoughts are hidden, and a streaming
     *  THINK part re-renders on every delta, so keeping the whole text mounted
     *  behind the invisible panel cost layout work for nothing. */
    render(
      <ReasoningCompact
        reasoning="A long stream of reasoning"
        label="Thoughts"
        showThinking={false}
      />,
    );

    expect(screen.getByRole('button', { name: 'Thoughts' })).toBeInTheDocument();
    expect(screen.queryByText('A long stream of reasoning')).not.toBeInTheDocument();
  });

  it('opens from the host preference rather than the app store', () => {
    render(
      <ReasoningCompact
        reasoning="A long stream of reasoning"
        label="Thoughts"
        showThinking={true}
      />,
    );

    expect(screen.getByText('A long stream of reasoning')).toBeInTheDocument();
  });
});

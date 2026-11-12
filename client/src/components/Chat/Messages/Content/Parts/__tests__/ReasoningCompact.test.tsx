import React from 'react';
import { render, screen } from '@testing-library/react';
import { ROW_GLYPH_SLOT } from '@librechat/chat/components';
import { ReasoningCompact } from '../Reasoning';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('@librechat/chat/components', () => ({
  ...jest.requireActual('@librechat/chat/components'),
  CopyButton: () => <button type="button">{'copy'}</button>,
  useExpandCollapse: (isExpanded: boolean) => ({
    style: { display: 'grid', gridTemplateRows: isExpanded ? '1fr' : '0fr' },
    ref: { current: null },
  }),
}));

jest.mock('@librechat/chat/react', () => ({
  ...jest.requireActual('@librechat/chat/react'),
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

jest.mock('lucide-react', () => ({
  Lightbulb: () => <span data-testid="thoughts-icon" />,
  ChevronDown: ({ className }: { className?: string }) => (
    <span data-testid="thoughts-chevron" className={className} />
  ),
}));

describe('ReasoningCompact', () => {
  it('always shows its own Thoughts chevron', () => {
    render(<ReasoningCompact reasoning="A useful thought" label="Thoughts" showThinking={false} />);

    const button = screen.getByRole('button', { name: 'Thoughts' });
    const chevron = screen.getByTestId('thoughts-chevron');
    expect(button).toHaveClass('group/disclosure');
    expect(chevron).not.toHaveClass('opacity-0');
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

  it('spaces its header like a tool row', () => {
    render(<ReasoningCompact reasoning="A useful thought" label="Thoughts" showThinking={false} />);

    const header = screen.getByRole('button', { name: 'Thoughts' }).parentElement;
    expect(header).toHaveClass('my-1.5', 'h-5');
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

  it('shows only the readable text of reasoning mixed with an encrypted payload', () => {
    const encoded = Buffer.from(Array.from({ length: 900 }, (_, i) => (i * 37 + 3) % 256)).toString(
      'base64',
    );
    render(
      <ReasoningCompact
        reasoning={`Checking the manifest.\n${encoded}\nRolling back.`}
        label="Thoughts"
        showThinking
      />,
    );

    const body = screen.getByRole('group', { hidden: true });
    expect(body).toHaveTextContent('Checking the manifest.');
    expect(body).toHaveTextContent('Rolling back.');
    expect(body.textContent).not.toContain(encoded.slice(0, 64));
  });

  it('holds back a streaming run until it is classified as a word or a payload', () => {
    const prefix = Buffer.from(Array.from({ length: 75 }, (_, i) => (i * 37 + 3) % 256)).toString(
      'base64',
    );
    render(
      <ReasoningCompact
        reasoning={`Checking the manifest. ${prefix}`}
        label="Thinking"
        showThinking
        isStreaming
      />,
    );

    const body = screen.getByRole('group', { hidden: true });
    expect(body).toHaveTextContent('Checking the manifest.');
    expect(body.textContent).not.toContain(prefix.slice(0, 32));
  });
});

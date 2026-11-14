/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { ReactNode } from 'react';
import { createMessagePartsHost } from '../../../__fixtures__/partsHost';
import { MessagePartsHostProvider } from '../../../react/host';
import { ReasoningCompact } from '../Reasoning';
import { ROW_GLYPH_SLOT } from '../rows';

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLocalize: () => (key: string) => key,
}));

jest.mock('lucide-react', () => ({
  Lightbulb: () => <span data-testid="thoughts-icon" />,
  ChevronDown: ({ className }: { className?: string }) => (
    <span data-testid="thoughts-chevron" className={className} />
  ),
}));

function renderCompact(node: ReactNode) {
  return render(
    <MessagePartsHostProvider host={createMessagePartsHost()}>{node}</MessagePartsHostProvider>,
  );
}

describe('ReasoningCompact', () => {
  it('always shows its own Thoughts chevron', () => {
    renderCompact(
      <ReasoningCompact reasoning="A useful thought" label="Thoughts" showThinking={false} />,
    );

    const button = screen.getByRole('button', { name: 'Thoughts' });
    const chevron = screen.getByTestId('thoughts-chevron');
    expect(button).toHaveClass('group/disclosure');
    expect(chevron).not.toHaveClass('opacity-0');
    expect(chevron).toHaveClass('transition-transform');
    expect(chevron.className).not.toContain('transition-opacity');
  });

  it('takes the shared glyph slot so it lands on the row rail', () => {
    renderCompact(
      <ReasoningCompact reasoning="A useful thought" label="Thoughts" showThinking={false} />,
    );

    const slot = screen.getByTestId('thoughts-icon').parentElement;
    for (const token of ROW_GLYPH_SLOT.split(' ')) {
      expect(slot).toHaveClass(token);
    }
    expect(screen.getByRole('button', { name: 'Thoughts' })).toHaveClass('gap-2');
  });

  it('spaces its header like a tool row', () => {
    renderCompact(
      <ReasoningCompact reasoning="A useful thought" label="Thoughts" showThinking={false} />,
    );

    const header = screen.getByRole('button', { name: 'Thoughts' }).parentElement;
    expect(header).toHaveClass('my-1.5', 'h-5');
  });

  it('leaves the full reasoning text unmounted while collapsed', () => {
    renderCompact(
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
    renderCompact(
      <ReasoningCompact reasoning="A long stream of reasoning" label="Thoughts" showThinking />,
    );

    expect(screen.getByText('A long stream of reasoning')).toBeInTheDocument();
  });

  it('shows only the readable text of reasoning mixed with an encrypted payload', () => {
    const encoded = Buffer.from(Array.from({ length: 900 }, (_, i) => (i * 37 + 3) % 256)).toString(
      'base64',
    );
    renderCompact(
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
    renderCompact(
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

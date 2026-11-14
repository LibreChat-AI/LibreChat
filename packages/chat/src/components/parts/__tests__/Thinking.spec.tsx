/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ThinkingButton, ThinkingContent, ThinkingLabel } from '../Thinking';
import { createMessagePartsHost } from '../../../__fixtures__/partsHost';
import { MessagePartsHostProvider } from '../../../react/host';

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLocalize: () => (key: string) => key,
}));

/** Every activity row is set at `tool-status-text`. A reasoning header sized to the reader's
 *  body text was the one row that grew with that setting. */
describe('reasoning header rows', () => {
  it('sets the thinking disclosure at the shared row scale, not the body size', () => {
    render(
      <ThinkingButton
        isExpanded={false}
        onClick={() => undefined}
        label="Reframing the analysis"
        contentId="thoughts"
      />,
    );
    const button = screen.getByRole('button', { name: 'Reframing the analysis' });
    expect(button).toHaveClass('tool-status-text');
    expect(button).not.toHaveClass('text-xl');
    expect(screen.getByText('Reframing the analysis')).toHaveClass('font-medium');
  });

  it('sets the non-interactive marker the same way', () => {
    render(<ThinkingLabel label="Thoughts" />);
    const label = screen.getByText('Thoughts');
    expect(label.parentElement).toHaveClass('tool-status-text');
    expect(label.parentElement).not.toHaveClass('text-xl');
    expect(label).toHaveClass('font-medium');
  });
});

describe('ThinkingContent', () => {
  it('shows plain text when the host does not animate a stream', () => {
    render(
      <MessagePartsHostProvider host={createMessagePartsHost()}>
        <ThinkingContent animate>Checking the manifest</ThinkingContent>
      </MessagePartsHostProvider>,
    );
    expect(screen.getByText('Checking the manifest')).toBeInTheDocument();
    expect(document.querySelector('[data-lc-fade]')).toBeNull();
  });

  it('hands a streaming string to the host renderer', () => {
    render(
      <MessagePartsHostProvider
        host={createMessagePartsHost({
          renderStreamingText: (text) => <span data-testid="streamed">{text}</span>,
        })}
      >
        <ThinkingContent animate>Checking the manifest</ThinkingContent>
      </MessagePartsHostProvider>,
    );
    expect(screen.getByTestId('streamed')).toHaveTextContent('Checking the manifest');
  });

  it('leaves settled text alone', () => {
    render(
      <MessagePartsHostProvider
        host={createMessagePartsHost({
          renderStreamingText: (text) => <span data-testid="streamed">{text}</span>,
        })}
      >
        <ThinkingContent>Checking the manifest</ThinkingContent>
      </MessagePartsHostProvider>,
    );
    expect(screen.queryByTestId('streamed')).not.toBeInTheDocument();
    expect(screen.getByText('Checking the manifest')).toBeInTheDocument();
  });
});

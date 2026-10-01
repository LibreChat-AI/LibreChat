import React from 'react';
import { render, screen } from '@testing-library/react';
import Summary from '../Summary';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const mockMessageContext = { current: { isSubmitting: false, isLatestMessage: false } };

jest.mock('~/Providers', () => ({
  useMessageContext: () => mockMessageContext.current,
}));

const partialSummary = [{ type: 'text', text: 'Half a summary before the error' }] as never;

describe('Summary', () => {
  beforeEach(() => {
    mockMessageContext.current = { isSubmitting: false, isLatestMessage: false };
  });

  it('does not present a failed round as a completed summary', () => {
    /** A failed summarize round keeps the deltas that already streamed in, so
     *  the only thing separating it from a success is this flag. */
    render(<Summary content={partialSummary} summarizing={false} failed />);

    expect(screen.getByText('com_ui_summarize_failed')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_conversation_summarized')).not.toBeInTheDocument();
  });

  it('labels a settled round with partial text as summarized when it did not fail', () => {
    render(<Summary content={partialSummary} summarizing={false} />);

    expect(screen.getByText('com_ui_conversation_summarized')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_summarize_failed')).not.toBeInTheDocument();
  });

  it('keeps the in-flight label while the round is still streaming', () => {
    mockMessageContext.current = { isSubmitting: true, isLatestMessage: true };
    render(<Summary content={partialSummary} summarizing />);

    expect(screen.getByText('com_ui_summarizing')).toBeInTheDocument();
  });

  it('renders nothing when a failed round produced no text at all', () => {
    const { container } = render(<Summary content={[]} summarizing={false} failed />);

    expect(container).toBeEmptyDOMElement();
  });
});

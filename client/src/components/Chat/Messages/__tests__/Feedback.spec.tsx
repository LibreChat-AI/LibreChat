import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import Feedback from '../Feedback';

const mockTranslations: Record<string, string> = {
  com_ui_feedback_rate: 'Rate response',
  com_ui_feedback_positive: 'Love this',
  com_ui_feedback_negative: 'Needs improvement',
  com_ui_feedback_tag_accurate_reliable: 'Accurate and Reliable',
  com_ui_feedback_tag_not_matched: "Didn't match my request",
  com_ui_back: 'Back',
};

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => mockTranslations[key] ?? key,
}));

describe('Feedback', () => {
  it('reveals both ratings from one control and preserves reason selection', async () => {
    const handleFeedback = jest.fn();
    render(<Feedback handleFeedback={handleFeedback} />);

    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Rate response' }));

    expect(await screen.findByRole('button', { name: 'Love this' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Needs improvement' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Love this' }));
    const firstReason = await screen.findByRole('button', { name: 'Accurate and Reliable' });
    expect(firstReason).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('button', { name: 'Love this' })).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Love this' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Accurate and Reliable' }));

    await waitFor(() =>
      expect(handleFeedback).toHaveBeenCalledWith({
        feedback: expect.objectContaining({
          rating: 'thumbsUp',
          tag: expect.objectContaining({ key: 'accurate_reliable' }),
        }),
      }),
    );
  });

  it('returns focus to the trigger when Escape closes the feedback dialog', async () => {
    render(<Feedback handleFeedback={jest.fn()} />);

    const trigger = screen.getByRole('button', { name: 'Rate response' });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('button', { name: 'Needs improvement' }));

    const firstReason = await screen.findByRole('button', { name: "Didn't match my request" });
    fireEvent.keyDown(firstReason, { key: 'Escape' });

    await waitFor(() => expect(trigger).toHaveFocus());
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Rate response' })).not.toBeInTheDocument(),
    );
  });

  it('keeps feedback open when the trigger is clicked after hover opens it', async () => {
    render(<Feedback handleFeedback={jest.fn()} />);

    const trigger = screen.getByRole('button', { name: 'Rate response' });
    fireEvent.mouseMove(trigger);
    expect(await screen.findByRole('button', { name: 'Love this' })).toBeInTheDocument();

    fireEvent.click(trigger);

    expect(screen.getByRole('button', { name: 'Love this' })).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });
});

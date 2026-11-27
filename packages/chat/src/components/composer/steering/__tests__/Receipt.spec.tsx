/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { initEnglish } from '../../../../__fixtures__/i18n';
import SteerReceipt from '../Receipt';

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  InfoHoverCard: ({ text, children }: { text: string; children: React.ReactNode }) => (
    <span aria-label={text}>{children}</span>
  ),
}));

beforeAll(initEnglish);

const receipt = () => screen.getByTestId('steer-receipt');

describe('SteerReceipt', () => {
  it('shows a plain sending label before the server accepts the steer', () => {
    render(<SteerReceipt state="sending" />);

    expect(receipt()).toHaveAttribute('data-receipt-state', 'sending');
    expect(receipt()).toHaveTextContent('Sending…');
    expect(receipt().querySelector('svg')).toBeNull();
  });

  it('marks an accepted steer as waiting, with its explanation as the label', () => {
    render(<SteerReceipt state="delivered" />);

    expect(receipt()).toHaveTextContent('Waiting to apply');
    expect(
      screen.getByLabelText(
        'Waiting to apply. Your message was accepted and will reach the agent at a safe insertion point after the current tool or reasoning step.',
      ),
    ).toBeInTheDocument();
    expect(receipt().querySelectorAll('svg')).toHaveLength(1);
  });

  it('pulses the steer dot and holds the check until an interrupt is confirmed', () => {
    const { rerender } = render(<SteerReceipt state="interrupting" confirmed={false} />);

    expect(receipt()).toHaveTextContent('Interrupt requested');
    expect(
      screen.getByLabelText(
        'Cancellation requested for active tools and reasoning. Completed output is kept, and the agent continues with your message. External effects already performed cannot be undone.',
      ),
    ).toBeInTheDocument();
    expect(receipt().querySelector('.bg-status-warning')).not.toBeNull();
    expect(receipt().querySelector('svg')).toBeNull();

    rerender(<SteerReceipt state="interrupting" confirmed />);
    expect(receipt().querySelector('svg')).toHaveClass('text-status-warning');
  });

  it('keeps the steer color on an applied receipt only while its response is live', () => {
    const { rerender } = render(<SteerReceipt state="applied" live />);

    expect(
      screen.getByLabelText('Applied. The agent received this message while it was responding.'),
    ).toBeInTheDocument();
    expect(receipt()).toHaveAttribute('data-receipt-live', 'true');
    expect(receipt().querySelector('svg')).toHaveClass('text-status-warning');

    rerender(<SteerReceipt state="applied" />);
    expect(receipt()).not.toHaveAttribute('data-receipt-live');
    expect(receipt().querySelector('svg')).toHaveClass('text-text-secondary');
  });
});

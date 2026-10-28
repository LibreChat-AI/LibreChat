/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import SendButton from '../SendButton';

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLocalize: () => (key: string) => key,
}));

const send = () => screen.getByTestId('send-button');

describe('SendButton', () => {
  it('sends text, or attachments alone, and refuses whitespace', () => {
    const { rerender } = render(<SendButton text="hello" disabled={false} />);
    expect(send()).toBeEnabled();
    expect(send()).toHaveAttribute('type', 'submit');

    rerender(<SendButton text="   " disabled={false} />);
    expect(send()).toBeDisabled();

    rerender(<SendButton text="" fileCount={1} disabled={false} />);
    expect(send()).toBeEnabled();
  });

  it('stays disabled while the host holds sending', () => {
    render(<SendButton text="hello" disabled />);
    expect(send()).toBeDisabled();
  });
});

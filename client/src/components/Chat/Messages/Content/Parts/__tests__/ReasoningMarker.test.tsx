import React from 'react';
import { render, screen } from '@testing-library/react';
import { ReasoningMarker } from '../Reasoning';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('../Thinking', () => ({
  ThinkingLabel: ({ label, title }: { label: string; title?: string }) => (
    <div data-testid="thinking-label" title={title}>
      {label}
    </div>
  ),
}));

describe('ReasoningMarker', () => {
  it('shows the generated label for reasoning this view cannot show', () => {
    render(<ReasoningMarker label="Planning the answer" />);

    const marker = screen.getByTestId('thinking-label');
    expect(marker).toHaveTextContent('Planning the answer');
    expect(marker).toHaveAttribute('title', 'com_ui_thoughts_unavailable');
  });

  it('shows a neutral encrypted state and ignores any label', () => {
    render(<ReasoningMarker encrypted label="Inspecting an encoded data snapshot" />);

    const marker = screen.getByTestId('thinking-label');
    expect(marker).toHaveTextContent('com_ui_reasoning_encrypted');
    expect(marker).toHaveAttribute('title', 'com_ui_reasoning_encrypted_description');
  });
});

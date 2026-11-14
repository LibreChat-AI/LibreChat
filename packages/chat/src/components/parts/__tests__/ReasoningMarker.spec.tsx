/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ReasoningMarker } from '../Reasoning';

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLocalize: () => (key: string) => key,
}));

describe('ReasoningMarker', () => {
  it('shows the generated label for reasoning this view cannot show', () => {
    render(<ReasoningMarker label="Planning the answer" />);

    const label = screen.getByText('Planning the answer');
    expect(label.parentElement).toHaveAttribute('title', 'com_ui_thoughts_unavailable');
  });

  it('shows a neutral encrypted state and ignores any label', () => {
    render(<ReasoningMarker encrypted label="Inspecting an encoded data snapshot" />);

    const label = screen.getByText('com_ui_reasoning_encrypted');
    expect(label.parentElement).toHaveAttribute('title', 'com_ui_reasoning_encrypted_description');
    expect(screen.queryByText('Inspecting an encoded data snapshot')).not.toBeInTheDocument();
  });
});

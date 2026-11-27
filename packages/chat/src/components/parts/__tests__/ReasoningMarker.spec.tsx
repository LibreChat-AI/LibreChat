/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { initEnglish } from '../../../__fixtures__/i18n';
import { ReasoningMarker } from '../Reasoning';

beforeAll(initEnglish);

describe('ReasoningMarker', () => {
  it('shows the generated label for reasoning this view cannot show', () => {
    render(<ReasoningMarker label="Planning the answer" />);

    const label = screen.getByText('Planning the answer');
    expect(label.parentElement).toHaveAttribute(
      'title',
      'Reasoning happened here, but background agents keep only this marker',
    );
  });

  it('shows a neutral encrypted state and ignores any label', () => {
    render(<ReasoningMarker encrypted label="Inspecting an encoded data snapshot" />);

    const label = screen.getByText('Reasoning (encrypted)');
    expect(label.parentElement).toHaveAttribute(
      'title',
      'The model returned its reasoning encrypted, so it cannot be shown',
    );
    expect(screen.queryByText('Inspecting an encoded data snapshot')).not.toBeInTheDocument();
  });
});

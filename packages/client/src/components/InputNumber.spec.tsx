import React from 'react';
import { render, screen } from '@testing-library/react';
import { InputNumber } from './InputNumber';

describe('InputNumber', () => {
  it('dims the wrapper through the nested disabled input, which is where rc-input-number puts the state', () => {
    const { container } = render(<InputNumber disabled defaultValue={1} aria-label="Amount" />);
    const wrapper = container.firstElementChild as HTMLElement;

    expect(screen.getByLabelText('Amount')).toBeDisabled();
    expect(wrapper).toHaveClass('has-[:disabled]:opacity-50', 'has-[:disabled]:cursor-not-allowed');
    expect(wrapper).not.toHaveClass('disabled:opacity-50');
  });

  it('keeps the fill recipe for a theme that paints disabled controls', () => {
    const { container } = render(<InputNumber defaultValue={1} aria-label="Amount" />);

    expect(container.firstElementChild).toHaveClass('theme-disabled-within:opacity-100');
  });
});

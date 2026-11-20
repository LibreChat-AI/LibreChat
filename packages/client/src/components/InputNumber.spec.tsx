import React from 'react';
import '@testing-library/jest-dom';
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

  /** The parts' disabled ink is a class the component adds while it is disabled, not a
   *  `:has(:disabled) *` rule: a `:has()` whose subject is every descendant makes a `disabled`
   *  flip anywhere re-style the whole subtree of every `:has()` anchor above it. */
  it('restyles its parts for a fill theme only while it is disabled, without a :has() over every descendant', () => {
    const parts = [
      'theme-disabled-fill:[&_*]:border-border-disabled',
      'theme-disabled-fill:[&_*]:text-text-disabled',
    ];
    const disabled = render(<InputNumber disabled defaultValue={1} aria-label="Off" />);
    expect(disabled.container.firstElementChild).toHaveClass(...parts);
    disabled.unmount();

    const enabled = render(<InputNumber defaultValue={1} aria-label="On" />);
    const wrapper = enabled.container.firstElementChild as HTMLElement;
    expect(wrapper).not.toHaveClass(...parts);
    expect(wrapper.className).not.toContain('theme-disabled-within:[&_*]');
  });

  it('keeps the bordered field by default', () => {
    render(<InputNumber aria-label="count" />);
    const wrapper = screen.getByRole('spinbutton').closest('.rc-input-number');

    expect(wrapper).toHaveClass('w-full', 'border');
    expect(wrapper).not.toHaveClass('reset-rc-number-input');
  });

  it('draws the option variant as a borderless value that a caller can size', () => {
    render(<InputNumber aria-label="count" variant="option" className="w-12" />);
    const wrapper = screen.getByRole('spinbutton').closest('.rc-input-number');

    expect(wrapper).toHaveClass('border-0', 'reset-rc-number-input', 'text-end', 'w-12');
    expect(wrapper).not.toHaveClass('w-full');
  });

  it('paints the option variant focus state on the wrapper of the input that takes focus, over its hover fill', () => {
    render(<InputNumber aria-label="count" variant="option" />);
    const wrapper = screen.getByRole('spinbutton').closest('.rc-input-number');

    expect(wrapper).toHaveClass('focus-within:bg-surface-secondary');
    expect(wrapper).toHaveClass('hover:not-focus-within:bg-surface-hover');
    expect(wrapper).not.toHaveClass('focus:bg-surface-secondary', 'hover:bg-surface-hover');
  });
});

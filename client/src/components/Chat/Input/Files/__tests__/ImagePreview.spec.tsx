import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import ImagePreview from '../ImagePreview';

/**
 * The expand affordance is decorative (aria-hidden), so it is asserted through the
 * opacity utilities that actually drive its visibility.
 */
const getAffordance = (container: HTMLElement) =>
  container.querySelector('[aria-hidden="true"]') as HTMLElement;

describe('ImagePreview expand affordance', () => {
  const trigger = () => screen.getByRole('button', { name: 'View Preview image in full size' });

  test('is hidden at rest', () => {
    const { container } = render(<ImagePreview url="/img.png" />);

    expect(getAffordance(container)).toHaveClass('opacity-0');
  });

  test('appears on hover', () => {
    const { container } = render(<ImagePreview url="/img.png" />);

    fireEvent.mouseEnter(trigger());

    expect(getAffordance(container)).toHaveClass('opacity-100');
  });

  test('appears on keyboard focus', () => {
    const { container } = render(<ImagePreview url="/img.png" />);

    fireEvent.focus(trigger());

    expect(getAffordance(container)).toHaveClass('opacity-100');
  });

  test('hides again on blur', () => {
    const { container } = render(<ImagePreview url="/img.png" />);

    fireEvent.focus(trigger());
    fireEvent.blur(trigger());

    expect(getAffordance(container)).toHaveClass('opacity-0');
  });

  test('stays visible while focused after the pointer leaves', () => {
    const { container } = render(<ImagePreview url="/img.png" />);

    fireEvent.focus(trigger());
    fireEvent.mouseEnter(trigger());
    fireEvent.mouseLeave(trigger());

    expect(getAffordance(container)).toHaveClass('opacity-100');
  });

  test('keeps a visible focus ring on the trigger', () => {
    render(<ImagePreview url="/img.png" />);

    expect(trigger()).toHaveClass('focus-visible:ring-2');
  });
});

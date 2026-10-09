import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { BlinkAnimation } from '../BlinkAnimation';

const CHILD_TEXT = 'logo';

const renderBlink = (active: boolean) =>
  render(
    <BlinkAnimation active={active}>
      <span>{CHILD_TEXT}</span>
    </BlinkAnimation>,
  );

describe('BlinkAnimation', () => {
  test('renders children untouched when inactive', () => {
    const { container } = renderBlink(false);

    expect(screen.getByText(CHILD_TEXT)).toBeInTheDocument();
    expect(container.querySelector('[class*="logo-blink"]')).not.toBeInTheDocument();
  });

  test('applies the blink utility when active', () => {
    const { container } = renderBlink(true);

    expect(container.querySelector('.animate-logo-blink')).toBeInTheDocument();
  });

  test('honours reduced-motion preferences', () => {
    const { container } = renderBlink(true);

    expect(container.querySelector('.motion-reduce\\:animate-none')).toBeInTheDocument();
  });

  /** A <style> tag inside the tree leaks its CSS into the ancestor's textContent. */
  test('never injects a style tag', () => {
    const { container } = renderBlink(true);

    expect(container.querySelector('style')).not.toBeInTheDocument();
    expect(container.textContent).toBe(CHILD_TEXT);
  });
});

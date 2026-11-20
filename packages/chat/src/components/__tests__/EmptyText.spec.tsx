/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { initEnglish } from '../../__fixtures__/i18n';
import EmptyText from '../EmptyText';

const dotWrapper = (container: HTMLElement) =>
  container.querySelector('.result-thinking')?.closest('div');

beforeAll(initEnglish);

describe('EmptyText', () => {
  it('names the dot for assistive technology without adding a tab stop', () => {
    render(<EmptyText />);
    const dot = screen.getByRole('img', { name: 'Thinking...' });
    expect(dot).not.toHaveAttribute('tabindex');
  });

  it('keeps the dot empty and last, which its CSS requires to draw', () => {
    const { container } = render(<EmptyText />);
    const dot = container.querySelector('.result-thinking');
    expect(dot).toBeEmptyDOMElement();
    expect(dot?.nextSibling).toBeNull();
  });

  it('keeps the dot flush with the content edge by default', () => {
    const { container } = render(<EmptyText />);
    const wrapper = dotWrapper(container);
    expect(wrapper).toHaveClass('absolute');
    expect(wrapper).not.toHaveClass('ps-1.5');
  });

  it('centers the dot on the header icon axis when it sits directly beneath one', () => {
    const { container } = render(<EmptyText underHeaderIcon />);
    const wrapper = dotWrapper(container);
    expect(wrapper).toHaveClass('absolute');
    /** Logical (inline-start) padding: the header icon sits at inline-start,
     * so the nudge must mirror with the document direction under RTL. */
    expect(wrapper).toHaveClass('ps-1.5');
  });
});

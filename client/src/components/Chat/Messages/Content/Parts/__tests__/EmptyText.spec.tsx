import React from 'react';
import { render } from '@testing-library/react';
import EmptyText from '../EmptyText';

const dotWrapper = (container: HTMLElement) =>
  container.querySelector('.result-thinking')?.closest('div');

describe('EmptyText', () => {
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
